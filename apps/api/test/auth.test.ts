import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as authService from '../src/modules/auth/auth.service.js';
import { PASSWORD, buildApp, createFirm, deps, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('login / session', () => {
  it('logs in, sets an httpOnly SameSite cookie and returns role-aware /me', async () => {
    await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'Lawyer@A.test', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/lo_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.data.role).toBe('lawyer');
    expect(res.body.data.permissions).toContain('matters.view');
    expect(res.body.data.permissions).not.toContain('users.manage');
    expect(res.body.data.csrfToken).toBeTypeOf('string');
  });

  it('stores only a hash of the session token', async () => {
    await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'lawyer@a.test', password: PASSWORD });
    const token = /lo_sid=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!;
    const { rows } = await pool.query('SELECT id FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(token);
  });

  it('returns the same 401 for unknown email and wrong password', async () => {
    await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'lawyer@a.test', password: 'nope' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@a.test', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login_failed'`,
    );
    expect(audits.rows[0].n).toBe(2);
  });

  it('rejects disabled users and users with no active membership', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'gone@a.test', role: 'lawyer' },
      { email: 'removed@a.test', role: 'staff' },
    ]);
    await pool.query(`UPDATE users SET is_active = false WHERE email = 'gone@a.test'`);
    await pool.query(`UPDATE organization_members SET status = 'removed' WHERE id = $1`, [
      firm.users['removed@a.test']!.memberId,
    ]);
    const disabled = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'gone@a.test', password: PASSWORD });
    const noOrg = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'removed@a.test', password: PASSWORD });
    expect(disabled.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(noOrg.body.error.code).toBe('NO_MEMBERSHIP');
  });

  it('suspending a member cuts off their existing session immediately', async () => {
    const firm = await createFirm('Firm A', [{ email: 'staff@a.test', role: 'staff' }]);
    const { agent } = await loginAs(app, 'staff@a.test');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    await pool.query(`UPDATE organization_members SET status = 'suspended' WHERE id = $1`, [
      firm.users['staff@a.test']!.memberId,
    ]);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const { agent, csrf } = await loginAs(app, 'lawyer@a.test');
    const out = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).send({});
    expect(out.status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    const limited = buildApp({ loginPerWindow: 3 });
    for (let i = 0; i < 3; i++) {
      await request(limited).post('/api/v1/auth/login').send({ email: 'x@a.test', password: 'bad' });
    }
    const res = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email: 'x@a.test', password: 'bad' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('CSRF and content-type protection', () => {
  it('rejects authenticated mutations without the CSRF header', async () => {
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const { agent } = await loginAs(app, 'owner@a.test');
    const res = await agent.patch('/api/v1/organization').send({ city: 'Pune' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects non-JSON mutations (blocks cross-site form posts)', async () => {
    const res = await request(app).post('/api/v1/auth/login').type('form').send('email=a@b.test&password=x');
    expect(res.status).toBe(415);
  });
});

describe('password reset', () => {
  it('never reveals whether an email exists and puts no secret in the outbox', async () => {
    await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'lawyer@a.test' });
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@a.test' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    const { rows } = await pool.query(`SELECT event_type, payload FROM outbox_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('PASSWORD_RESET_REQUESTED');
    expect(Object.keys(rows[0].payload)).toEqual(['userId']);
  });

  it('resets once with a valid token, revokes old sessions, and rejects reuse', async () => {
    const firm = await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const { agent } = await loginAs(app, 'lawyer@a.test');
    const token = await authService.issuePasswordResetToken(deps, firm.users['lawyer@a.test']!.userId);

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'a-brand-new-password' });
    expect(reset.status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    const reuse = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'another-password-1' });
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'lawyer@a.test', password: 'a-brand-new-password' });
    expect(login.status).toBe(200);
  });

  it('only the newest reset link works', async () => {
    const firm = await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const userId = firm.users['lawyer@a.test']!.userId;
    const first = await authService.issuePasswordResetToken(deps, userId);
    await authService.issuePasswordResetToken(deps, userId);
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: first, password: 'whatever-password' });
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('email verification', () => {
  it('verifies with a valid token', async () => {
    const firm = await createFirm('Firm A', [{ email: 'lawyer@a.test', role: 'lawyer' }]);
    const userId = firm.users['lawyer@a.test']!.userId;
    const token = await authService.issueEmailVerificationToken(deps, userId);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(204);
    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].email_verified_at).not.toBeNull();
  });
});

describe('invitations', () => {
  it('owner invites -> invitee accepts with a password -> can log in with the invited role', async () => {
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const inv = await agent
      .post('/api/v1/organization/members/invite')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'new.clerk@a.test', role: 'staff' });
    expect(inv.status).toBe(201);
    const token = await authService.issueInvitationToken(deps, inv.body.data.invitationId);

    const accept = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, firstName: 'New', password: 'clerk-password-1' });
    expect(accept.status).toBe(200);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'new.clerk@a.test', password: 'clerk-password-1' });
    expect(login.body.data.role).toBe('staff');

    const again = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, firstName: 'New', password: 'clerk-password-1' });
    expect(again.body.error.code).toBe('TOKEN_INVALID');
  });

  it('an existing account joining a second firm keeps its password', async () => {
    await createFirm('Firm B', [{ email: 'shared@x.test', role: 'lawyer' }]);
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const inv = await agent
      .post('/api/v1/organization/members/invite')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'shared@x.test', role: 'lawyer' });
    const token = await authService.issueInvitationToken(deps, inv.body.data.invitationId);
    const accept = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, firstName: 'X', password: 'attacker-chosen-pw' });
    expect(accept.body.data.existingAccount).toBe(true);
    const old = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'shared@x.test', password: PASSWORD });
    expect(old.status).toBe(200);
    expect(old.body.data.memberships).toHaveLength(2);
  });
});
