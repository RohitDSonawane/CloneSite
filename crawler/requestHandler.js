const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const pino = require('pino');
const config = require('../config');
const security = require('./security');
const jobStore = require('../jobs/jobStore');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

/**
 * Maps a URL and content-type to a safe path on the local filesystem.
 * @param {string} jobId
 * @param {URL} urlObj
 * @param {string} contentType
 * @returns {string}
 */
function getDiskPath(jobId, urlObj, contentType) {
  const hostname = urlObj.hostname;
  let pathname = urlObj.pathname;

  // Handle default documents for empty or trailing-slash paths
  if (!pathname || pathname.endsWith('/')) {
    pathname = path.join(pathname, 'index.html');
  } else if (!path.extname(pathname)) {
    if (contentType && contentType.includes('text/html')) {
      pathname += '.html';
    }
  }

  // Prevent directory traversal (remove leading relative patterns)
  const safePathname = path.normalize(pathname).replace(/^(\.\.(\/|\\))+/, '');
  return path.join('work', jobId, hostname, safePathname);
}

/**
 * Attaches the response listener to capture resources before navigation finishes.
 * @param {string} jobId
 * @param {object} page
 */
function registerResponseListener(jobId, page) {
  page.on('response', async (response) => {
    const urlString = response.url();
    if (urlString.startsWith('data:')) return;

    try {
      await security.assertSafeUrl(urlString);
    } catch (err) {
      return; // Skip unsafe resources
    }

    const status = response.status();
    if (status < 200 || status >= 400) return; // Ignore failure statuses

    try {
      const contentType = response.headers()['content-type'] || '';
      const buffer = await response.body();
      const size = buffer.length;

      // Update accumulated bytes in the jobStore
      const jobState = jobStore.get(jobId);
      if (jobState) {
        jobState.bytesDownloaded = (jobState.bytesDownloaded || 0) + size;
        if (jobState.bytesDownloaded > config.MAX_TOTAL_BYTES) {
          logger.warn({ jobId }, 'Byte limits exceeded. Terminating crawler.');
          await jobState.crawler.autoscaledPool.abort();
        }
        jobStore.updateProgress(jobId, { bytesDownloaded: jobState.bytesDownloaded });
      }

      // Write resource to file
      const urlObj = new URL(urlString);
      const diskPath = getDiskPath(jobId, urlObj, contentType);
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.writeFile(diskPath, buffer);
    } catch (err) {
      logger.debug({ url: urlString, error: err.message }, 'Could not capture intercepted resource');
    }
  });
}

/**
 * Attaches the SSRF routing hook to check and block requests before they are sent.
 * @param {object} page
 */
async function registerRouteHook(page) {
  if (!page._routeHookAdded) {
    page._routeHookAdded = true;
    await page.route('**/*', async (route) => {
      const req = route.request();
      try {
        await security.assertSafeUrl(req.url());
        await route.continue();
      } catch (err) {
        logger.warn({ url: req.url(), reason: err.message }, 'SSRF Guard blocked resource request');
        await route.abort('blockedbyclient');
      }
    });
  }
}

/**
 * Progressively scrolls the page to trigger lazy loading of assets.
 * @param {object} page Playwright Page instance
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 250;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        // Cap at 15000px to prevent infinite scrolling hooks
        if (totalHeight >= scrollHeight || totalHeight > 15000) {
          clearInterval(timer);
          resolve();
        }
      }, 70);
    });
  });
}

/**
 * Creates the Crawlee requestHandler.
 * @param {string} jobId
 * @param {object} requestQueue
 * @param {object} options
 */
function makeRequestHandler(jobId, requestQueue, options = {}) {
  return async ({ request, page }) => {

    // Wait for the network to settle initially
    await page.waitForLoadState('networkidle').catch(() => {});

    // Scroll page down to trigger lazy resources load
    await autoScroll(page).catch(() => {});

    // Wait for new network requests triggered by scrolling to settle
    await page.waitForLoadState('networkidle').catch(() => {});

    // Save final rendered HTML
    const html = await page.content();
    const urlObj = new URL(request.url);
    const diskPath = getDiskPath(jobId, urlObj, 'text/html');
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, Buffer.from(html, 'utf8'));

    // Extract links
    const $ = cheerio.load(html);
    const links = [];
    
    const rootUrlObj = new URL(request.loadedUrl || request.url);
    const allowSubdomains = options.allowSubdomains !== undefined ? options.allowSubdomains : config.ALLOW_SUBDOMAINS;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      try {
        const resolvedUrl = new URL(href, request.url);
        resolvedUrl.hash = ''; // strip hash fragments

        // Normalize parameters
        const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
        utmParams.forEach(p => resolvedUrl.searchParams.delete(p));

        const isSameOrigin = resolvedUrl.origin === rootUrlObj.origin;
        let allow = isSameOrigin;

        if (!isSameOrigin && allowSubdomains) {
          // ponytail: simple suffix host check
          const resolvedHost = resolvedUrl.hostname;
          const rootHost = rootUrlObj.hostname;
          if (resolvedHost.endsWith('.' + rootHost) || resolvedHost === rootHost) {
            allow = true;
          }
        }

        if (allow) {
          links.push(resolvedUrl.toString());
        }
      } catch (err) {
        // Skip invalid URL strings
      }
    });

    // Validate enqueued URLs
    const safeLinks = [];
    for (const link of links) {
      try {
        await security.assertSafeUrl(link);
        safeLinks.push(link);
      } catch (err) {
        // Skip unsafe link targets
      }
    }

    if (safeLinks.length > 0) {
      await requestQueue.addRequests(safeLinks.map(url => ({ url })));
    }

    // Update job metrics
    const jobState = jobStore.get(jobId);
    if (jobState) {
      jobState.pagesVisited = (jobState.pagesVisited || 0) + 1;
      jobStore.updateProgress(jobId, {
        pagesVisited: jobState.pagesVisited,
        currentUrl: request.url
      });
    }
  };
}

module.exports = {
  makeRequestHandler,
  getDiskPath,
  registerResponseListener,
  registerRouteHook
};
