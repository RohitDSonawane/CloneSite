const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const assert = require('assert');
const { startCrawl } = require('../crawler/index');
const jobStore = require('../jobs/jobStore');

async function runTests() {
  console.log('Starting Crawler Core Unit Tests...');

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="/style.css">
        </head>
        <body>
          <h1>Hello World</h1>
          <a href="/about">About Page</a>
        </body>
        </html>
      `);
    } else if (req.url === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body { background: #f0f0f0; }');
    } else if (req.url === '/about') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>About Page</h1>');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  const port = 4567;
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  console.log(`Local mock server listening on port ${port}`);

  const jobId = `test-job-uuid-${Date.now()}`;
  const rootUrl = `http://127.0.0.1:${port}/`;

  try {
    process.env.BYPASS_SSRF_FOR_TEST = 'true';

    // Start crawling
    await startCrawl(jobId, rootUrl, { maxPages: 5 });

    // Assert files are downloaded
    const mainHtmlPath = path.join('work', jobId, '127.0.0.1', 'index.html');
    const cssPath = path.join('work', jobId, '127.0.0.1', 'style.css');
    const aboutHtmlPath = path.join('work', jobId, '127.0.0.1', 'about.html');

    const mainExists = await fs.access(mainHtmlPath).then(() => true).catch(() => false);
    const cssExists = await fs.access(cssPath).then(() => true).catch(() => false);
    const aboutExists = await fs.access(aboutHtmlPath).then(() => true).catch(() => false);

    assert.ok(mainExists, 'Main index.html was not downloaded');
    assert.ok(cssExists, 'style.css asset was not downloaded');
    assert.ok(aboutExists, 'Linked about page was not downloaded');

    // Assert job progress is tracked
    const jobState = jobStore.get(jobId);
    assert.ok(jobState, 'Job state should be tracked in jobStore');
    assert.ok(jobState.pagesVisited >= 2, `Visited pages count should be >= 2, got ${jobState.pagesVisited}`);
    assert.ok(jobState.bytesDownloaded > 0, 'Bytes downloaded should be > 0');

    console.log('Crawler Core checks completed successfully!');
  } finally {
    process.env.BYPASS_SSRF_FOR_TEST = 'false';
    server.close();
    await fs.rm(path.join('work', jobId), { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Crawler Core checks failed:', err);
  process.exit(1);
});
