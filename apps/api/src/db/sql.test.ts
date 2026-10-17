import { describe, expect, it } from 'vitest';
import { sql } from './sql.js';

describe('sql builder', () => {
  it('binds every value as a parameter', () => {
    const evil = "x'; DROP TABLE users; --";
    expect(sql`SELECT * FROM users WHERE email = ${evil}`.toQuery()).toEqual({
      text: 'SELECT * FROM users WHERE email = $1',
      values: [evil],
    });
  });

  it('renumbers parameters across nested fragments', () => {
    const inner = sql`m.id IN (SELECT matter_id FROM matter_staff WHERE user_id = ${'u1'})`;
    const q = sql`SELECT * FROM matters m WHERE m.organization_id = ${'org1'} AND ${inner} AND m.status = ${'active'}`;
    expect(q.toQuery()).toEqual({
      text: 'SELECT * FROM matters m WHERE m.organization_id = $1 AND m.id IN (SELECT matter_id FROM matter_staff WHERE user_id = $2) AND m.status = $3',
      values: ['org1', 'u1', 'active'],
    });
  });

  it('joins fragments and inlines trusted raw identifiers', () => {
    const sets = [sql`${sql.raw('name')} = ${'A'}`, sql`${sql.raw('city')} = ${'B'}`];
    expect(sql`UPDATE t SET ${sql.join(sets)} WHERE id = ${1}`.toQuery()).toEqual({
      text: 'UPDATE t SET name = $1, city = $2 WHERE id = $3',
      values: ['A', 'B', 1],
    });
  });
});
