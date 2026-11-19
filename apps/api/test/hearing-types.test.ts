import { HEARING_TYPES } from '@legalops/types';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildApp,
  createFirm,
  loginAs,
  pool,
  practiceFixture,
  type Session,
  useDatabase,
} from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const types = async (s: Session) =>
  (await s.agent.get('/api/v1/hearing-types')).body.data as {
    id: string;
    name: string;
    isActive: boolean;
    position: number;
    inUse: number;
  }[];
const idOf = async (s: Session, name: string) => (await types(s)).find((t) => t.name === name)!.id;

describe('hearing types: the firm’s own list', () => {
  it('starts every firm on the standard list, in order', async () => {
    const { owner } = await practiceFixture(app);
    const list = await types(owner);
    expect(list.map((t) => t.name)).toEqual([...HEARING_TYPES]);
    expect(list.every((t) => t.isActive && t.inUse === 0)).toBe(true);
  });

  it('only a firm manager can add or change types; anyone who can see matters can read them', async () => {
    const { owner } = await practiceFixture(app);
    const lawyer = await loginAs(app, 'l1@a.test');
    const clerk = await loginAs(app, 'clerk@a.test');
    expect((await lawyer.agent.get('/api/v1/hearing-types')).status).toBe(200);
    expect((await post(lawyer, '/hearing-types', { name: 'Pronouncement' })).status).toBe(403);
    expect((await post(clerk, '/hearing-types', { name: 'Pronouncement' })).status).toBe(403);
    expect((await patch(lawyer, `/hearing-types/${await idOf(owner, 'Orders')}`, { name: 'x' })).status).toBe(
      403,
    );
    expect((await post(owner, '/hearing-types', { name: 'Pronouncement' })).status).toBe(201);
    expect((await types(owner)).map((t) => t.name)).toContain('Pronouncement');
  });

  it('a name can’t be used twice (ignoring case), and a blank name is refused', async () => {
    const { owner } = await practiceFixture(app);
    expect((await post(owner, '/hearing-types', { name: 'arguments' })).status).toBe(409);
    expect((await post(owner, '/hearing-types', { name: '   ' })).status).toBe(422);
    expect(
      (await patch(owner, `/hearing-types/${await idOf(owner, 'Orders')}`, { name: 'MENTION' })).status,
    ).toBe(409);
  });

  it('hearings can only be saved with a type from the list, saved as the firm spells it', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const date = addDays(today, 5);
    const bad = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: date,
      hearingType: 'Made up type',
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body.error.details)).toContain('hearingType');
    const ok = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: date,
      hearingType: 'final HEARING',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.hearingType).toBe('Final hearing');
    const none = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: date,
      hearingType: '',
    });
    expect(none.body.data.hearingType).toBeNull();
    // a lawyer scheduling a hearing has the same rule
    const lawyer = await loginAs(app, 'l1@a.test');
    expect(
      (
        await post(lawyer, '/hearings', {
          caseId: main.caseId,
          scheduledDate: date,
          hearingType: 'Whatever I type',
        })
      ).status,
    ).toBe(422);
  });

  it('a type the firm adds can be used straight away', async () => {
    const { owner, main, today } = await practiceFixture(app);
    await post(owner, '/hearing-types', { name: 'Pronouncement of judgment' });
    const res = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: addDays(today, 3),
      hearingType: 'Pronouncement of judgment',
    });
    expect(res.status).toBe(201);
    expect((await types(owner)).find((t) => t.name === 'Pronouncement of judgment')?.inUse).toBe(1);
  });

  it('renaming a type also renames it on the hearings that use it', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: addDays(today, 3),
      hearingType: 'Arguments',
    });
    const res = await patch(owner, `/hearing-types/${await idOf(owner, 'Arguments')}`, {
      name: 'Oral arguments',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Oral arguments', inUse: 1 });
    expect((await owner.agent.get(`/api/v1/hearings/${h.body.data.id}`)).body.data.hearingType).toBe(
      'Oral arguments',
    );
  });

  it('an archived type can’t be picked again, but hearings that have it keep it and stay editable', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: addDays(today, 3),
      hearingType: 'Evidence',
    });
    const evidence = await idOf(owner, 'Evidence');
    expect((await patch(owner, `/hearing-types/${evidence}`, { isActive: false })).body.data.isActive).toBe(
      false,
    );

    expect(
      (
        await post(owner, '/hearings', {
          caseId: main.caseId,
          scheduledDate: addDays(today, 4),
          hearingType: 'Evidence',
        })
      ).status,
    ).toBe(422);
    // the old hearing: changing its notes, or re-saving the same type, still works...
    expect((await patch(owner, `/hearings/${h.body.data.id}`, { notes: 'Bring originals' })).status).toBe(
      200,
    );
    expect(
      (await patch(owner, `/hearings/${h.body.data.id}`, { hearingType: 'Evidence', courtroom: '3' })).status,
    ).toBe(200);
    expect((await owner.agent.get(`/api/v1/hearings/${h.body.data.id}`)).body.data.hearingType).toBe(
      'Evidence',
    );
    // ...but moving it to another type that isn't listed does not
    expect((await patch(owner, `/hearings/${h.body.data.id}`, { hearingType: 'Not a type' })).status).toBe(
      422,
    );
    expect((await patch(owner, `/hearings/${h.body.data.id}`, { hearingType: 'Arguments' })).status).toBe(
      200,
    );

    // archived types come last in the list, and adding the name again just brings it back
    expect((await types(owner)).at(-1)).toMatchObject({ name: 'Evidence', isActive: false });
    const back = await post(owner, '/hearing-types', { name: 'evidence' });
    expect(back.status).toBe(201);
    expect(back.body.data).toMatchObject({ id: evidence, isActive: true });
  });

  it('the order can be changed, and a list that isn’t the firm’s own is refused', async () => {
    const { owner } = await practiceFixture(app);
    const ids = (await types(owner)).map((t) => t.id);
    const res = await post(owner, '/hearing-types/order', { ids: [...ids].reverse() });
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual([...HEARING_TYPES].reverse());
    expect((await post(owner, '/hearing-types/order', { ids: [ids[0], ids[0]] })).status).toBe(422);
    expect(
      (await post(owner, '/hearing-types/order', { ids: ['00000000-0000-4000-8000-000000000000'] })).status,
    ).toBe(422);
  });

  it('one firm can’t see or change another firm’s types', async () => {
    const { owner } = await practiceFixture(app);
    await types(owner); // each firm's list is created the first time it is read
    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const other = await loginAs(app, 'owner@b.test');
    const theirs = await idOf(other, 'Orders');
    expect((await patch(owner, `/hearing-types/${theirs}`, { name: 'Hacked' })).status).toBe(404);
    expect((await types(other)).map((t) => t.name)).not.toContain('Hacked');
    const count = (await pool.query(`SELECT count(*)::int AS n FROM hearing_types`)).rows[0].n as number;
    expect(count).toBe(HEARING_TYPES.length * 2);
  });
});
