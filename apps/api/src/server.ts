import { pino } from 'pino';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { NoopCourtProvider } from './integrations/courts/noop-provider.js';
import { createDocumentStorage } from './integrations/storage/s3-storage.js';
import { createEmailProvider } from './modules/notifications/providers.js';

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const pool = createPool(env.DATABASE_URL);
const app = createApp({ pool, env, log, courts: new NoopCourtProvider(), email: createEmailProvider(env), storage: createDocumentStorage(env) });

const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, 'LexForgeX API listening'));

const shutdown = (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
