const { PlaywrightCrawler, RequestQueue } = require('crawlee');
const config = require('../config');
const security = require('./security');
const { makeRequestHandler, registerResponseListener, registerRouteHook } = require('./requestHandler');
const jobStore = require('../jobs/jobStore');
const pino = require('pino');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

/**
 * Builds and starts a Playwright crawler for a given job.
 * @param {string} jobId
 * @param {string} rootUrl
 * @param {object} options
 */
async function startCrawl(jobId, rootUrl, options = {}) {
  // Clamp requests to configuration boundaries
  const maxPages = Math.min(options.maxPages || config.MAX_PAGES_PER_CRAWL, config.MAX_PAGES_PER_CRAWL);

  const requestQueue = await RequestQueue.open(jobId);
  await requestQueue.addRequest({ url: rootUrl });

  const crawler = new PlaywrightCrawler({
    requestQueue,
    launchContext: {
      launchOptions: {
        headless: true
      }
    },
    maxRequestsPerCrawl: maxPages,
    maxConcurrency: config.CRAWL_CONCURRENCY,
    requestHandlerTimeoutSecs: config.PAGE_NAV_TIMEOUT_MS / 1000,
    preNavigationHooks: [
      async ({ request, page }) => {
        // SSRF guard check before navigating
        await security.assertSafeUrl(request.url);
        // Attach routing and response capture hooks before navigation triggers
        await registerRouteHook(page);
        registerResponseListener(jobId, page);
      }
    ],
    requestHandler: makeRequestHandler(jobId, requestQueue, options),
    failedRequestHandler: async ({ request }, error) => {
      logger.error({ url: request.url, error: error.message }, 'Crawler page request failed');
    }
  });

  // Register crawler and active queue in jobStore
  const jobState = jobStore.get(jobId) || {
    id: jobId,
    status: 'running',
    startedAt: Date.now(),
    pagesVisited: 0,
    bytesDownloaded: 0
  };
  jobState.crawler = crawler;
  jobState.requestQueue = requestQueue;
  jobStore.set(jobId, jobState);

  // Max duration constraint
  const timeoutId = setTimeout(async () => {
    logger.warn({ jobId }, 'Max duration timeout reached. Tearing down crawler.');
    try {
      await crawler.teardown();
      jobState.status = 'aborted';
    } catch (err) {
      logger.error({ err }, 'Error during crawler timeout teardown');
    }
  }, config.MAX_CRAWL_DURATION_MS);

  try {
    await crawler.run();
  } finally {
    clearTimeout(timeoutId);
    await requestQueue.drop().catch(() => {});
  }
}

module.exports = {
  startCrawl
};
