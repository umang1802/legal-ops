/**
 * Creates a LexForgeX platform admin, or resets one (--reset: new password, TOTP cleared, sessions revoked).
 * Prints the one-time password once. Usage:
 *   pnpm --filter @legalops/api platform:create-admin -- --email ops@lexforgex.com --name "Ops" [--reset]
 */
import { parseArgs } from 'node:util';
import { emailSchema } from '@legalops/validation';
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { createOrResetAdmin } from '../modules/platform/platform-auth.service.js';

// `pnpm … -- --email x` forwards the `--` separator; drop it so the flags parse as options.
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { email: { type: 'string' }, name: { type: 'string' }, reset: { type: 'boolean', default: false } } });
const email = emailSchema.parse(values.email);
const name = (values.name ?? '').trim();
if (!name) throw new Error('--name is required');

const pool = createPool(loadEnv().DATABASE_URL);
try {
  const { password, created } = await createOrResetAdmin(pool, { email, name, reset: values.reset ?? false });
  console.log(`${created ? 'Created' : 'Reset'} platform admin ${email}.`);
  console.log(`One-time password (shown once): ${password}`);
  console.log('They will set up two-factor sign-in on first login at /platform/login.');
} finally {
  await pool.end();
}
