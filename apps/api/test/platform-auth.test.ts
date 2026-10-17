import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createOrResetAdmin } from '../src/modules/platform/platform-auth.service.js';
import { buildApp, createFirm, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, freshCode, platformLogin } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

describe('platform auth', () => {
  it('password alone does not open the console: MFA is required', async () => {
    await createPlatformAdmin('ops@lfx.test');
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ mfaEnrolled: true, mfaVerified: false });
    const firms = await agent.get(`${P}/firms`);
    expect(firms.status).toBe(401);
    expect(firms.body.error.code).toBe('MFA_REQUIRED');
  });

  it('first login enrols TOTP; the first valid code completes enrolment and the session', async () => {
    await createPlatformAdmin('new@lfx.test', { enrolled: false });
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'new@lfx.test', password: PASSWORD });
    expect(login.body.data.mfaEnrolled).toBe(false);
    const csrf = login.body.data.csrfToken;
    const enrol = await agent.post(`${P}/auth/totp/enroll`).set('X-CSRF-Token', csrf).send({});
    expect(enrol.status).toBe(200);
    expect(enrol.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const ok = await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: freshCode(enrol.body.data.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ mfaEnrolled: true, mfaVerified: true });
    expect((await agent.get(`${P}/auth/me`)).body.data.admin.email).toBe('new@lfx.test');
    // Once enrolled, the secret cannot be replaced from a session.
    expect((await agent.post(`${P}/auth/totp/enroll`).set('X-CSRF-Token', csrf).send({})).status).toBe(409);
  });

  it('wrong password and unknown email look the same', async () => {
    await createPlatformAdmin('ops@lfx.test');
    const a = await request(app).post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: 'wrong-password-123' });
    const b = await request(app).post(`${P}/auth/login`).send({ email: 'nobody@lfx.test', password: 'wrong-password-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  it('replay: the same TOTP code cannot be used twice', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const code = freshCode(secret);
    const s1 = request.agent(app);
    const l1 = await s1.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect((await s1.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', l1.body.data.csrfToken).send({ code })).status).toBe(200);
    const s2 = request.agent(app);
    const l2 = await s2.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const again = await s2.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', l2.body.data.csrfToken).send({ code });
    expect(again.status).toBe(401);
  });

  it('realm isolation: a firm session gets nothing from the platform, a platform session nothing from the firm API', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const firm = await loginAs(app, 'owner@a.test');
    expect((await firm.agent.get(`${P}/auth/me`)).status).toBe(401);
    expect((await firm.agent.get(`${P}/firms`)).status).toBe(401);
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    expect((await plat.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await plat.agent.get('/api/v1/clients')).status).toBe(401);
    // The platform cookie is scoped to the platform API path.
    const login = await request(app).post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    expect(String(login.headers['set-cookie'])).toMatch(/lf_psid=.*Path=\/api\/v1\/platform.*HttpOnly.*SameSite=Strict/i);
  });

  it('mutations need the platform CSRF token', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    expect((await plat.agent.post(`${P}/auth/logout`).send({})).status).toBe(403);
    expect((await plat.agent.post(`${P}/auth/logout`).set('X-CSRF-Token', plat.csrf).send({})).status).toBe(204);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('idle sessions expire after 30 minutes', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    await pool.query(`UPDATE platform_sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('a deactivated admin is locked out at once', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const plat = await platformLogin(app, 'ops@lfx.test', secret);
    await pool.query(`UPDATE platform_admins SET is_active = false`);
    expect((await plat.agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('the CLI creates an admin, and --reset issues a new password and clears TOTP', async () => {
    const first = await createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: false });
    expect(first.created).toBe(true);
    expect(first.password).toHaveLength(24);
    await expect(createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: false })).rejects.toThrow(/exists/);
    await pool.query(`UPDATE platform_admins SET totp_enrolled_at = now(), totp_secret_enc = 'x' WHERE email = 'cli@lfx.test'`);
    const again = await createOrResetAdmin(pool, { email: 'cli@lfx.test', name: 'CLI', reset: true });
    expect(again.created).toBe(false);
    const row = (await pool.query(`SELECT totp_secret_enc, totp_enrolled_at FROM platform_admins WHERE email = 'cli@lfx.test'`)).rows[0];
    expect(row).toEqual({ totp_secret_enc: null, totp_enrolled_at: null });
  });

  it('lockout: five wrong codes lock two-factor sign-in for 15 minutes and end the password-only session', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const csrf = login.body.data.csrfToken;
    for (let i = 0; i < 4; i++) {
      expect((await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: '000000' })).status).toBe(401);
    }
    const fifth = await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: '000000' });
    expect(fifth.status).toBe(429);
    expect((await agent.get(`${P}/auth/me`)).status).toBe(401); // session ended
    // Even the right code from a fresh login is refused while locked.
    const again = request.agent(app);
    const l2 = await again.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const locked = await again.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', l2.body.data.csrfToken).send({ code: freshCode(secret) });
    expect(locked.status).toBe(429);
    const actions = (await pool.query(`SELECT action FROM platform_audit_logs ORDER BY id`)).rows.map((r) => r.action);
    expect(actions.filter((a) => a === 'admin.mfa_failed')).toHaveLength(5);
    expect(actions).toContain('admin.mfa_locked');
  });

  it('a correct code resets the failure count', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const agent = request.agent(app);
    const login = await agent.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const csrf = login.body.data.csrfToken;
    for (let i = 0; i < 4; i++) await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: '000000' });
    expect((await agent.post(`${P}/auth/totp/verify`).set('X-CSRF-Token', csrf).send({ code: freshCode(secret) })).status).toBe(200);
    expect((await pool.query(`SELECT failed_totp_attempts FROM platform_admins`)).rows[0].failed_totp_attempts).toBe(0);
  });

  it('a password-only session expires after 10 minutes', async () => {
    await createPlatformAdmin('ops@lfx.test');
    const agent = request.agent(app);
    await agent.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    await pool.query(`UPDATE platform_sessions SET created_at = now() - interval '11 minutes'`);
    expect((await agent.get(`${P}/auth/me`)).status).toBe(401);
  });

  it('a wrong password for a real admin is audited', async () => {
    await createPlatformAdmin('ops@lfx.test');
    await request(app).post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: 'wrong-password-123' });
    expect((await pool.query(`SELECT action FROM platform_audit_logs`)).rows.map((r) => r.action)).toEqual(['admin.login_failed']);
  });
});
