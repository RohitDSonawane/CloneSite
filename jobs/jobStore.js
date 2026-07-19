const fs = require('fs').promises;
const path = require('path');
const pino = require('pino');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

class JobStore {
  constructor() {
    this.jobs = new Map();
  }

  get(jobId) {
    return this.jobs.get(jobId);
  }

  set(jobId, jobState) {
    this.jobs.set(jobId, jobState);
  }

  /**
   * Returns count of active crawling jobs.
   * @returns {number}
   */
  activeCount() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /**
   * Registers an Express Response target to listen to SSE events.
   * @param {string} jobId
   * @param {object} res Express response object
   */
  registerSseClient(jobId, res) {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = {
        id: jobId,
        status: 'pending',
        pagesVisited: 0,
        bytesDownloaded: 0,
        sseClients: new Set()
      };
      this.jobs.set(jobId, job);
    }
    if (!job.sseClients) {
      job.sseClients = new Set();
    }
    job.sseClients.add(res);

    res.on('close', () => {
      job.sseClients.delete(res);
      logger.info({ jobId }, 'SSE client connection closed');
    });
  }

  /**
   * Broadcasts a structured event stream frame to all job-registered SSE clients.
   * @param {string} jobId
   * @param {string} event
   * @param {object} data
   */
  publish(jobId, event, data) {
    const job = this.jobs.get(jobId);
    if (!job || !job.sseClients || job.sseClients.size === 0) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of job.sseClients) {
      try {
        client.write(payload);
      } catch (err) {
        logger.error({ error: err.message, jobId }, 'Failed writing to SSE client');
      }
    }
  }

  /**
   * Terminates a running crawl and scrubs its work directory.
   * @param {string} jobId
   */
  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    logger.info({ jobId }, 'Executing manual job cancellation request');
    job.status = 'aborted';

    if (job.crawler) {
      try {
        await job.crawler.teardown();
      } catch (err) {
        logger.error({ error: err.message, jobId }, 'Error occurred aborting crawl run');
      }
    }

    this.publish(jobId, 'aborted', { reason: 'Cancelled by user' });

    // End active connection endpoints
    if (job.sseClients) {
      for (const client of job.sseClients) {
        try {
          client.end();
        } catch (err) {
          // Ignore
        }
      }
      job.sseClients.clear();
    }

    // Delete temp folder work/<jobId>
    const workDir = path.join('work', jobId);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Updates state data and pushes progress reports.
   * @param {string} jobId
   * @param {object} update
   */
  updateProgress(jobId, update) {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, update);
      if (update.pagesVisited !== undefined || update.bytesDownloaded !== undefined) {
        this.publish(jobId, 'progress', {
          pagesVisited: job.pagesVisited,
          bytesDownloaded: job.bytesDownloaded,
          currentUrl: job.currentUrl
        });
      }
    }
  }
}

module.exports = new JobStore();
