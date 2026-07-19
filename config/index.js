const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  MAX_CONCURRENT_JOBS: z.coerce.number().default(3),
  MAX_PAGES_PER_CRAWL: z.coerce.number().default(40),
  MAX_CRAWL_DEPTH: z.coerce.number().default(3),
  MAX_TOTAL_BYTES: z.coerce.number().default(500 * 1024 * 1024),
  MAX_CRAWL_DURATION_MS: z.coerce.number().default(5 * 60 * 1000),
  PAGE_NAV_TIMEOUT_MS: z.coerce.number().default(30000),
  CRAWL_CONCURRENCY: z.coerce.number().default(3),
  ALLOWED_PROTOCOLS: z.string().default('http:,https:').transform(val => val.split(',').map(s => s.trim())),
  ALLOW_SUBDOMAINS: z.preprocess(
    val => val === 'true' || val === true,
    z.boolean()
  ).default(false),
  DOWNLOAD_TTL_MS: z.coerce.number().default(24 * 60 * 60 * 1000),
  RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().default(5),
});

const result = configSchema.safeParse(process.env);

if (!result.success) {
  console.error('Configuration validation failed:', result.error.format());
  process.exit(1);
}

module.exports = result.data;
