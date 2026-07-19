const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const pino = require('pino');

const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

/**
 * Zips the intermediate crawl work directory into a downloadable zip file,
 * then cleans up the intermediate work folder.
 * @param {string} jobId
 * @returns {Promise<string>} Path to the generated ZIP file
 */
async function zipJobDirectory(jobId) {
  const sourceDir = path.join('work', jobId);
  const targetDir = path.join('public', 'downloads');
  const targetZip = path.join(targetDir, `${jobId}.zip`);

  // Ensure target downloads directory exists
  await fsPromises.mkdir(targetDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetZip);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Max compression
    });

    output.on('close', async () => {
      logger.info({ jobId, bytes: archive.pointer() }, 'ZIP archive finalized');
      try {
        // Clean up intermediate work folder to free up space
        await fsPromises.rm(sourceDir, { recursive: true, force: true });
        resolve(targetZip);
      } catch (err) {
        logger.error({ error: err.message, jobId }, 'Failed to delete intermediate work directory');
        resolve(targetZip); // Still resolve, since the ZIP itself is complete
      }
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        logger.warn({ warning: err.message }, 'Archiver warning');
      } else {
        reject(err);
      }
    });

    archive.on('error', async (err) => {
      logger.error({ error: err.message, jobId }, 'Archiver error occurred');
      // Cleanup partial artifacts on failure
      await fsPromises.rm(targetZip, { force: true }).catch(() => {});
      await fsPromises.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
      reject(err);
    });

    archive.pipe(output);

    // Add everything inside work/<jobId>/ to the root of the ZIP
    archive.directory(sourceDir, false);

    archive.finalize();
  });
}

module.exports = {
  zipJobDirectory
};
