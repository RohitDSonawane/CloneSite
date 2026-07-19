const express = require('express');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const pino = require('pino');

const router = express.Router();
const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

const jobIdSchema = z.object({
  jobId: z.string().uuid()
});

/**
 * GET /downloads/:jobId.zip - Streams the completed ZIP archive.
 */
router.get('/:jobId.zip', (req, res) => {
  const paramParse = jobIdSchema.safeParse(req.params);
  if (!paramParse.success) {
    return res.status(400).json({ error: 'Invalid download identifier format' });
  }

  const { jobId } = paramParse.data;
  const filePath = path.join(__dirname, '..', 'public', 'downloads', `${jobId}.zip`);

  // Verify file existence before attempting to stream
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) {
      logger.warn({ jobId }, 'ZIP archive download target not found');
      return res.status(404).json({ error: 'Archive not found or expired' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${jobId}.zip"`);

    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamErr) => {
      logger.error({ error: streamErr.message, jobId }, 'Error streaming download archive file');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to retrieve download package' });
      }
    });

    stream.pipe(res);
  });
});

module.exports = router;
