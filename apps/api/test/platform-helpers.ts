import type { Server } from 'node:http';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { encryptSecret, platformKey } from '../src/modules/platform/secrets.js';
import { currentStep, generateTotpSecret, totpCode } from '../src/modules/platform/totp.js';
import { deps, PASSWORD, pool } from './helpers.js';

export type PlatformSession = { agent: TestAgent; csrf: string };

/** Inserts a platform admin with PASSWORD; enrolled admins get a known TOTP secret. */
export async function createPlatformAdmin(email: string, opts: { enrolled?: boolean } = { enrolled: true }) {
  const secret = generateTotpSecret();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO platform_admins (email, name, password_hash, totp_secret_enc, totp_enrolled_at)
     VALUES ($1, 'Ops', $2, $3, $4) RETURNING id`,
    [email, await hashPassword(PASSWORD), opts.enrolled ? encryptSecret(platformKey(deps.env), secret) : null, opts.enrolled ? new Date() : null],
  );
  return { id: rows[0]!.id, secret };
}

/** A code for a step no earlier verification can have used (the replay guard rejects reused steps). */
export function freshCode(secret: string, offsetSteps = 0): string {
  return totpCode(secret, currentStep(Date.now()) + offsetSteps);
}

export async function platformLogin(app: Server, email: string, secret: string): Promise<PlatformSession> {
  const agent = request.agent(app);
  const login = await agent.post('/api/v1/platform/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`platform login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const csrf = login.body.data.csrfToken as string;
  const v = await agent.post('/api/v1/platform/auth/totp/verify').set('X-CSRF-Token', csrf).send({ code: freshCode(secret) });
  if (v.status !== 200) throw new Error(`platform TOTP failed: ${v.status} ${JSON.stringify(v.body)}`);
  return { agent, csrf };
}
