import { hostname } from 'node:os';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import type { Deps } from './deps.js';
import { NoopCourtProvider } from './integrations/courts/noop-provider.js';
import { failInterruptedSends } from './modules/notifications/notifications.service.js';
import { createEmailProvider } from './modules/notifications/providers.js';
import { requeueStuckActions } from './modules/workflows/engine.js';
import { processOutbox, runDueActions, sendDueNotifications } from './modules/workflows/processor.js';

/**
 * Background worker (PRD §10). Postgres is the queue: every claim is a row lock with SKIP LOCKED,
 * so any number of workers can run side by side and a crash loses nothing. (D-012: BullMQ/Redis
 * deferred until volume needs it.)
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL }).child({ proc: 'worker' });
const pool = createPool(env.DATABASE_URL);
const deps: Deps = { pool, env, log, courts: new NoopCourtProvider(), email: createEmailProvider(env) };
const workerId = `${hostname()}:${process.pid}`;

let stopping = false;
let lastSweep = 0;

async function pass() {
  const now = new Date();
  const o = await processOutbox(deps, now, { workerId });
  const a = await runDueActions(deps, now);
  const e = await sendDueNotifications(deps, now);
  if (o.processed || o.failed || Object.keys(a).length || Object.keys(e).length) log.info({ events: o, actions: a, emails: e }, 'worker pass');
  if (Date.now() - lastSweep > 5 * 60_000) {
    lastSweep = Date.now();
    const requeued = await requeueStuckActions(pool);
    const interrupted = await failInterruptedSends(pool);
    if (requeued || interrupted) log.warn({ requeued, interrupted }, 'recovered stuck work');
  }
}

async function loop() {
  log.info({ workerId, email: deps.email.name, pollMs: env.WORKER_POLL_MS }, 'LegalOps worker started');
  while (!stopping) {
    try {
      await pass();
    } catch (err) {
      log.error({ err }, 'worker pass failed');
    }
    await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
  }
  await pool.end();
  log.info('worker stopped');
  process.exit(0);
}

const stop = (signal: string) => {
  log.info({ signal }, 'stopping after current pass');
  stopping = true;
  setTimeout(() => process.exit(1), 30_000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
void loop();
