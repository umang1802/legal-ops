import request from 'supertest';
import type { FeatureKey } from '@legalops/types';
import { describe, expect, it } from 'vitest';
import { setFirmFeature } from '../src/modules/features/features.service.js';
import { buildApp, createFirm, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';
import { createPlatformAdmin } from './platform-helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const get = (s: Session, path: string, q: Record<string, string | undefined> = {}) => s.agent.get(`/api/v1${path}`).query(q);

async function setup() {
  const fx = await practiceFixture(app);
  const admin = await createPlatformAdmin('ops@lfx.test');
  const set = (key: FeatureKey, enabled: boolean, orgId = fx.firm.orgId) => setFirmFeature(pool, orgId, key, enabled, admin.id);
  const invoice = () =>
    post(fx.owner, '/invoices', { matterId: fx.main.matterId, items: [{ description: 'Professional fees', unitPrice: '5000' }], issue: true });
  return { ...fx, set, invoice };
}

const expectDisabled = (res: { status: number; body: { error?: { code: string; message: string } } }) => {
  expect(res.status).toBe(404);
  expect(res.body.error).toEqual({ code: 'FEATURE_DISABLED', message: 'This isn’t available for your firm.' });
};

describe('per-firm features: the API', () => {
  it('Billing off: reads and writes are 404 FEATURE_DISABLED, even for the owner', async () => {
    const { owner, set, invoice } = await setup();
    await set('billing', false);
    expectDisabled(await get(owner, '/invoices'));
    expectDisabled(await invoice());
  });

  it.each([
    ['documents', '/documents', 'matterId'],
    ['communication', '/notifications', null],
    ['automations', '/workflows', null],
    ['diary', '/hearings/diary', null],
    ['calendar_sync', '/calendar-feed', null],
  ] as const)('%s off: its routes are 404; on: they work', async (key, path, matterParam) => {
    const { owner, main, set } = await setup();
    const q = matterParam ? { [matterParam]: main.matterId } : {};
    expect((await get(owner, path, q)).status).toBe(200);
    await set(key, false);
    expectDisabled(await get(owner, path, q));
    await set(key, true);
    expect((await get(owner, path, q)).status).toBe(200);
  });

  it('a change applies to a signed-in user on their next request', async () => {
    const { owner, set } = await setup();
    expect((await get(owner, '/invoices')).status).toBe(200);
    await set('billing', false);
    expectDisabled(await get(owner, '/invoices'));
  });

  it('switching a feature off and on again keeps the firm’s data', async () => {
    const { owner, set, invoice } = await setup();
    const created = await invoice();
    expect(created.status).toBe(201);
    await set('billing', false);
    await set('billing', true);
    const list = await get(owner, '/invoices');
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(created.body.data.id);
  });

  it('/auth/me lists the features that are on, and leaves out permissions of features that are off', async () => {
    const { owner, set } = await setup();
    await set('billing', false);
    const me = (await get(owner, '/auth/me')).body.data;
    expect(me.features).toEqual(['documents', 'communication', 'automations', 'diary', 'calendar_sync']);
    expect(me.permissions).not.toContain('invoices.manage');
    expect(me.permissions).toContain('matters.view');
  });

  it('role checks still apply when the feature is on', async () => {
    await setup();
    const lawyer = await loginAs(app, 'l1@a.test');
    expect((await post(lawyer, '/invoices', {})).status).toBe(403);
  });

  it('one firm’s switches don’t affect another firm', async () => {
    const { owner, set } = await setup();
    const b = await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    await set('billing', false, b.orgId);
    expect((await get(owner, '/invoices')).status).toBe(200);
  });
});

describe('per-firm features: inside core pages', () => {
  it('Billing off: search leaves out invoices', async () => {
    const { owner, set, invoice } = await setup();
    const number = (await invoice()).body.data.invoiceNumber as string;
    const search = async () => (await get(owner, '/search', { q: number })).body.data.invoices as { invoiceNumber: string }[];
    expect((await search()).map((i) => i.invoiceNumber)).toContain(number);
    await set('billing', false);
    expect(await search()).toEqual([]);
  });

  it('Billing off: the dashboard leaves out money figures', async () => {
    const { owner, set, invoice } = await setup();
    await invoice();
    expect((await get(owner, '/dashboard')).body.data.counts.outstanding).not.toBeNull();
    await set('billing', false);
    const counts = (await get(owner, '/dashboard')).body.data.counts;
    expect(counts.outstanding).toBeNull();
    expect(counts.overdueAmount).toBeNull();
  });

  it('Calendar sync off: existing subscription links stop working, and resume when it’s on', async () => {
    const { owner, set } = await setup();
    const url = (await post(owner, '/calendar-feed')).body.data.url as string;
    const fetchFeed = () => request(app).get(new URL(url).pathname);
    expect((await fetchFeed()).status).toBe(200);
    await set('calendar_sync', false);
    expect((await fetchFeed()).status).toBe(404);
    await set('calendar_sync', true);
    expect((await fetchFeed()).status).toBe(200);
  });
});

describe('per-firm features: activity feeds', () => {
  const types = (items: { eventType: string }[]) => items.map((e) => e.eventType);

  it('Billing off: invoice activity leaves the matter timeline and Home’s recent changes', async () => {
    const { owner, main, set, invoice } = await setup();
    expect((await invoice()).status).toBe(201);
    const timeline = async () => types((await get(owner, `/matters/${main.matterId}/timeline`)).body.data);
    const recent = async () => types((await get(owner, '/dashboard')).body.data.recentChanges);
    expect(await timeline()).toContain('invoice.issued');
    expect(await recent()).toContain('invoice.issued');
    await set('billing', false);
    expect((await timeline()).filter((t) => /^(invoice|payment|fee_agreement|fee_milestone|expense)\./.test(t))).toEqual([]);
    expect((await recent()).filter((t) => /^(invoice|payment)\./.test(t))).toEqual([]);
    expect(await timeline()).toContain('matter.created'); // core activity stays
    await set('billing', true);
    expect(await timeline()).toContain('invoice.issued');
  });

  it('Documents off: document activity leaves the matter timeline', async () => {
    const { owner, main, set } = await setup();
    const start = await post(owner, '/documents/uploads', { matterId: main.matterId, name: 'Plaint.pdf', sizeBytes: 10 });
    storage.simulateBrowserUpload(10);
    await post(owner, `/documents/${start.body.data.documentId}/complete`, { parts: [{ partNumber: 1, etag: '"e"' }] });
    const timeline = async () => types((await get(owner, `/matters/${main.matterId}/timeline`)).body.data);
    expect(await timeline()).toContain('document.uploaded');
    await set('documents', false);
    expect(await timeline()).not.toContain('document.uploaded');
  });
});
