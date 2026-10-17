import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

/** PRD E2E scenario 5 / pilot test 7: organization A cannot reach organization B's data. */
describe('tenant isolation', () => {
  async function twoFirms() {
    const a = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const b = await createFirm('Firm B', [
      { email: 'owner@b.test', role: 'owner' },
      { email: 'lawyer@b.test', role: 'lawyer' },
    ]);
    return { a, b };
  }

  it('member lists only contain the caller’s own firm', async () => {
    await twoFirms();
    const { agent } = await loginAs(app, 'owner@a.test');
    const res = await agent.get('/api/v1/organization/members');
    expect(res.body.data.map((m: { email: string }) => m.email)).toEqual(['owner@a.test']);
  });

  it('cannot modify or remove another firm’s member by id (404, no leakage)', async () => {
    const { b } = await twoFirms();
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const targetId = b.users['lawyer@b.test']!.memberId;
    const patch = await agent
      .patch(`/api/v1/organization/members/${targetId}`)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'read_only' });
    const del = await agent.delete(`/api/v1/organization/members/${targetId}`).set('X-CSRF-Token', csrf);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    const { rows } = await pool.query('SELECT role, status FROM organization_members WHERE id = $1', [
      targetId,
    ]);
    expect(rows[0]).toEqual({ role: 'lawyer', status: 'active' });
  });

  it('ignores an organizationId smuggled in the body', async () => {
    const { b } = await twoFirms();
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const res = await agent
      .patch('/api/v1/organization')
      .set('X-CSRF-Token', csrf)
      .send({ organizationId: b.orgId, name: 'Hijacked' });
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT name FROM organizations WHERE id = $1', [b.orgId]);
    expect(rows[0].name).toBe('Firm B');
  });

  it('cannot switch into a firm without membership', async () => {
    const { b } = await twoFirms();
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const res = await agent
      .post('/api/v1/auth/switch-organization')
      .set('X-CSRF-Token', csrf)
      .send({ organizationId: b.orgId });
    expect(res.status).toBe(403);
    expect((await agent.get('/api/v1/organization')).body.data.name).toBe('Firm A');
  });

  it('a multi-firm user switches context and sees only the active firm', async () => {
    const { a } = await twoFirms();
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       SELECT $1, id, 'read_only' FROM users WHERE email = 'lawyer@b.test'`,
      [a.orgId],
    );
    const { agent, csrf } = await loginAs(app, 'lawyer@b.test');
    const switched = await agent
      .post('/api/v1/auth/switch-organization')
      .set('X-CSRF-Token', csrf)
      .send({ organizationId: a.orgId });
    expect(switched.body.data.organization.name).toBe('Firm A');
    expect(switched.body.data.role).toBe('read_only');
    const members = await agent.get('/api/v1/organization/members');
    expect(members.body.data.map((m: { email: string }) => m.email).sort()).toEqual([
      'lawyer@b.test',
      'owner@a.test',
    ]);
  });
});
