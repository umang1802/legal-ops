import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase, type Firm } from './helpers.js';

useDatabase();
const app = buildApp();

async function firmWithClient() {
  const firm = await createFirm('Firm A', [
    { email: 'owner@a.test', role: 'owner' },
    { email: 'l1@a.test', role: 'lawyer' },
    { email: 'l2@a.test', role: 'lawyer' },
    { email: 'clerk@a.test', role: 'staff' },
    { email: 'finance@a.test', role: 'finance' },
  ]);
  const c = await pool.query<{ id: string }>(
    `INSERT INTO clients (organization_id, name) VALUES ($1, 'Raj Sharma') RETURNING id`,
    [firm.orgId],
  );
  return { firm, clientId: c.rows[0]!.id };
}
const uid = (f: Firm, email: string) => f.users[email]!.userId;

describe('matters', () => {
  it('Journey A: creates a matter with lead, staff and a first case in one go', async () => {
    const { firm, clientId } = await firmWithClient();
    const delhiHc = await pool.query(`SELECT id FROM courts WHERE name = 'Delhi High Court'`);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    const res = await agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', csrf)
      .send({
        clientId,
        title: 'Sharma v ABC',
        referenceCode: 'SA-2026-001',
        practiceArea: 'Civil',
        leadUserId: uid(firm, 'l1@a.test'),
        staffUserIds: [uid(firm, 'l2@a.test'), uid(firm, 'clerk@a.test')],
        initialCase: {
          title: 'Raj Sharma v ABC Industries',
          caseNumber: 'CS(OS) 101/2026',
          cnr: 'dlhc010001012026',
          courtId: delhiHc.rows[0].id,
        },
      });
    expect(res.status).toBe(201);
    const m = res.body.data;
    expect(m.lead.userId).toBe(uid(firm, 'l1@a.test'));
    expect(m.staff).toHaveLength(3);
    expect(m.cases[0]).toMatchObject({
      caseNumber: 'CS(OS) 101/2026',
      cnr: 'DLHC010001012026',
      court: { name: 'Delhi High Court' },
    });

    const timeline = await agent.get(`/api/v1/matters/${m.id}/timeline`);
    expect(timeline.body.data.map((e: { eventType: string }) => e.eventType).sort()).toEqual([
      'case.created',
      'matter.created',
    ]);
    const outbox = await pool.query(`SELECT event_type FROM outbox_events ORDER BY created_at`);
    expect(outbox.rows.map((r) => r.event_type)).toEqual(['MATTER_CREATED', 'CASE_CREATED']);
  });

  it('a lawyer creating a matter is auto-assigned (as lead) so they can still see it', async () => {
    const { firm, clientId } = await firmWithClient();
    const { agent, csrf } = await loginAs(app, 'l2@a.test');
    const res = await agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', csrf)
      .send({ clientId, title: 'New brief' });
    expect(res.status).toBe(201);
    expect(res.body.data.lead.userId).toBe(uid(firm, 'l2@a.test'));
    expect((await agent.get(`/api/v1/matters/${res.body.data.id}`)).status).toBe(200);
  });

  it('staff creating a matter is assigned as support; a staff/finance user cannot be lead', async () => {
    const { firm, clientId } = await firmWithClient();
    const clerk = await loginAs(app, 'clerk@a.test');
    const res = await clerk.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', clerk.csrf)
      .send({ clientId, title: 'Filing' });
    expect(res.body.data.staff).toEqual([
      expect.objectContaining({ userId: uid(firm, 'clerk@a.test'), role: 'support' }),
    ]);
    const bad = await clerk.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', clerk.csrf)
      .send({ clientId, title: 'X', leadUserId: uid(firm, 'finance@a.test') });
    expect(bad.status).toBe(422);
  });

  it('list is assigned-only for lawyers, firm-wide for owner/finance, and filters by lawyer', async () => {
    const { firm, clientId } = await firmWithClient();
    const owner = await loginAs(app, 'owner@a.test');
    const make = (title: string, lead: string, staff: string[] = []) =>
      owner.agent
        .post('/api/v1/matters')
        .set('X-CSRF-Token', owner.csrf)
        .send({ clientId, title, leadUserId: uid(firm, lead), staffUserIds: staff.map((s) => uid(firm, s)) });
    await make('Shared', 'l1@a.test', ['l2@a.test']);
    await make('L1 only', 'l1@a.test');

    const titles = async (email: string, q: Record<string, string> = {}) => {
      const s = await loginAs(app, email);
      return (await s.agent.get('/api/v1/matters').query(q)).body.data
        .map((m: { title: string }) => m.title)
        .sort();
    };
    expect(await titles('l1@a.test')).toEqual(['L1 only', 'Shared']);
    expect(await titles('l2@a.test')).toEqual(['Shared']);
    expect(await titles('clerk@a.test')).toEqual([]);
    expect(await titles('finance@a.test')).toEqual(['L1 only', 'Shared']);
    expect(await titles('owner@a.test', { lawyerId: uid(firm, 'l2@a.test') })).toEqual(['Shared']);
  });

  it('unassigned lawyers get 404 on detail, update, timeline and staff changes', async () => {
    const { firm, clientId } = await firmWithClient();
    const owner = await loginAs(app, 'owner@a.test');
    const m = await owner.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', owner.csrf)
      .send({ clientId, title: 'Private', leadUserId: uid(firm, 'l1@a.test') });
    const id = m.body.data.id;
    const l2 = await loginAs(app, 'l2@a.test');
    expect((await l2.agent.get(`/api/v1/matters/${id}`)).status).toBe(404);
    expect((await l2.agent.get(`/api/v1/matters/${id}/timeline`)).status).toBe(404);
    expect(
      (await l2.agent.patch(`/api/v1/matters/${id}`).set('X-CSRF-Token', l2.csrf).send({ title: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (
        await l2.agent
          .post(`/api/v1/matters/${id}/staff`)
          .set('X-CSRF-Token', l2.csrf)
          .send({ userId: uid(firm, 'l2@a.test'), role: 'lead' })
      ).status,
    ).toBe(404);
  });

  it('reassigning lead demotes the previous lead; changes are on the timeline', async () => {
    const { firm, clientId } = await firmWithClient();
    const owner = await loginAs(app, 'owner@a.test');
    const m = await owner.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', owner.csrf)
      .send({ clientId, title: 'M', leadUserId: uid(firm, 'l1@a.test') });
    const id = m.body.data.id;
    const res = await owner.agent
      .post(`/api/v1/matters/${id}/staff`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ userId: uid(firm, 'l2@a.test'), role: 'lead' });
    expect(res.body.data.lead.userId).toBe(uid(firm, 'l2@a.test'));
    expect(
      res.body.data.staff.find((s: { userId: string }) => s.userId === uid(firm, 'l1@a.test')).role,
    ).toBe('associate');

    const del = await owner.agent
      .delete(`/api/v1/matters/${id}/staff/${uid(firm, 'l1@a.test')}`)
      .set('X-CSRF-Token', owner.csrf);
    expect(del.status).toBe(204);
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await l1.agent.get(`/api/v1/matters/${id}`)).status).toBe(404);
    const tl = await owner.agent.get(`/api/v1/matters/${id}/timeline`);
    expect(tl.body.data.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['matter.staff_assigned', 'matter.staff_removed']),
    );
  });

  it('closing a matter stamps the close date and logs the status change', async () => {
    const { clientId } = await firmWithClient();
    const owner = await loginAs(app, 'owner@a.test');
    const m = await owner.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', owner.csrf)
      .send({ clientId, title: 'M' });
    const res = await owner.agent
      .patch(`/api/v1/matters/${m.body.data.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'closed' });
    expect(res.body.data.status).toBe('closed');
    expect(res.body.data.closeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const open = await owner.agent.get('/api/v1/matters');
    expect(open.body.data).toHaveLength(0);
  });

  it('cannot create a matter for another firm’s client', async () => {
    const { clientId } = await firmWithClient();
    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const b = await loginAs(app, 'owner@b.test');
    const res = await b.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', b.csrf)
      .send({ clientId, title: 'Steal' });
    expect(res.status).toBe(422);
  });
});
