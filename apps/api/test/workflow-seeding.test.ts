import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS, ensureDefaultsOnce } from '../src/modules/workflows/defaults.js';
import { createFirm, pool, useDatabase } from './helpers.js';

useDatabase();

// Sorted in JS, not SQL: Postgres collation orders '_' differently from Array.prototype.sort.
const keysOf = async (orgId: string) =>
  (await pool.query<{ system_key: string }>(`SELECT system_key FROM workflows WHERE organization_id = $1`, [orgId])).rows.map((r) => r.system_key).sort();
const ORIGINAL_13 = DEFAULT_WORKFLOWS.map((d) => d.key).filter((k) => k !== 'hearing_1d_team' && k !== 'hearing_morning_client');

describe('default automation seeding', () => {
  it('a new firm gets every default once; running again adds nothing', async () => {
    const { orgId } = await createFirm('New', [{ email: 'o@new.test', role: 'owner' }]);
    await ensureDefaultsOnce(pool, orgId);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).toEqual(DEFAULT_WORKFLOWS.map((d) => d.key).sort());
    expect(DEFAULT_WORKFLOWS).toHaveLength(15);
  });

  it('an already-seeded firm gets only the two new defaults', async () => {
    const { orgId } = await createFirm('Old', [{ email: 'o@old.test', role: 'owner' }]);
    await pool.query(`UPDATE organizations SET settings = jsonb_build_object('seededWorkflowKeys', $2::jsonb) WHERE id = $1`, [orgId, JSON.stringify(ORIGINAL_13)]);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).toEqual(['hearing_1d_team', 'hearing_morning_client']);
  });

  it('deleted default: a recipe the firm removed never comes back', async () => {
    const { orgId } = await createFirm('Picky', [{ email: 'o@picky.test', role: 'owner' }]);
    await ensureDefaultsOnce(pool, orgId);
    await pool.query(`DELETE FROM workflows WHERE organization_id = $1 AND system_key = 'hearing_1d_client'`, [orgId]);
    await ensureDefaultsOnce(pool, orgId);
    expect(await keysOf(orgId)).not.toContain('hearing_1d_client');
  });
});
