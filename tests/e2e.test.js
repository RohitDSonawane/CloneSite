const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const assert = require('assert');
const app = require('../app');

async function runE2e() {
  console.log('Starting End-to-End Crawler/App Integration Tests...');

  // 1. Boot up application server
  const appPort = 4569;
  const appServer = http.createServer(app);
  await new Promise(resolve => appServer.listen(appPort, '127.0.0.1', resolve));
  console.log(`App Server listening on port ${appPort}`);

  // 2. Boot up mock website target server
  const targetPort = 4570;
  const targetServer = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="stylesheet" href="/style.css">
        </head>
        <body>
          <h1 id="header">Loading...</h1>
          <a href="/page2">Go to Page 2</a>
          <script>
            // Verify JS execution by updating content after DOM load
            setTimeout(() => {
              document.getElementById('header').innerText = 'JS Loaded Content!';
            }, 100);
          </script>
        </body>
        </html>
      `);
    } else if (req.url === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body { color: #333; }');
    } else if (req.url === '/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Welcome to Page 2!</h1>');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  await new Promise(resolve => targetServer.listen(targetPort, '127.0.0.1', resolve));
  console.log(`Mock target website listening on port ${targetPort}`);

  try {
    process.env.BYPASS_SSRF_FOR_TEST = 'true';

    // 3. Initiate POST crawl request
    const crawlRes = await fetch(`http://127.0.0.1:${appPort}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://127.0.0.1:${targetPort}/`
      })
    });
    
    assert.strictEqual(crawlRes.status, 202, 'Crawl request should yield 202 Accepted');
    const { jobId } = await crawlRes.json();
    console.log(`Job queued successfully with ID: ${jobId}`);

    // 4. Attach to SSE events stream
    const eventUrl = `http://127.0.0.1:${appPort}/crawl/${jobId}/events`;
    const eventRes = await fetch(eventUrl);
    assert.strictEqual(eventRes.status, 200, 'SSE event stream must be accessible');

    const reader = eventRes.body.getReader();
    const decoder = new TextDecoder();
    let doneReceived = false;
    let doneData = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      console.log('SSE Chunk:', text.trim());
      
      if (text.includes('event: done')) {
        doneReceived = true;
        const match = /data:\s*({.*})/.exec(text);
        if (match) {
          doneData = JSON.parse(match[1]);
        }
        break;
      }
      if (text.includes('event: error')) {
        throw new Error('SSE stream reported crawl error');
      }
    }

    assert.ok(doneReceived, 'Done SSE event was not fired');
    assert.ok(doneData, 'Done event stats data missing');
    console.log('Done SSE event received correctly:', doneData);

    // 5. Download resulting package and verify
    const downloadUrl = `http://127.0.0.1:${appPort}${doneData.downloadUrl}`;
    const zipRes = await fetch(downloadUrl);
    assert.strictEqual(zipRes.status, 200, 'ZIP download should succeed');
    
    const zipBuffer = await zipRes.arrayBuffer();
    assert.ok(zipBuffer.byteLength > 0, 'ZIP bytes size must be non-zero');
    console.log(`ZIP file fetched. Size: ${zipBuffer.byteLength} bytes`);

    // Verify intermediate workspace cleanup
    const workDirExists = await fs.access(path.join('work', jobId)).then(() => true).catch(() => false);
    assert.ok(!workDirExists, 'Raw intermediate work folder was not deleted on completion');

    console.log('All End-to-End checks completed successfully!');
  } finally {
    process.env.BYPASS_SSRF_FOR_TEST = 'false';
    appServer.close();
    targetServer.close();
  }
}

runE2e().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('End-to-End Integration tests failed:', err);
  process.exit(1);
});
