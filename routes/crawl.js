const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { z } = require('zod');
const pino = require('pino');
const config = require('../config');
const jobStore = require('../jobs/jobStore');
const { startCrawl } = require('../crawler');
const { rewriteJobAssets } = require('../crawler/urlRewriter');
const { zipJobDirectory } = require('../archiver');

const router = express.Router();
const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

// Simple in-memory token bucket rate limiter keyed by IP
const ipLimits = new Map(); // ip -> { tokens, lastRefill }

function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const limitPerHour = config.RATE_LIMIT_PER_IP_PER_HOUR;
  const fillRate = 3600000 / limitPerHour; // ms per token

  let bucket = ipLimits.get(ip);
  if (!bucket) {
    bucket = { tokens: limitPerHour, lastRefill: now };
    ipLimits.set(ip, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / fillRate);
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(limitPerHour, bucket.tokens + tokensToAdd);
      bucket.lastRefill = bucket.lastRefill + tokensToAdd * fillRate;
    }
  }

  // ponytail: in-memory token bucket, upgrade to Redis rate-limiter if distributed deployment
  if (bucket.tokens <= 0) {
    logger.warn({ ip }, 'Rate limit exceeded');
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  bucket.tokens--;
  next();
}

// Zod schemas for POST /crawl body
const crawlSchema = z.object({
  url: z.string().url().refine(val => {
    try {
      const parsed = new URL(val);
      return config.ALLOWED_PROTOCOLS.includes(parsed.protocol);
    } catch {
      return false;
    }
  }, {
    message: 'Forbidden protocol scheme'
  }),
  options: z.object({
    maxPages: z.coerce.number().optional(),
    maxDepth: z.coerce.number().optional(),
    allowSubdomains: z.preprocess(
      val => val === 'true' || val === true,
      z.boolean()
    ).optional()
  }).default({})
});

const jobIdSchema = z.object({
  jobId: z.string().uuid()
});

/**
 * POST /crawl - Starts an asynchronous crawling job.
 */
router.post('/', rateLimit, async (req, res) => {
  try {
    const bodyParse = crawlSchema.safeParse(req.body);
    if (!bodyParse.success) {
      return res.status(400).json({ error: 'Invalid request payload format' });
    }

    const { url, options } = bodyParse.data;

    // Concurrency limit enforcement
    if (jobStore.activeCount() >= config.MAX_CONCURRENT_JOBS) {
      logger.warn('Server is at maximum concurrent job capacity');
      return res.status(429).json({ error: 'Server is currently at capacity. Please try again later.' });
    }

    // Clamp client limits to server maximum configurations
    const clampedOptions = {
      maxPages: Math.min(options.maxPages || config.MAX_PAGES_PER_CRAWL, config.MAX_PAGES_PER_CRAWL),
      maxDepth: Math.min(options.maxDepth || config.MAX_CRAWL_DEPTH, config.MAX_CRAWL_DEPTH),
      allowSubdomains: options.allowSubdomains !== undefined ? options.allowSubdomains : config.ALLOW_SUBDOMAINS
    };

    const jobId = crypto.randomUUID();

    // Create initial tracking entry in job store
    const jobState = {
      id: jobId,
      status: 'pending',
      startedAt: Date.now(),
      pagesVisited: 0,
      bytesDownloaded: 0
    };
    jobStore.set(jobId, jobState);

    // Run crawl job asynchronously
    (async () => {
      try {
        jobState.status = 'running';
        
        // 1. Run crawler
        await startCrawl(jobId, url, clampedOptions);

        if (jobState.status === 'aborted') return;

        // 2. Localize references
        await rewriteJobAssets(jobId);

        // 3. Compress final folders
        const zipPath = await zipJobDirectory(jobId);

        // 4. Update state to done and push event
        const stats = await fs.stat(zipPath);
        const duration = Date.now() - jobState.startedAt;
        
        jobStore.updateProgress(jobId, { status: 'done' });
        jobStore.publish(jobId, 'done', {
          downloadUrl: `/downloads/${jobId}.zip`,
          stats: {
            pages: jobState.pagesVisited,
            bytes: stats.size,
            durationMs: duration
          }
        });
      } catch (err) {
        logger.error({ error: err.message, jobId }, 'Crawl job run failed');
        jobStore.updateProgress(jobId, { status: 'error' });
        jobStore.publish(jobId, 'error', { message: 'Crawl job execution failed' });
        
        // Cleanup resources on failure
        const targetZip = path.join('public', 'downloads', `${jobId}.zip`);
        await fs.rm(targetZip, { force: true }).catch(() => {});
        await fs.rm(path.join('work', jobId), { recursive: true, force: true }).catch(() => {});
      }
    })();

    return res.status(202).json({ jobId });
  } catch (err) {
    logger.error({ error: err.message }, 'Unexpected error creating crawl job');
    return res.status(500).json({ error: 'Internal server error occurred' });
  }
});

/**
 * GET /crawl/:jobId/events - Serves the Server-Sent Events stream.
 */
router.get('/:jobId/events', (req, res) => {
  const paramParse = jobIdSchema.safeParse(req.params);
  if (!paramParse.success) {
    return res.status(400).json({ error: 'Invalid job ID format' });
  }

  const { jobId } = paramParse.data;

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  res.write('retry: 3000\n\n');

  jobStore.registerSseClient(jobId, res);
});

/**
 * POST /crawl/:jobId/cancel - Triggers crawl cancel.
 */
router.post('/:jobId/cancel', async (req, res) => {
  const paramParse = jobIdSchema.safeParse(req.params);
  if (!paramParse.success) {
    return res.status(400).json({ error: 'Invalid job ID format' });
  }

  const { jobId } = paramParse.data;
  await jobStore.cancelJob(jobId);
  return res.sendStatus(204);
});

module.exports = router;
