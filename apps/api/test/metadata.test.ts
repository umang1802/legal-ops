import {
  DOCUMENT_CATEGORY_DEFAULTS,
  EXPENSE_CATEGORIES,
  HEARING_TYPES,
  METADATA_LISTS,
  PRACTICE_AREAS,
  type MetadataListKey,
} from '@legalops/types';
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
type Option = { id: string; name: string; isActive: boolean; position: number; inUse: number };
const options = async (s: Session, list: MetadataListKey) =>
  (await s.agent.get(`/api/v1/metadata/${list}`)).body.data as Option[];
const idOf = async (s: Session, list: MetadataListKey, name: string) =>
  (await options(s, list)).find((o) => o.name === name)!.id;

const DEFAULTS: Record<MetadataListKey, readonly string[]> = {
  hearing_type: HEARING_TYPES,
  document_category: DOCUMENT_CATEGORY_DEFAULTS,
  practice_area: PRACTICE_AREAS,
  expense_category: EXPENSE_CATEGORIES,
};

describe('metadata: every list works the same way', () => {
  it.each(METADATA_LISTS.map((l) => l.key))(
    '%s: starts on the standard list; a manager adds, renames, archives and reorders it',
    async (list) => {
      const { owner } = await practiceFixture(app);
      expect((await options(owner, list)).map((o) => o.name)).toEqual([...DEFAULTS[list]]);

      const created = await post(owner, `/metadata/${list}`, { name: 'Brand new entry' });
      expect(created.status).toBe(201);
      expect((await post(owner, `/metadata/${list}`, { name: 'brand NEW entry' })).status).toBe(409); // same name, any case
      expect((await post(owner, `/metadata/${list}`, { name: '  ' })).status).toBe(422);

      const id = created.body.data.id as string;
      expect((await patch(owner, `/metadata/${list}/${id}`, { name: 'Renamed entry' })).body.data.name).toBe(
        'Renamed entry',
      );
      expect((await patch(owner, `/metadata/${list}/${id}`, { isActive: false })).body.data.isActive).toBe(
        false,
      );
      expect((await options(owner, list)).at(-1)).toMatchObject({ name: 'Renamed entry', isActive: false }); // archived come last
      expect((await post(owner, `/metadata/${list}`, { name: 'renamed ENTRY' })).body.data).toMatchObject({
        id,
        isActive: true,
      }); // adding it back restores it

      const ids = (await options(owner, list)).map((o) => o.id);
      const reordered = await post(owner, `/metadata/${list}/order`, { ids: [...ids].reverse() });
      expect(reordered.body.data.map((o: Option) => o.id)).toEqual([...ids].reverse());
      expect((await post(owner, `/metadata/${list}/order`, { ids: [ids[0], ids[0]] })).status).toBe(422);
    },
  );

  it('only a firm manager can change a list; anyone signed in can read it', async () => {
    const { owner } = await practiceFixture(app);
    const lawyer = await loginAs(app, 'l1@a.test');
    const finance = await loginAs(app, 'finance@a.test');
    for (const s of [lawyer, finance]) {
      expect((await s.agent.get('/api/v1/metadata/expense_category')).status).toBe(200);
      expect((await post(s, '/metadata/practice_area', { name: 'Insolvency' })).status).toBe(403);
      expect(
        (
          await patch(s, `/metadata/practice_area/${await idOf(owner, 'practice_area', 'Civil')}`, {
            name: 'x',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(s, '/metadata/practice_area/order', {
            ids: [await idOf(owner, 'practice_area', 'Civil')],
          })
        ).status,
      ).toBe(403);
    }
    expect((await owner.agent.get('/api/v1/metadata/not_a_list')).status).toBe(422);
  });

  it('one firm can’t see or change another firm’s lists', async () => {
    const { owner } = await practiceFixture(app);
    await options(owner, 'hearing_type');
    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const other = await loginAs(app, 'owner@b.test');
    const theirs = await idOf(other, 'hearing_type', 'Orders');
    expect((await patch(owner, `/metadata/hearing_type/${theirs}`, { name: 'Hacked' })).status).toBe(404);
    expect((await patch(owner, `/metadata/practice_area/${theirs}`, { name: 'Hacked' })).status).toBe(404); // right firm's id, wrong list
    expect((await options(other, 'hearing_type')).map((o) => o.name)).not.toContain('Hacked');
  });

  it('changes are audited', async () => {
    const { owner } = await practiceFixture(app);
    const c = await post(owner, '/metadata/practice_area', { name: 'Insolvency' });
    await patch(owner, `/metadata/practice_area/${c.body.data.id}`, { isActive: false });
    const actions = (
      await pool.query(`SELECT action FROM audit_logs WHERE action LIKE 'metadata.%' ORDER BY created_at`)
    ).rows.map((r) => r.action);
    expect(actions).toEqual(['metadata.created', 'metadata.updated']);
  });
});

describe('metadata: hearing types', () => {
  it('a hearing can only be saved with a listed type, as the firm spells it; empty is fine', async () => {
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
    expect(ok.body.data.hearingType).toBe('Final hearing');
    expect(
      (await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date, hearingType: '' })).body
        .data.hearingType,
    ).toBeNull();
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

  it('a type the firm adds works straight away; renaming updates its hearings', async () => {
    const { owner, main, today } = await practiceFixture(app);
    await post(owner, '/metadata/hearing_type', { name: 'Pronouncement of judgment' });
    const h = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: addDays(today, 3),
      hearingType: 'Pronouncement of judgment',
    });
    expect(h.status).toBe(201);
    const id = await idOf(owner, 'hearing_type', 'Pronouncement of judgment');
    expect((await options(owner, 'hearing_type')).find((o) => o.id === id)?.inUse).toBe(1);
    expect(
      (await patch(owner, `/metadata/hearing_type/${id}`, { name: 'Judgment' })).body.data,
    ).toMatchObject({ name: 'Judgment', inUse: 1 });
    expect((await owner.agent.get(`/api/v1/hearings/${h.body.data.id}`)).body.data.hearingType).toBe(
      'Judgment',
    );
  });

  it('an archived type can’t be picked again, but a hearing that has it keeps it and stays editable', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const h = await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: addDays(today, 3),
      hearingType: 'Evidence',
    });
    await patch(owner, `/metadata/hearing_type/${await idOf(owner, 'hearing_type', 'Evidence')}`, {
      isActive: false,
    });
    expect(
      (
        await post(owner, '/hearings', {
          caseId: main.caseId,
          scheduledDate: addDays(today, 4),
          hearingType: 'Evidence',
        })
      ).status,
    ).toBe(422);
    expect((await patch(owner, `/hearings/${h.body.data.id}`, { notes: 'Bring originals' })).status).toBe(
      200,
    );
    expect(
      (await patch(owner, `/hearings/${h.body.data.id}`, { hearingType: 'Evidence', courtroom: '3' })).status,
    ).toBe(200);
    expect((await patch(owner, `/hearings/${h.body.data.id}`, { hearingType: 'Not a type' })).status).toBe(
      422,
    );
  });
});

describe('metadata: file categories', () => {
  const upload = (s: Session, body: object) =>
    post(s, '/documents/uploads', { name: 'Plaint.pdf', sizeBytes: 100, ...body });

  it('a file can be uploaded with a listed category, with none, but not with an unlisted one', async () => {
    const { owner, main } = await practiceFixture(app);
    expect((await upload(owner, { matterId: main.matterId, category: 'client_documents' })).status).toBe(422); // an old fixed code is not a name
    const ok = await upload(owner, { matterId: main.matterId, category: 'pleadings' }); // matches "Pleadings", ignoring case
    expect(ok.status).toBe(201);
    expect((await upload(owner, { matterId: main.matterId })).status).toBe(201);
    expect((await upload(owner, { matterId: main.matterId, category: null })).status).toBe(201);
    const stored = (await pool.query(`SELECT category FROM documents ORDER BY created_at`)).rows.map(
      (r) => r.category,
    );
    expect(stored).toEqual(['Pleadings', null, null]);
  });

  it('a category the firm adds can be used at once; renaming it renames it on the files', async () => {
    const { owner, main } = await practiceFixture(app);
    await post(owner, '/metadata/document_category', { name: 'Affidavits' });
    expect((await upload(owner, { matterId: main.matterId, category: 'affidavits' })).status).toBe(201);
    await patch(
      owner,
      `/metadata/document_category/${await idOf(owner, 'document_category', 'Affidavits')}`,
      { name: 'Sworn statements' },
    );
    expect((await pool.query(`SELECT category FROM documents`)).rows[0].category).toBe('Sworn statements');
  });
});

describe('metadata: practice areas and expense categories', () => {
  it('a matter takes a listed practice area (or none), and a firm-added one works at once', async () => {
    const { owner, firm } = await practiceFixture(app);
    const clientId = (await pool.query(`SELECT id FROM clients WHERE organization_id = $1`, [firm.orgId]))
      .rows[0].id as string;
    const make = (practiceArea: string | null) =>
      post(owner, '/matters', { clientId, title: `M ${practiceArea}`, practiceArea });
    expect((await make('Admiralty law')).status).toBe(422);
    expect((await make('ipr')).body.data.practiceArea).toBe('IPR'); // IPR is in the standard list
    expect((await make(null)).status).toBe(201);
    await post(owner, '/metadata/practice_area', { name: 'Admiralty law' });
    expect((await make('Admiralty law')).status).toBe(201);
  });

  it('updating a matter keeps an old practice area that the firm has since archived', async () => {
    const { owner, main } = await practiceFixture(app);
    await patch(owner, `/matters/${main.matterId}`, { practiceArea: 'Civil' });
    await patch(owner, `/metadata/practice_area/${await idOf(owner, 'practice_area', 'Civil')}`, {
      isActive: false,
    });
    expect(
      (
        await patch(owner, `/matters/${main.matterId}`, {
          title: 'Sharma v ABC (renamed)',
          practiceArea: 'Civil',
        })
      ).status,
    ).toBe(200);
    expect((await patch(owner, `/matters/${main.matterId}`, { practiceArea: 'Criminal' })).status).toBe(200);
    expect((await patch(owner, `/matters/${main.matterId}`, { practiceArea: 'Civil' })).status).toBe(422); // no longer offered
  });

  it('an expense takes a listed category (or none)', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const fin = await loginAs(app, 'finance@a.test');
    const expense = (category: string | null) =>
      post(fin, '/expenses', { matterId: main.matterId, amount: '500', expenseDate: today, category });
    expect((await expense('Pizza')).status).toBe(422);
    expect((await expense('travel')).body.data.category).toBe('Travel');
    expect((await expense(null)).status).toBe(201);
    await post(owner, '/metadata/expense_category', { name: 'Translation' });
    expect((await expense('Translation')).status).toBe(201);
  });
});
