/**
 * One-off: imports the Vidhimeya firm's billing history from the old invoicing app (a `wrangler d1 export` SQL file)
 * into a LexForgeX firm. Spec §10 of 2026-11-06-billing-vidhimeya-parity-design.md; cutover steps in
 * docs/runbooks/vidhimeya-billing-cutover.md. Usage:
 *   dev:        pnpm --filter @legalops/api import:vidhimeya -- --export vidhimeya.sql --org <orgId> --owner <userEmail> [--dry-run]
 *   production: node apps/api/dist/import-vidhimeya.js --export /import/vidhimeya.sql --org <orgId> --owner <userEmail> [--dry-run]
 *               (inside the app image; the runbook has the exact docker compose command)
 * Exit codes: 0 = imported (or dry run passed), 1 = verification failed (rolled back), 2 = refused or error.
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { loadEnv } from '../config/env.js';
import { createPool, queryOne } from '../db/pool.js';
import { sql } from '../db/sql.js';
import { createDocumentStorage } from '../integrations/storage/s3-storage.js';
import { importVidhimeya } from './vidhimeya/import.js';
import { formatReport } from './vidhimeya/report.js';

// `pnpm … -- --export x` forwards the `--` separator; drop it so the flags parse as options.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    export: { type: 'string' },
    org: { type: 'string' },
    owner: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    sandbox: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});
if (!values.export || !values.org || !values.owner) {
  console.error(
    'Usage: import:vidhimeya --export <file.sql> --org <orgId> --owner <userEmail> [--dry-run] [--sandbox] [--json]',
  );
  process.exit(2);
}

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
let code = 2;
try {
  const owner = await queryOne<{ id: string }>(
    pool,
    sql`SELECT u.id FROM users u JOIN organization_members m ON m.user_id = u.id
        WHERE u.email = ${values.owner} AND m.organization_id = ${values.org} AND m.status = 'active'`,
  );
  if (!owner) throw new Error(`${values.owner} is not an active member of firm ${values.org}`);
  const report = await importVidhimeya(
    { pool, storage: createDocumentStorage(env) },
    {
      exportPath: values.export,
      organizationId: values.org,
      ownerUserId: owner.id,
      dryRun: values['dry-run'] ?? false,
      linkEnvironment: values.sandbox ? 'sandbox' : 'live',
    },
  );
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  code = report.ok ? 0 : 1;
} catch (err) {
  pino().error({ err }, 'import:vidhimeya failed; nothing was written');
  code = 2;
} finally {
  await pool.end();
}
process.exit(code);
