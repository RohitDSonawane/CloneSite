const express = require('express');
const path = require('path');
const pino = require('pino');
const crawlRouter = require('./routes/crawl');
const downloadsRouter = require('./routes/downloads');
const { startCleanupScheduler } = require('./storage/cleanup');

const app = express();
const logger = pino({
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined
});

// Boot storage background cleaner
startCleanupScheduler();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// Wire routers
app.use('/crawl', crawlRouter);
app.use('/downloads', downloadsRouter);

// Standard root landing route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Mask internal server errors from leaking stack traces
app.use((err, req, res, next) => {
  logger.error(err, 'Server error occurred');
  if (!res.headersSent) {
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

module.exports = app;
