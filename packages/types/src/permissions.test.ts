import { describe, expect, it } from 'vitest';
import { can, permissionsFor } from './permissions.js';
import { ROLES, seesAllMatters } from './roles.js';

describe('permission matrix', () => {
  it('owner and admin hold every permission', () => {
    expect(permissionsFor('owner').length).toBe(permissionsFor('admin').length);
    expect(can('admin', 'users.manage')).toBe(true);
  });

  it('only owner/admin manage users, workflows and templates', () => {
    for (const role of ROLES) {
      const expected = role === 'owner' || role === 'admin';
      expect(can(role, 'users.manage')).toBe(expected);
      expect(can(role, 'workflows.manage')).toBe(expected);
      expect(can(role, 'templates.manage')).toBe(expected);
    }
  });

  it('finance records payments but cannot create matters', () => {
    expect(can('finance', 'payments.record')).toBe(true);
    expect(can('finance', 'matters.create')).toBe(false);
  });

  it('staff and lawyers cannot record payments by default (configurable later)', () => {
    expect(can('staff', 'payments.record')).toBe(false);
    expect(can('lawyer', 'payments.record')).toBe(false);
  });

  it('read_only cannot mutate anything', () => {
    for (const p of permissionsFor('read_only')) expect(p.endsWith('.view')).toBe(true);
  });

  it('matter visibility: owner/admin/finance see all, others assigned-only', () => {
    expect(ROLES.filter(seesAllMatters)).toEqual(['owner', 'admin', 'finance']);
  });
});
