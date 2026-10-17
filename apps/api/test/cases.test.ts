import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

async function setup() {
  const firm = await createFirm('Firm A', [
    { email: 'owner@a.test', role: 'owner' },
    { email: 'l1@a.test', role: 'lawyer' },
    { email: 'l2@a.test', role: 'lawyer' },
    { email: 'clerk@a.test', role: 'staff' },
  ]);
  const c = await pool.query(
    `INSERT INTO clients (organization_id, name) VALUES ($1, 'Raj Sharma') RETURNING id`,
    [firm.orgId],
  );
  const owner = await loginAs(app, 'owner@a.test');
  const m = await owner.agent
    .post('/api/v1/matters')
    .set('X-CSRF-Token', owner.csrf)
    .send({
      clientId: c.rows[0].id,
      title: 'Sharma v ABC',
      leadUserId: firm.users['l1@a.test']!.userId,
      staffUserIds: [firm.users['clerk@a.test']!.userId],
    });
  return { firm, owner, matterId: m.body.data.id as string };
}

describe('cases, parties, advocates', () => {
  it('assigned staff can add a case and parties; status changes emit events and timeline', async () => {
    const { matterId, owner } = await setup();
    const clerk = await loginAs(app, 'clerk@a.test');
    const created = await clerk.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', clerk.csrf)
      .send({ matterId, title: 'Raj Sharma v ABC', caseNumber: 'CS 12/2026' });
    expect(created.status).toBe(201);
    const caseId = created.body.data.id;

    const party = await clerk.agent
      .post(`/api/v1/cases/${caseId}/parties`)
      .set('X-CSRF-Token', clerk.csrf)
      .send({ name: 'Raj Sharma', side: 'plaintiff', isClient: true });
    expect(party.status).toBe(201);
    await clerk.agent
      .post(`/api/v1/cases/${caseId}/parties`)
      .set('X-CSRF-Token', clerk.csrf)
      .send({ name: 'ABC Industries Pvt Ltd', side: 'defendant' });

    // Staff can add but not edit (matters.edit) by default.
    const staffEdit = await clerk.agent
      .patch(`/api/v1/cases/${caseId}`)
      .set('X-CSRF-Token', clerk.csrf)
      .send({ status: 'reserved' });
    expect(staffEdit.status).toBe(403);

    const l1 = await loginAs(app, 'l1@a.test');
    const upd = await l1.agent
      .patch(`/api/v1/cases/${caseId}`)
      .set('X-CSRF-Token', l1.csrf)
      .send({ status: 'reserved' });
    expect(upd.body.data.status).toBe('reserved');
    expect(upd.body.data.parties.map((p: { side: string }) => p.side)).toEqual(['plaintiff', 'defendant']);

    const events = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE event_type = 'CASE_STATUS_CHANGED'`,
    );
    expect(events.rows[0].payload).toMatchObject({ before: 'active', after: 'reserved' });
    const tl = await owner.agent.get(`/api/v1/matters/${matterId}/timeline`);
    expect(tl.body.data.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['case.created', 'case.party_added', 'case.status_changed']),
    );
  });

  it('advocates can be added and removed from a case', async () => {
    const { matterId, owner } = await setup();
    const c = await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'Appeal' });
    const caseId = c.body.data.id;
    const adv = await owner.agent
      .post(`/api/v1/cases/${caseId}/advocates`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'K. Mehta', firmName: 'Mehta & Co', side: 'defendant' });
    expect(adv.status).toBe(201);
    const detail = await owner.agent.get(`/api/v1/cases/${caseId}`);
    expect(detail.body.data.advocates).toHaveLength(1);
    const del = await owner.agent
      .delete(`/api/v1/cases/${caseId}/advocates/${adv.body.data.id}`)
      .set('X-CSRF-Token', owner.csrf);
    expect(del.status).toBe(204);
  });

  it('an unassigned lawyer cannot read or add to a case (404)', async () => {
    const { matterId, owner } = await setup();
    const c = await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'Private case' });
    const l2 = await loginAs(app, 'l2@a.test');
    expect((await l2.agent.get(`/api/v1/cases/${c.body.data.id}`)).status).toBe(404);
    expect(
      (
        await l2.agent
          .post(`/api/v1/cases/${c.body.data.id}/parties`)
          .set('X-CSRF-Token', l2.csrf)
          .send({ name: 'X' })
      ).status,
    ).toBe(404);
    expect(
      (await l2.agent.post('/api/v1/cases').set('X-CSRF-Token', l2.csrf).send({ matterId, title: 'Sneak' }))
        .status,
    ).toBe(404);
  });

  it('rejects a duplicate CNR in the firm and a court from another firm', async () => {
    const { matterId, owner } = await setup();
    await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'A', cnr: 'DLHC010000012026' });
    const dup = await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'B', cnr: 'DLHC010000012026' });
    expect(dup.status).toBe(409);

    const b = await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const foreign = await pool.query(
      `INSERT INTO courts (organization_id, name) VALUES ($1, 'Saket District Court') RETURNING id`,
      [b.orgId],
    );
    const res = await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'C', courtId: foreign.rows[0].id });
    expect(res.status).toBe(422);
  });

  it('court refresh reports NOT_CONFIGURED instead of pretending to sync', async () => {
    const { matterId, owner } = await setup();
    const c = await owner.agent
      .post('/api/v1/cases')
      .set('X-CSRF-Token', owner.csrf)
      .send({ matterId, title: 'X' });
    const res = await owner.agent
      .post(`/api/v1/cases/${c.body.data.id}/refresh`)
      .set('X-CSRF-Token', owner.csrf)
      .send({});
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
    const { rows } = await pool.query('SELECT last_synced_at FROM cases WHERE id = $1', [c.body.data.id]);
    expect(rows[0].last_synced_at).toBeNull();
  });

  it('firm-specific courts are listed alongside the global High Courts', async () => {
    const { owner } = await setup();
    const add = await owner.agent
      .post('/api/v1/courts')
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'Saket District Court', city: 'New Delhi' });
    expect(add.status).toBe(201);
    const list = await owner.agent.get('/api/v1/courts').query({ search: 'delhi' });
    const names = list.body.data.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Delhi High Court', 'Saket District Court']));
    const again = await owner.agent
      .post('/api/v1/courts')
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'delhi high court' });
    expect(again.status).toBe(409);
  });
});
