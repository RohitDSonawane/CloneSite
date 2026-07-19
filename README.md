# CloneSite

CloneSite is a Node.js and Express web application that crawls a given web page, captures all dynamically loaded resources and assets (including Javascript-rendered elements, dynamically loaded images, scripts, fonts, and stylesheets), rewrites absolute and root-relative URLs into local relative paths, and packages the final mirror into a downloadable ZIP archive.

Unlike naive static website download tools, CloneSite utilizes a headless Chromium browser to execute Javascript and capture modern Single Page Application (SPA) contents and lazily-loaded assets before saving them to disk.

---

## Key Features

- Headless Browser Crawling: Managed via Crawlee and Playwright to execute client-side scripts and capture dynamic resources.
- Server-Sent Events (SSE): Push real-time progress events (pages visited, bytes downloaded, active page logs) to the browser without full-duplex socket overhead.
- Security and SSRF Protection: Pre-navigation hook resolving hostnames via DNS and checking IP targets against private, loopback, and link-local ranges for both IPv4 and IPv6.
- Offline Link Localization: Rewrites URL paths in HTML attributes (src, href, srcset) and CSS declarations (url(...)) to relative folder paths on disk.
- Path Traversal Protections: Parameter inputs such as job identifiers are strictly validated against UUID formats before executing disk operations.
- Rate Limiting and Concurrency Control: Implements token-bucket rate limits per client IP and enforces maximum concurrent job caps to stabilize server resources.
- Automated Cleanup Scheduler: Sweeps and deletes expired ZIP files and temporary work folders periodically.

---

## Technology Stack

- Runtime Environment: Node.js 20 LTS
- Web Server Framework: Express 4.x
- Browser Automation and Crawling: Crawlee with Playwright (Chromium only)
- HTML Parsing and Dom Manipulation: Cheerio
- CSS Parsing and Link Processing: PostCSS
- Compression Packaging: Archiver
- Configuration and Input Validation: Zod
- Environment Variable Configurator: Dotenv
- Structured Logging: Pino

---

## Directory Structure

```text
clonesite/
├── bin/
│   └── www                      # HTTP Server Bootstrapper
├── config/
│   └── index.js                 # Environment Config Loader & Validator
├── crawler/
│   ├── index.js                 # Playwright Crawler Factory Launch Wrapper
│   ├── requestHandler.js        # Resource Capture and Link Discovery Handler
│   ├── urlRewriter.js           # Post-Crawl Path Rewriting Module
│   └── security.js              # SSRF IP/Port Validation Guard
├── jobs/
│   └── jobStore.js              # Job State Tracker & SSE Client Registry
├── archiver/
│   └── index.js                 # Zip Compression & Temp Directory Scrubber
├── storage/
│   └── cleanup.js               # Scheduled Expired Archive Eraser
├── routes/
│   ├── crawl.js                 # Main REST Endpoints & Event Streams Route
│   └── downloads.js             # ZIP Download Interface Route
├── public/
│   ├── index.html               # SPA Interface Landing Client HTML
│   └── stylesheets/
│       └── style.css            # Landing Page Style Rules
├── tests/
│   ├── security.test.js         # SSRF Guard Verification Suite
│   ├── crawler.test.js          # Crawler Download Verification Suite
│   ├── phase4.test.js           # REST API Endpoint Verification Suite
│   └── e2e.test.js              # Integration Flow Verification Suite
├── .env.example                 # Variables Template File
├── .gitignore                   # Version Exclusions Rules
├── package.json                 # Dependency Directives File
└── README.md                    # Core System Documentation
```

---

## Installation & Setup

1. Clone the repository to your local system.
2. Install the package dependencies:
   ```bash
   npm install
   ```
3. Install the Playwright Chromium browser binaries:
   ```bash
   npx playwright install chromium
   ```
4. Create a `.env` file in the root directory and define the configurations (see Environment Configuration below).
5. Start the server:
   ```bash
   npm start
   ```
6. Access the application in your browser at `http://localhost:3000`.

---

## Environment Configuration

CloneSite uses environment variables loaded on boot to manage server limits. Refer to `.env.example` for details:

- PORT: Port number for the HTTP server to listen on (default: 3000).
- MAX_CONCURRENT_JOBS: Max active crawls running concurrently on the server (default: 3).
- MAX_PAGES_PER_CRAWL: Limit on pages fetched per crawl job (default: 40).
- MAX_CRAWL_DEPTH: Link traversal depth limit from target URL (default: 3).
- CRAWL_CONCURRENCY: Crawler page pool concurrency size (default: 3).
- MAX_TOTAL_BYTES: Maximum allowed bytes downloaded per crawl job before aborting (default: 524288000).
- MAX_CRAWL_DURATION_MS: Maximum duration limit for crawl jobs in milliseconds (default: 300000).
- PAGE_NAV_TIMEOUT_MS: Browser navigation timeout in milliseconds (default: 30000).
- ALLOWED_PROTOCOLS: Permitted protocol schemes list (default: http:,https:).
- ALLOW_SUBDOMAINS: Crawl subdomains of target site (default: false).
- DOWNLOAD_TTL_MS: Expiration time limit for downloaded archives in milliseconds (default: 86400000).
- RATE_LIMIT_PER_IP_PER_HOUR: Max crawl jobs submitted per IP per hour (default: 5).

---

## Running Verification Tests

To verify specific modules, execute the following commands:

- SSRF Guard Verification:
  ```bash
  npm run test:security
  ```
- End-to-End Workflow Verification:
  ```bash
  npm run test:e2e
  ```
- Individual Suite Files:
  ```bash
  node tests/crawler.test.js
  node tests/phase4.test.js
  ```
