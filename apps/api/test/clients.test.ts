import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('clients', () => {
  it('creates a client, normalises the phone and records audit + timeline', async () => {
    await createFirm('Firm A', [{ email: 'clerk@a.test', role: 'staff' }]);
    const { agent, csrf } = await loginAs(app, 'clerk@a.test');
    const res = await agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Raj Sharma', email: 'Raj@Example.com', phone: '098765 43210' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Raj Sharma', email: 'raj@example.com', status: 'active' });
    const { rows } = await pool.query('SELECT phone_e164 FROM clients WHERE id = $1', [res.body.data.id]);
    expect(rows[0].phone_e164).toBe('+919876543210');
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'client.created'`,
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('warns on duplicates (email, phone in another format, similar name) and never merges', async () => {
    await createFirm('Firm A', [{ email: 'clerk@a.test', role: 'staff' }]);
    const { agent, csrf } = await loginAs(app, 'clerk@a.test');
    await agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Raj Sharma', phone: '9876543210' });

    const byPhone = await agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'R. K. Sharma', phone: '+91 98765-43210' });
    expect(byPhone.status).toBe(409);
    expect(byPhone.body.error.code).toBe('DUPLICATE_WARNING');
    expect(byPhone.body.error.details[0].matchedOn).toContain('phone');

    const byName = await agent.post('/api/v1/clients').set('X-CSRF-Token', csrf).send({ name: 'raj sharma' });
    expect(byName.body.error.details[0].matchedOn).toContain('name');

    const forced = await agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Raj Sharma', acknowledgeDuplicates: true });
    expect(forced.status).toBe(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM clients')).rows[0].n).toBe(2);
  });

  it('duplicate detection never looks across firms', async () => {
    await createFirm('Firm A', [{ email: 'a@a.test', role: 'staff' }]);
    await createFirm('Firm B', [{ email: 'b@b.test', role: 'staff' }]);
    const a = await loginAs(app, 'a@a.test');
    const b = await loginAs(app, 'b@b.test');
    await a.agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', a.csrf)
      .send({ name: 'ABC Industries', email: 'x@abc.test' });
    const res = await b.agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', b.csrf)
      .send({ name: 'ABC Industries', email: 'x@abc.test' });
    expect(res.status).toBe(201);
  });

  it('lists with search by name, email or phone digits', async () => {
    await createFirm('Firm A', [{ email: 'clerk@a.test', role: 'staff' }]);
    const { agent, csrf } = await loginAs(app, 'clerk@a.test');
    for (const c of [
      { name: 'Raj Sharma', phone: '9876543210' },
      { name: 'Priya Verma', email: 'priya@verma.test' },
      { name: 'ABC Industries Pvt Ltd', clientType: 'company' },
    ]) {
      await agent.post('/api/v1/clients').set('X-CSRF-Token', csrf).send(c);
    }
    const names = async (q: string) =>
      (await agent.get('/api/v1/clients').query({ search: q })).body.data.map(
        (c: { name: string }) => c.name,
      );
    expect(await names('verma')).toEqual(['Priya Verma']);
    expect(await names('43210')).toEqual(['Raj Sharma']);
    expect(await names('%')).toEqual([]);
    const all = await agent.get('/api/v1/clients').query({ pageSize: 2 });
    expect(all.body.data).toHaveLength(2);
    expect(all.body.meta.total).toBe(3);
  });

  it('read_only cannot create, finance cannot edit; another firm’s client is 404', async () => {
    const a = await createFirm('Firm A', [
      { email: 'viewer@a.test', role: 'read_only' },
      { email: 'finance@a.test', role: 'finance' },
    ]);
    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const client = await pool.query(
      `INSERT INTO clients (organization_id, name) VALUES ($1, 'C') RETURNING id`,
      [a.orgId],
    );
    const viewer = await loginAs(app, 'viewer@a.test');
    expect(
      (await viewer.agent.post('/api/v1/clients').set('X-CSRF-Token', viewer.csrf).send({ name: 'X' }))
        .status,
    ).toBe(403);
    const fin = await loginAs(app, 'finance@a.test');
    expect(
      (
        await fin.agent
          .patch(`/api/v1/clients/${client.rows[0].id}`)
          .set('X-CSRF-Token', fin.csrf)
          .send({ name: 'Y' })
      ).status,
    ).toBe(403);
    const other = await loginAs(app, 'owner@b.test');
    expect((await other.agent.get(`/api/v1/clients/${client.rows[0].id}`)).status).toBe(404);
  });

  it('cannot archive a client with open matters', async () => {
    const a = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const c = await pool.query(`INSERT INTO clients (organization_id, name) VALUES ($1, 'C') RETURNING id`, [
      a.orgId,
    ]);
    await pool.query(`INSERT INTO matters (organization_id, client_id, title) VALUES ($1, $2, 'M')`, [
      a.orgId,
      c.rows[0].id,
    ]);
    const { agent, csrf } = await loginAs(app, 'owner@a.test');
    expect((await agent.delete(`/api/v1/clients/${c.rows[0].id}`).set('X-CSRF-Token', csrf)).status).toBe(
      409,
    );
    await pool.query(`UPDATE matters SET status = 'closed'`);
    expect((await agent.delete(`/api/v1/clients/${c.rows[0].id}`).set('X-CSRF-Token', csrf)).status).toBe(
      204,
    );
  });
});
