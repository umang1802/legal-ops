import { describe, expect, it } from 'vitest';
import { canWithFeatures, FEATURES, type FeatureDef, featureLabel, PERMISSION_FEATURE, resolveFeatures } from './features.js';
import { PERMISSIONS } from './permissions.js';

describe('per-firm features', () => {
  it('a firm with no switches set gets every launch feature', () => {
    expect(resolveFeatures({})).toEqual(['documents', 'billing', 'communication', 'automations', 'diary', 'calendar_sync']);
  });

  it('a switch overrides the default, and unknown keys are ignored', () => {
    const on = resolveFeatures({ billing: false, nonsense: true });
    expect(on).not.toContain('billing');
    expect(on).not.toContain('nonsense');
  });

  it('a feature added later is off until switched on', () => {
    const defs: FeatureDef[] = [...FEATURES, { key: 'later', label: 'Later', description: '', defaultEnabled: false }];
    expect(resolveFeatures({}, defs)).not.toContain('later');
    expect(resolveFeatures({ later: true }, defs)).toContain('later');
  });

  it('a permission needs both the role and its feature', () => {
    expect(canWithFeatures('owner', [], 'invoices.manage')).toBe(false);
    expect(canWithFeatures('owner', ['billing'], 'invoices.manage')).toBe(true);
    expect(canWithFeatures('owner', [], 'matters.view')).toBe(true); // core
    expect(canWithFeatures('read_only', ['billing'], 'invoices.manage')).toBe(false);
  });

  it('maps permissions to their features', () => {
    for (const p of PERMISSIONS.filter((x) => x.startsWith('documents.'))) expect(PERMISSION_FEATURE[p]).toBe('documents');
    for (const p of ['billing.view', 'invoices.manage', 'payments.record', 'finance.dashboard'] as const) expect(PERMISSION_FEATURE[p]).toBe('billing');
    for (const p of ['workflows.manage', 'templates.manage'] as const) expect(PERMISSION_FEATURE[p]).toBe('automations');
    expect(PERMISSION_FEATURE['matters.view']).toBeUndefined();
  });

  it('names features for the console, falling back to the key for retired ones', () => {
    expect(featureLabel('diary')).toBe('Diary & printouts');
    expect(featureLabel('retired_thing')).toBe('retired_thing');
  });
});
