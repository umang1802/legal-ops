import { createServer, type Server } from 'node:http';
import { hash } from '@node-rs/argon2';
import type { Role } from '@legalops/types';
import { pino } from 'pino';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import type { Deps } from '../src/deps.js';
import { NoopCourtProvider } from '../src/integrations/courts/noop-provider.js';
import { DisabledEmailProvider } from '../src/modules/notifications/providers.js';
import type { RateLimits } from '../src/modules/auth/auth.routes.js';

export const PASSWORD = 'correct-horse-battery';
let passwordHash: Promise<string> | undefined;

const env = loadEnv();
export const pool = createPool(env.DATABASE_URL);
export const deps: Deps = { pool, env, log: pino({ level: 'silent' }), courts: new NoopCourtProvider(), email: new DisabledEmailProvider() };

const servers: Server[] = [];

/**
 * One real listening server per app. supertest's default (a fresh ephemeral server per request)
 * intermittently mixes up keep-alive sockets under load ("Parse Error: Expected HTTP/").
 */
export function buildApp(
  rateLimits: Partial<RateLimits> = { loginPerWindow: 1000, resetPerWindow: 1000 },
): Server {
  const server = createServer(createApp(deps, { rateLimits })).listen(0);
  servers.push(server);
  return server;
}

// Global reference rows (organization_id IS NULL) inserted by migrations, restored after each wipe.
let globalCourts: Record<string, unknown>[] | undefined;
let systemTemplates: Record<string, unknown>[] | undefined;

/** Call at the top of each test file: clean tables between tests, close the pool at the end. */
export function useDatabase(): void {
  beforeEach(async () => {
    globalCourts ??= (await pool.query('SELECT * FROM courts WHERE organization_id IS NULL')).rows;
    systemTemplates ??= (await pool.query('SELECT * FROM email_templates WHERE organization_id IS NULL')).rows;
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    );
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO courts SELECT * FROM json_populate_recordset(NULL::courts, $1::json)`, [
      JSON.stringify(globalCourts),
    ]);
    await pool.query(
      `INSERT INTO email_templates SELECT * FROM json_populate_recordset(NULL::email_templates, $1::json)`,
      [JSON.stringify(systemTemplates)],
    );
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await pool.end();
  });
}

export type Firm = { orgId: string; users: Record<string, { userId: string; memberId: string }> };

export async function createFirm(name: string, members: { email: string; role: Role }[]): Promise<Firm> {
  passwordHash ??= hash(PASSWORD);
  const ph = await passwordHash;
  const org = await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [
    name,
  ]);
  const orgId = org.rows[0]!.id;
  const users: Firm['users'] = {};
  for (const m of members) {
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [m.email, ph, m.email.split('@')[0]],
    );
    const mem = await pool.query<{ id: string }>(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [orgId, u.rows[0]!.id, m.role],
    );
    users[m.email] = { userId: u.rows[0]!.id, memberId: mem.rows[0]!.id };
  }
  return { orgId, users };
}

export type Session = { agent: TestAgent; csrf: string };

/** Logs in and returns a cookie-carrying agent plus the CSRF token for mutations. */
export async function loginAs(app: Server, email: string): Promise<Session> {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200)
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.data.csrfToken as string };
}

/** Firm-local today (Asia/Kolkata default) and day arithmetic on 'YYYY-MM-DD' strings. */
export async function orgTodayFor(orgId: string): Promise<string> {
  const { rows } = await pool.query<{ d: string }>(
    `SELECT ((now() AT TIME ZONE timezone)::date)::text AS d FROM organizations WHERE id = $1`,
    [orgId],
  );
  return rows[0]!.d;
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Standard practice fixture: firm with owner, two lawyers, clerk, finance, read-only; one matter
 * (lead l1, clerk support) with one case; plus a second matter only the owner can see (lead: owner).
 */
export async function practiceFixture(app: Server) {
  const firm = await createFirm('Firm A', [
    { email: 'owner@a.test', role: 'owner' },
    { email: 'l1@a.test', role: 'lawyer' },
    { email: 'l2@a.test', role: 'lawyer' },
    { email: 'clerk@a.test', role: 'staff' },
    { email: 'finance@a.test', role: 'finance' },
    { email: 'viewer@a.test', role: 'read_only' },
  ]);
  const uid = (e: string) => firm.users[e]!.userId;
  const c = await pool.query<{ id: string }>(
    `INSERT INTO clients (organization_id, name) VALUES ($1, 'Raj Sharma') RETURNING id`,
    [firm.orgId],
  );
  const owner = await loginAs(app, 'owner@a.test');
  const make = async (title: string, lead: string, staff: string[] = []) => {
    const res = await owner.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', owner.csrf)
      .send({
        clientId: c.rows[0]!.id,
        title,
        leadUserId: uid(lead),
        staffUserIds: staff.map(uid),
        initialCase: { title: `${title} case`, caseNumber: `CS ${title.length}/2026` },
      });
    if (res.status !== 201) throw new Error(`fixture matter failed: ${JSON.stringify(res.body)}`);
    return { matterId: res.body.data.id as string, caseId: res.body.data.cases[0].id as string };
  };
  const main = await make('Sharma v ABC', 'l1@a.test', ['clerk@a.test']);
  const privateMatter = await make('Partner only', 'owner@a.test');
  return { firm, uid, owner, main, privateMatter, today: await orgTodayFor(firm.orgId) };
}
