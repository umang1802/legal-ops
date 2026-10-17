import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, pool, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('global search', () => {
  it('finds clients, matters and cases by name, case number and CNR, respecting visibility and tenancy', async () => {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'l1@a.test', role: 'lawyer' },
      { email: 'l2@a.test', role: 'lawyer' },
    ]);
    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const owner = await loginAs(app, 'owner@a.test');
    const client = await owner.agent
      .post('/api/v1/clients')
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'ABC Industries Pvt Ltd', phone: '9811122233' });
    await owner.agent
      .post('/api/v1/matters')
      .set('X-CSRF-Token', owner.csrf)
      .send({
        clientId: client.body.data.id,
        title: 'ABC Contract Dispute',
        leadUserId: firm.users['l1@a.test']!.userId,
        initialCase: { title: 'ABC v XYZ', caseNumber: 'ARB 45/2026', cnr: 'DLHC010000452026' },
      });

    const search = async (email: string, q: string) =>
      (await (await loginAs(app, email)).agent.get('/api/v1/search').query({ q })).body.data;

    const asOwner = await search('owner@a.test', 'ABC');
    expect(asOwner.clients).toHaveLength(1);
    expect(asOwner.matters).toHaveLength(1);
    expect((await search('owner@a.test', 'ARB 45')).cases).toHaveLength(1);
    expect((await search('owner@a.test', 'dlhc0100004')).cases).toHaveLength(1);
    expect((await search('owner@a.test', '98111')).clients).toHaveLength(1);

    // l2 is not on the matter: sees the client (directory) but not the matter or its case.
    const asL2 = await search('l2@a.test', 'ABC');
    expect(asL2.clients).toHaveLength(1);
    expect(asL2.matters).toHaveLength(0);
    expect(asL2.cases).toHaveLength(0);

    // Another firm sees nothing.
    const asB = await search('owner@b.test', 'ABC');
    expect([asB.clients, asB.matters, asB.cases, asB.invoices].every((r) => r.length === 0)).toBe(true);

    const short = await owner.agent.get('/api/v1/search').query({ q: 'a' });
    expect(short.status).toBe(422);
    void pool;
  });
});
