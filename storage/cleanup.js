const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const pino = require('pino');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

/**
 * Performs a sweep of downloads and work folders, deleting expired items.
 */
async function sweep() {
  logger.info('Executing storage cleanup sweep...');
  const now = Date.now();

  // 1. Clean public/downloads/ (ZIP files older than DOWNLOAD_TTL_MS)
  const downloadsDir = path.join('public', 'downloads');
  try {
    const files = await fs.readdir(downloadsDir);
    for (const file of files) {
      const filePath = path.join(downloadsDir, file);
      const stat = await fs.stat(filePath);
      const age = now - stat.mtimeMs;
      if (age > config.DOWNLOAD_TTL_MS) {
        await fs.rm(filePath, { force: true });
        logger.info({ filePath, ageMs: age }, 'Deleted expired ZIP archive');
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error({ error: err.message }, 'Error sweeping downloads folder');
    }
  }

  // 2. Clean work/ (orphaned folders older than MAX_CRAWL_DURATION_MS * 2)
  const workDir = path.join('work');
  const orphanMaxAge = config.MAX_CRAWL_DURATION_MS * 2;
  try {
    const dirs = await fs.readdir(workDir);
    for (const dir of dirs) {
      const dirPath = path.join(workDir, dir);
      const stat = await fs.stat(dirPath);
      const age = now - stat.mtimeMs;
      if (age > orphanMaxAge) {
        await fs.rm(dirPath, { recursive: true, force: true });
        logger.info({ dirPath, ageMs: age }, 'Deleted orphaned work folder');
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error({ error: err.message }, 'Error sweeping work folder');
    }
  }
  logger.info('Storage cleanup sweep complete.');
}

/**
 * Starts the hourly interval sweeper.
 */
function startCleanupScheduler() {
  // Execute initial sweep at server startup
  sweep().catch(err => logger.error({ err }, 'Startup cleanup sweep failed'));
  
  // Clean every hour (3600000ms)
  setInterval(() => {
    sweep().catch(err => logger.error({ err }, 'Hourly cleanup sweep failed'));
  }, 60 * 60 * 1000);
}

module.exports = {
  sweep,
  startCleanupScheduler
};
