const fs = require('fs').promises;
const path = require('path');
const assert = require('assert');
const { rewriteJobAssets } = require('../crawler/urlRewriter');
const { zipJobDirectory } = require('../archiver/index');
const { sweep } = require('../storage/cleanup');
const config = require('../config');

async function runTests() {
  console.log('Starting Phase 3 Unit Tests...');

  const jobId = `test-job-phase3-${Date.now()}`;
  const jobWorkDir = path.join('work', jobId);
  const hostDir = path.join(jobWorkDir, 'example.com');
  const cssDir = path.join(hostDir, 'css');

  // Create mock folder structure
  await fs.mkdir(cssDir, { recursive: true });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <link rel="stylesheet" href="/css/style.css">
      <link rel="stylesheet" href="http://google.com/external.css">
    </head>
    <body>
      <img src="http://example.com/logo.png" srcset="http://example.com/logo.png 1x, /logo2x.png 2x">
      <a href="/about.html">About Page</a>
    </body>
    </html>
  `;
  const htmlPath = path.join(hostDir, 'index.html');
  await fs.writeFile(htmlPath, htmlContent, 'utf8');

  // Write mock asset files so that the local resolver detects them as captured
  await fs.writeFile(path.join(cssDir, 'style.css'), 'body { background: url(/logo.png); }', 'utf8');
  await fs.writeFile(path.join(hostDir, 'logo.png'), 'dummy', 'utf8');
  await fs.writeFile(path.join(hostDir, 'logo2x.png'), 'dummy', 'utf8');
  await fs.writeFile(path.join(hostDir, 'about.html'), 'dummy', 'utf8');

  // Run rewriter
  await rewriteJobAssets(jobId);

  // Validate HTML content relative outputs
  const updatedHtml = await fs.readFile(htmlPath, 'utf8');
  assert.ok(updatedHtml.includes('href="css/style.css"'), 'style.css link should be relative');
  assert.ok(updatedHtml.includes('href="http://google.com/external.css"'), 'google.com link should remain absolute');
  assert.ok(updatedHtml.includes('src="logo.png"'), 'logo.png source should be relative');
  assert.ok(updatedHtml.includes('srcset="logo.png 1x, logo2x.png 2x"'), 'srcset attributes should be relative');
  assert.ok(updatedHtml.includes('href="about.html"'), 'about.html link should be relative');

  // Validate CSS url(...) relative translation
  const updatedCss = await fs.readFile(path.join(cssDir, 'style.css'), 'utf8');
  assert.ok(updatedCss.includes('url(../logo.png)'), 'CSS image url should be adjusted relative to CSS folder location');
  console.log('URL rewriter tests passed.');

  // Validate Zip Archiver
  const zipPath = await zipJobDirectory(jobId);
  const zipExists = await fs.access(zipPath).then(() => true).catch(() => false);
  assert.ok(zipExists, 'Downloadable ZIP archive was not created');

  const workFolderDeleted = await fs.access(jobWorkDir).then(() => false).catch(() => true);
  assert.ok(workFolderDeleted, 'Raw work folder was not deleted on compression completion');
  console.log('Archiver zipping tests passed.');

  // Validate Cleanup Sweep
  const originalTtl = config.DOWNLOAD_TTL_MS;
  config.DOWNLOAD_TTL_MS = -1; // force expiration

  try {
    await sweep();
    const zipCleaned = await fs.access(zipPath).then(() => false).catch(() => true);
    assert.ok(zipCleaned, 'Expired ZIP archive was not removed by cleanup sweep');
    console.log('Cleanup sweeper tests passed.');
  } finally {
    config.DOWNLOAD_TTL_MS = originalTtl;
  }

  console.log('All Phase 3 tests passed!');
}

runTests().catch(err => {
  console.error('Phase 3 tests failed:', err);
  process.exit(1);
});
