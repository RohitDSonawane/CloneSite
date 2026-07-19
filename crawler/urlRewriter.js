const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const postcss = require('postcss');
const pino = require('pino');
const { getDiskPath } = require('./requestHandler');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

/**
 * Recursively walks a directory and gathers all file paths.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walkDirectory(dir) {
  let files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await walkDirectory(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  } catch (err) {
    // Return empty if directory doesn't exist
  }
  return files;
}

/**
 * Searches for a matching downloaded file on disk under the job storage directory.
 * @param {string} jobId
 * @param {URL} resolvedUrl
 * @returns {Promise<string|null>}
 */
async function findLocalFile(jobId, resolvedUrl) {
  const hostname = resolvedUrl.hostname;
  const candidates = [
    // Standard path without contentType assumption
    getDiskPath(jobId, resolvedUrl, null),
    // Path assuming HTML contentType
    getDiskPath(jobId, resolvedUrl, 'text/html'),
    // Path assuming CSS contentType
    getDiskPath(jobId, resolvedUrl, 'text/css')
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue checking next candidate
    }
  }
  return null;
}

/**
 * Rewrites a resolved URL string into a relative path from current directory.
 * If target file is not captured locally, returns the absolute URL as a fallback.
 * @param {string} jobId
 * @param {string} currentFileDir
 * @param {URL} resolvedUrl
 * @returns {Promise<string>}
 */
async function getRelativeOrAbsoluteUrl(jobId, currentFileDir, resolvedUrl) {
  const localFile = await findLocalFile(jobId, resolvedUrl);
  if (!localFile) {
    return resolvedUrl.toString(); // Fallback to absolute remote URL
  }
  // Calculate relative disk path
  const absoluteCurrentDir = path.resolve(currentFileDir);
  const absoluteTargetFile = path.resolve(localFile);
  let relativePath = path.relative(absoluteCurrentDir, absoluteTargetFile);
  
  // Normalize Windows separators to standard URL slashes
  return relativePath.replace(/\\/g, '/');
}

/**
 * Rewrites srcset formats (e.g. "image-1x.jpg 1x, image-2x.jpg 2x").
 * @param {string} jobId
 * @param {string} currentFileDir
 * @param {URL} baseUrl
 * @param {string} srcsetVal
 * @returns {Promise<string>}
 */
async function rewriteSrcset(jobId, currentFileDir, baseUrl, srcsetVal) {
  const parts = srcsetVal.split(',');
  const rewrittenParts = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    // Split by whitespace to extract URL and resolution descriptor
    const subParts = trimmed.split(/\s+/);
    const imgUrlStr = subParts[0];
    const descriptor = subParts.slice(1).join(' ');

    try {
      const resolvedUrl = new URL(imgUrlStr, baseUrl);
      const relativeUrl = await getRelativeOrAbsoluteUrl(jobId, currentFileDir, resolvedUrl);
      rewrittenParts.push(descriptor ? `${relativeUrl} ${descriptor}` : relativeUrl);
    } catch (err) {
      rewrittenParts.push(trimmed);
    }
  }

  return rewrittenParts.join(', ');
}

/**
 * Rewrites all links, assets, and styles within a saved HTML document.
 * @param {string} jobId
 * @param {string} filePath
 * @param {string} hostname
 * @param {string} relativeToHost
 */
async function rewriteHtmlFile(jobId, filePath, hostname, relativeToHost) {
  const fileContent = await fs.readFile(filePath, 'utf8');
  const $ = cheerio.load(fileContent);
  const currentFileDir = path.dirname(filePath);

  // Construct fake base URL to resolve relative references in attributes
  const fileUrlPathname = '/' + relativeToHost.replace(/\\/g, '/');
  const baseUrl = new URL(fileUrlPathname, `http://${hostname}`);

  // 1. Rewrite href attributes (stylesheets, pages, link tags)
  const hrefEls = $('[href]');
  for (let i = 0; i < hrefEls.length; i++) {
    const el = hrefEls[i];
    const rawVal = $(el).attr('href');
    if (!rawVal || rawVal.startsWith('#') || rawVal.startsWith('javascript:')) continue;

    try {
      const resolvedUrl = new URL(rawVal, baseUrl);
      const replacement = await getRelativeOrAbsoluteUrl(jobId, currentFileDir, resolvedUrl);
      $(el).attr('href', replacement);
    } catch (err) {
      // Ignore conversion failures for raw strings
    }
  }

  // 2. Rewrite src attributes (images, scripts, frames)
  const srcEls = $('[src]');
  for (let i = 0; i < srcEls.length; i++) {
    const el = srcEls[i];
    const rawVal = $(el).attr('src');
    if (!rawVal) continue;

    try {
      const resolvedUrl = new URL(rawVal, baseUrl);
      const replacement = await getRelativeOrAbsoluteUrl(jobId, currentFileDir, resolvedUrl);
      $(el).attr('src', replacement);
    } catch (err) {
      // Ignore
    }
  }

  // 3. Rewrite srcset attributes (responsive images)
  const srcsetEls = $('[srcset]');
  for (let i = 0; i < srcsetEls.length; i++) {
    const el = srcsetEls[i];
    const rawVal = $(el).attr('srcset');
    if (!rawVal) continue;

    const replacement = await rewriteSrcset(jobId, currentFileDir, baseUrl, rawVal);
    $(el).attr('srcset', replacement);
  }

  await fs.writeFile(filePath, $.html(), 'utf8');
}

/**
 * Rewrites all url(...) references inside CSS rules.
 * @param {string} jobId
 * @param {string} filePath
 * @param {string} hostname
 * @param {string} relativeToHost
 */
async function rewriteCssFile(jobId, filePath, hostname, relativeToHost) {
  const cssContent = await fs.readFile(filePath, 'utf8');
  const currentFileDir = path.dirname(filePath);

  const fileUrlPathname = '/' + relativeToHost.replace(/\\/g, '/');
  const baseUrl = new URL(fileUrlPathname, `http://${hostname}`);

  const urlRewritePlugin = () => {
    return {
      postcssPlugin: 'postcss-relative-urls',
      async Once(root) {
        const promises = [];
        root.walkDecls(decl => {
          if (decl.value.includes('url(')) {
            // Find all url(...) groupings
            const regex = /url\((['"]?)([^'")]+)\1\)/g;
            let match;
            while ((match = regex.exec(decl.value)) !== null) {
              const originalUrl = match[2];
              try {
                const resolvedUrl = new URL(originalUrl, baseUrl);
                const promise = getRelativeOrAbsoluteUrl(jobId, currentFileDir, resolvedUrl).then(replacement => {
                  decl.value = decl.value.replace(originalUrl, replacement);
                });
                promises.push(promise);
              } catch (err) {
                // Ignore
              }
            }
          }
        });
        await Promise.all(promises);
      }
    };
  };
  urlRewritePlugin.postcss = true;

  try {
    const result = await postcss([urlRewritePlugin()]).process(cssContent, { from: filePath, to: filePath });
    await fs.writeFile(filePath, result.css, 'utf8');
  } catch (err) {
    logger.error({ file: filePath, error: err.message }, 'Failed to parse CSS via PostCSS');
  }
}

/**
 * Executes post-crawl URL link localization on all captured assets.
 * @param {string} jobId
 */
async function rewriteJobAssets(jobId) {
  const jobWorkDir = path.join('work', jobId);
  let hostDirs = [];
  try {
    hostDirs = await fs.readdir(jobWorkDir, { withFileTypes: true });
  } catch (err) {
    logger.warn({ jobId }, 'Job directory empty, skipping url rewriter');
    return;
  }

  for (const hostDir of hostDirs) {
    if (!hostDir.isDirectory()) continue;
    const hostname = hostDir.name;
    const hostnamePath = path.join(jobWorkDir, hostname);
    const files = await walkDirectory(hostnamePath);

    for (const filePath of files) {
      const relativeToHost = path.relative(hostnamePath, filePath);
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.html' || ext === '.htm') {
        await rewriteHtmlFile(jobId, filePath, hostname, relativeToHost);
      } else if (ext === '.css') {
        await rewriteCssFile(jobId, filePath, hostname, relativeToHost);
      }
    }
  }
}

module.exports = {
  rewriteJobAssets
};
