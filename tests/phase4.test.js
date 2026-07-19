const express = require('express');
const http = require('http');
const assert = require('assert');
const config = require('../config');
const crawlRouter = require('../routes/crawl');
const downloadsRouter = require('../routes/downloads');

async function runTests() {
  console.log('Starting Phase 4 API and Routing Unit Tests...');

  const app = express();
  app.use(express.json());
  app.use('/crawl', crawlRouter);
  app.use('/downloads', downloadsRouter);

  const server = http.createServer(app);
  const port = 4568;
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test 1: Path Traversal security check
    const resTraversal = await fetch(`${baseUrl}/downloads/..%2f..%2fpackage.zip`);
    assert.strictEqual(resTraversal.status, 400, 'Path traversal targets must be blocked with 400');
    console.log('Path traversal prevention checks passed.');

    // Test 2: Invalid UUID check
    const resInvalidUuid = await fetch(`${baseUrl}/downloads/non-existent-job-uuid.zip`);
    assert.strictEqual(resInvalidUuid.status, 400, 'Non-UUID download requests must be blocked with 400');
    console.log('Non-UUID input checks passed.');

    // Test 3: POST /crawl validation
    const resInvalidCrawl = await fetch(`${baseUrl}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'invalid-url-protocol://test' })
    });
    assert.strictEqual(resInvalidCrawl.status, 400, 'Invalid URLs must return 400 Bad Request');
    console.log('Crawl parameter validation checks passed.');

    // Test 4: Rate Limiting
    // The previous crawl call consumed 1 token. We make 4 more calls to consume the remaining 4 tokens, then verify the 6th is rejected.
    const targetUrl = 'http://example.com/';
    for (let i = 0; i < 4; i++) {
      await fetch(`${baseUrl}/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
    }

    // 6th call from local IP
    const resRateLimited = await fetch(`${baseUrl}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl })
    });
    assert.strictEqual(resRateLimited.status, 429, 'Exceeding the rate limit must return 429');
    console.log('Token bucket IP rate limiting checks passed.');

  } finally {
    server.close();
  }
  console.log('All Phase 4 API tests passed successfully!');
}

runTests().catch(err => {
  console.error('Phase 4 tests failed:', err);
  process.exit(1);
});
