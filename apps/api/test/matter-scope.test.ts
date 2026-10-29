import { FEATURE_KEYS, type Role } from '@legalops/types';
import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { sql } from '../src/db/sql.js';
import { assertMatterVisible, matterVisible } from '../src/modules/access/matter-scope.js';
import { createFirm, pool, useDatabase } from './helpers.js';

useDatabase();

/** decisions.md D-004: assigned-only for lawyer/staff/read_only; one matter can have many assignees. */
describe('matter visibility', () => {
  async function setup() {
    const firm = await createFirm('Firm A', [
      { email: 'owner@a.test', role: 'owner' },
      { email: 'finance@a.test', role: 'finance' },
      { email: 'l1@a.test', role: 'lawyer' },
      { email: 'l2@a.test', role: 'lawyer' },
      { email: 'clerk@a.test', role: 'staff' },
      { email: 'viewer@a.test', role: 'read_only' },
    ]);
    const other = await createFirm('Firm B', [{ email: 'lawyer@b.test', role: 'lawyer' }]);
    const client = await pool.query(
      `INSERT INTO clients (organization_id, name) VALUES ($1, 'C') RETURNING id`,
      [firm.orgId],
    );
    const mk = async (title: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO matters (organization_id, client_id, title) VALUES ($1, $2, $3) RETURNING id`,
          [firm.orgId, client.rows[0].id, title],
        )
      ).rows[0]!.id;
    const shared = await mk('Shared');
    const onlyL1 = await mk('Only L1');
    const nobody = await mk('Unassigned');
    const assign = (matterId: string, email: string, role = 'support') =>
      pool.query(
        `INSERT INTO matter_staff (organization_id, matter_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [firm.orgId, matterId, firm.users[email]!.userId, role],
      );
    await assign(shared, 'l1@a.test', 'lead');
    await assign(shared, 'l2@a.test', 'associate');
    await assign(shared, 'clerk@a.test');
    await assign(onlyL1, 'l1@a.test', 'lead');
    return { firm, other, matters: { shared, onlyL1, nobody } };
  }

  async function visibleTitles(orgId: string, userId: string, role: Role) {
    const ctx = { organizationId: orgId, userId, role, features: FEATURE_KEYS };
    const rows = await query<{ title: string }>(
      pool,
      sql`SELECT m.title FROM matters m
          WHERE m.organization_id = ${orgId} AND ${matterVisible(ctx, sql.raw('m.id'))} ORDER BY m.title`,
    );
    return rows.map((r) => r.title);
  }

  it('owner and finance see every matter in the firm', async () => {
    const { firm } = await setup();
    for (const [email, role] of [
      ['owner@a.test', 'owner'],
      ['finance@a.test', 'finance'],
    ] as const) {
      expect(await visibleTitles(firm.orgId, firm.users[email]!.userId, role)).toEqual([
        'Only L1',
        'Shared',
        'Unassigned',
      ]);
    }
  });

  it('a matter assigned to several people is visible to each of them', async () => {
    const { firm } = await setup();
    expect(await visibleTitles(firm.orgId, firm.users['l1@a.test']!.userId, 'lawyer')).toEqual([
      'Only L1',
      'Shared',
    ]);
    expect(await visibleTitles(firm.orgId, firm.users['l2@a.test']!.userId, 'lawyer')).toEqual(['Shared']);
    expect(await visibleTitles(firm.orgId, firm.users['clerk@a.test']!.userId, 'staff')).toEqual(['Shared']);
  });

  it('unassigned lawyer/read_only users see nothing', async () => {
    const { firm } = await setup();
    expect(await visibleTitles(firm.orgId, firm.users['viewer@a.test']!.userId, 'read_only')).toEqual([]);
  });

  it('assertMatterVisible returns 404 for unassigned and cross-firm matters', async () => {
    const { firm, other, matters } = await setup();
    const l2 = {
      organizationId: firm.orgId,
      userId: firm.users['l2@a.test']!.userId,
      role: 'lawyer' as const,
      features: FEATURE_KEYS,
    };
    await expect(assertMatterVisible(pool, l2, matters.shared)).resolves.toBeUndefined();
    await expect(assertMatterVisible(pool, l2, matters.onlyL1)).rejects.toMatchObject({ status: 404 });

    const outsider = {
      organizationId: other.orgId,
      userId: other.users['lawyer@b.test']!.userId,
      role: 'owner' as const,
      features: FEATURE_KEYS,
    };
    await expect(assertMatterVisible(pool, outsider, matters.shared)).rejects.toMatchObject({ status: 404 });
  });

  it('only one lead per matter', async () => {
    const { firm, matters } = await setup();
    await expect(
      pool.query(`UPDATE matter_staff SET role = 'lead' WHERE matter_id = $1 AND user_id = $2`, [
        matters.shared,
        firm.users['l2@a.test']!.userId,
      ]),
    ).rejects.toThrow();
  });
});
