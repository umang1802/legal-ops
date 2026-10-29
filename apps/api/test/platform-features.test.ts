import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

const patch = (s: PlatformSession, path: string, body: object) => s.agent.patch(`${P}${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function setup() {
  const { secret } = await createPlatformAdmin('ops@lfx.test');
  const ops = await platformLogin(app, 'ops@lfx.test', secret);
  const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
  return { ops, orgId };
}

const auditCount = async (action: string, orgId: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM platform_audit_logs WHERE action = $1 AND organization_id = $2`, [action, orgId])).rows[0].n as number;

describe('platform: per-firm features', () => {
  it('lists every feature as on by default', async () => {
    const { ops, orgId } = await setup();
    const res = await ops.agent.get(`${P}/firms/${orgId}/features`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
    expect(res.body.data.every((f: { enabled: boolean; isDefault: boolean }) => f.enabled && f.isDefault)).toBe(true);
  });

  it('switching a feature off takes effect for the firm and is audited', async () => {
    const { ops, orgId } = await setup();
    const res = await patch(ops, `/firms/${orgId}/features/billing`, { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data.find((f: { key: string }) => f.key === 'billing')).toMatchObject({ enabled: false, isDefault: false, setBy: 'Ops' });

    const owner = await loginAs(app, 'owner@a.test');
    expect((await owner.agent.get('/api/v1/invoices')).status).toBe(404);

    const firm = await ops.agent.get(`${P}/firms/${orgId}`);
    expect(firm.body.data.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'firm.feature_disabled', details: { feature: 'billing' } })]),
    );
  });

  it('setting a feature to the value it already has pins it, and is audited once', async () => {
    const { ops, orgId } = await setup();
    expect((await patch(ops, `/firms/${orgId}/features/documents`, { enabled: true })).status).toBe(200);
    expect(await auditCount('firm.feature_enabled', orgId)).toBe(1);
    const list = (await ops.agent.get(`${P}/firms/${orgId}/features`)).body.data;
    expect(list.find((f: { key: string }) => f.key === 'documents')).toMatchObject({ enabled: true, isDefault: false });
  });

  it('refuses unknown features, unknown firms and bad bodies', async () => {
    const { ops, orgId } = await setup();
    expect((await patch(ops, `/firms/${orgId}/features/nonsense`, { enabled: false })).status).toBe(422);
    expect((await patch(ops, `/firms/${orgId}/features/billing`, { enabled: 'no' })).status).toBe(422);
    expect((await patch(ops, `/firms/00000000-0000-4000-8000-000000000000/features/billing`, { enabled: false })).status).toBe(404);
    expect((await ops.agent.get(`${P}/firms/00000000-0000-4000-8000-000000000000/features`)).status).toBe(404);
  });

  it('needs a CSRF token and a fully verified (MFA) platform session', async () => {
    const { ops, orgId } = await setup();
    expect((await ops.agent.patch(`${P}/firms/${orgId}/features/billing`).send({ enabled: false })).status).toBe(403);
    const halfway = request.agent(app);
    const login = await halfway.post(`${P}/auth/login`).send({ email: 'ops@lfx.test', password: PASSWORD });
    const res = await halfway.patch(`${P}/firms/${orgId}/features/billing`).set('X-CSRF-Token', login.body.data.csrfToken).send({ enabled: false });
    expect(res.status).toBe(401);
    expect(await auditCount('firm.feature_disabled', orgId)).toBe(0);
  });

  it('works while the firm is suspended', async () => {
    const { ops, orgId } = await setup();
    await pool.query(`UPDATE organizations SET status = 'suspended', suspended_at = now() WHERE id = $1`, [orgId]);
    expect((await patch(ops, `/firms/${orgId}/features/diary`, { enabled: false })).status).toBe(200);
  });
});
