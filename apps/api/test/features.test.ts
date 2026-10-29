import { describe, expect, it } from 'vitest';
import { listFirmFeatures, loadEnabledFeatures, setFirmFeature } from '../src/modules/features/features.service.js';
import { createFirm, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin } from './platform-helpers.js';

useDatabase();

const ALL = ['documents', 'billing', 'communication', 'automations', 'diary', 'calendar_sync'];

describe('feature switches: storage', () => {
  it('a firm with no switches set has every launch feature on', async () => {
    const { orgId } = await createFirm('Firm A', []);
    expect(await loadEnabledFeatures(pool, orgId)).toEqual(ALL);
  });

  it('a switch turns a feature off and back on', async () => {
    const { orgId } = await createFirm('Firm A', []);
    const admin = await createPlatformAdmin('ops@lfx.test');
    await setFirmFeature(pool, orgId, 'billing', false, admin.id);
    expect(await loadEnabledFeatures(pool, orgId)).not.toContain('billing');
    await setFirmFeature(pool, orgId, 'billing', true, admin.id);
    expect(await loadEnabledFeatures(pool, orgId)).toContain('billing');
  });

  it('lists each feature with whether it was set, by whom and when', async () => {
    const { orgId } = await createFirm('Firm A', []);
    const admin = await createPlatformAdmin('ops@lfx.test');
    await setFirmFeature(pool, orgId, 'billing', false, admin.id);
    const list = await listFirmFeatures(pool, orgId);
    expect(list.map((f) => f.key)).toEqual(ALL);
    expect(list.find((f) => f.key === 'billing')).toMatchObject({ enabled: false, isDefault: false, setBy: 'Ops', label: 'Billing' });
    expect(list.find((f) => f.key === 'billing')!.setAt).toEqual(expect.any(String));
    expect(list.find((f) => f.key === 'documents')).toMatchObject({ enabled: true, isDefault: true, setBy: null, setAt: null });
  });

  it('ignores stored keys that aren’t features', async () => {
    const { orgId } = await createFirm('Firm A', []);
    await pool.query(`INSERT INTO organization_features (organization_id, feature_key, enabled) VALUES ($1, 'retired_thing', true)`, [orgId]);
    expect(await loadEnabledFeatures(pool, orgId)).toEqual(ALL);
    expect((await listFirmFeatures(pool, orgId)).map((f) => f.key)).toEqual(ALL);
  });

  it('one firm’s switches don’t affect another', async () => {
    const a = await createFirm('Firm A', []);
    const b = await createFirm('Firm B', []);
    const admin = await createPlatformAdmin('ops@lfx.test');
    await setFirmFeature(pool, a.orgId, 'documents', false, admin.id);
    expect(await loadEnabledFeatures(pool, b.orgId)).toEqual(ALL);
  });
});
