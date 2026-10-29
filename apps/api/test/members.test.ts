import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('member management RBAC', () => {
  it('lawyers, staff and finance cannot invite or change members', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'lawyer@a.test', role: 'lawyer' },
      { email: 'finance@a.test', role: 'finance' },
    ]);
    for (const email of ['lawyer@a.test', 'finance@a.test']) {
      const { agent, csrf } = await loginAs(app, email);
      const invite = await agent
        .post('/api/v1/organization/members/invite')
        .set('X-CSRF-Token', csrf)
        .send({ email: 'x@a.test', role: 'staff' });
      expect(invite.status).toBe(403);
      const patch = await agent
        .patch(`/api/v1/organization/members/${firm.users['owner@a.test']!.memberId}`)
        .set('X-CSRF-Token', csrf)
        .send({ role: 'read_only' });
      expect(patch.status).toBe(403);
    }
  });

  it('an admin cannot grant or touch owner access', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'admin@a.test', role: 'admin' },
      { email: 'lawyer@a.test', role: 'lawyer' },
    ]);
    const { agent, csrf } = await loginAs(app, 'admin@a.test');
    const promote = await agent
      .patch(`/api/v1/organization/members/${firm.users['lawyer@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'owner' });
    const demote = await agent
      .patch(`/api/v1/organization/members/${firm.users['owner@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'suspended' });
    const inviteOwner = await agent
      .post('/api/v1/organization/members/invite')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'x@a.test', role: 'owner' });
    expect([promote.status, demote.status, inviteOwner.status]).toEqual([403, 403, 403]);
  });

  it('the last active owner cannot be demoted or removed', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'owner2@a.test', role: 'owner' },
    ]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const first = await agent
      .patch(`/api/v1/organization/members/${firm.users['owner2@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'lawyer' });
    expect(first.status).toBe(200);
    const self = await agent
      .patch(`/api/v1/organization/members/${firm.users['owner@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'lawyer' });
    expect(self.status).toBe(403);
  });

  it('role changes are audited with before/after', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'lawyer@a.test', role: 'lawyer' },
    ]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    await agent
      .patch(`/api/v1/organization/members/${firm.users['lawyer@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'admin' });
    const { rows } = await pool.query(
      `SELECT before_json, after_json, request_id FROM audit_logs WHERE action = 'member.updated'`,
    );
    expect(rows[0].before_json).toEqual({ role: 'lawyer', status: 'active' });
    expect(rows[0].after_json).toEqual({ role: 'admin', status: 'active' });
    expect(rows[0].request_id).toBeTruthy();
  });

  it('removing a member drops their matter assignments', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'lawyer@a.test', role: 'lawyer' },
    ]);
    const client = await pool.query(
      `INSERT INTO clients (organization_id, name) VALUES ($1, 'C') RETURNING id`,
      [firm.orgId],
    );
    const matter = await pool.query(
      `INSERT INTO matters (organization_id, client_id, title) VALUES ($1, $2, 'M') RETURNING id`,
      [firm.orgId, client.rows[0].id],
    );
    await pool.query(`INSERT INTO matter_staff (organization_id, matter_id, user_id) VALUES ($1, $2, $3)`, [
      firm.orgId,
      matter.rows[0].id,
      firm.users['lawyer@a.test']!.userId,
    ]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const res = await agent
      .delete(`/api/v1/organization/members/${firm.users['lawyer@a.test']!.memberId}`)
      .set('X-CSRF-Token', csrf);
    expect(res.status).toBe(204);
    expect((await pool.query('SELECT * FROM matter_staff')).rowCount).toBe(0);
  });
});

describe('organization settings', () => {
  it('GST mode requires a GSTIN whose state prefix matches', async () => {
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const missing = await agent
      .patch('/api/v1/organization')
      .set('X-CSRF-Token', csrf)
      .send({ taxMode: 'gst' });
    expect(missing.status).toBe(422);
    const mismatch = await agent
      .patch('/api/v1/organization')
      .set('X-CSRF-Token', csrf)
      .send({ taxMode: 'gst', gstin: '07AAACS1234A1Z5', stateCode: '27' });
    expect(mismatch.status).toBe(422);
    const ok = await agent
      .patch('/api/v1/organization')
      .set('X-CSRF-Token', csrf)
      .send({ taxMode: 'gst', gstin: '07aaacs1234a1z5', stateCode: '07' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ taxMode: 'gst', gstin: '07AAACS1234A1Z5' });
  });

  it('stores the PIN code separately and rejects a malformed one', async () => {
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const bad = await agent.patch('/api/v1/organization').set('X-CSRF-Token', csrf).send({ pincode: '01234' });
    expect(bad.status).toBe(422);
    const ok = await agent.patch('/api/v1/organization').set('X-CSRF-Token', csrf).send({ pincode: ' 110001 ' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.pincode).toBe('110001');
    const cleared = await agent.patch('/api/v1/organization').set('X-CSRF-Token', csrf).send({ pincode: null });
    expect(cleared.body.data.pincode).toBeNull();
  });

  it('staff cannot change firm settings', async () => {
    await createFirm('Firm A', [{ email: 'staff@a.test', role: 'staff' }]);
    const { agent, csrf } = await loginAs(app, 'staff@a.test');
    expect(
      (await agent.patch('/api/v1/organization').set('X-CSRF-Token', csrf).send({ city: 'X' })).status,
    ).toBe(403);
  });
});
