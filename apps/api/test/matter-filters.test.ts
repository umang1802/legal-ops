import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const find = async (s: Session, q: Record<string, string>) =>
  ((await s.agent.get('/api/v1/matters').query({ status: 'all', ...q })).body.data as { title: string }[])
    .map((m) => m.title)
    .sort();

/** Three matters: A (court 1, hearing in 3 days), B (court 2, hearing in 20 days), C (no court, no hearing). */
async function setup() {
  const fx = await practiceFixture(app);
  const { owner, firm, main, privateMatter, today } = fx;
  const court = async (name: string) =>
    (
      await pool.query(`INSERT INTO courts (organization_id, name) VALUES ($1, $2) RETURNING id`, [
        firm.orgId,
        name,
      ])
    ).rows[0].id as string;
  const [c1, c2] = [await court('Court One'), await court('Court Two')];
  await patch(owner, `/cases/${main.caseId}`, { courtId: c1 });
  await patch(owner, `/cases/${privateMatter.caseId}`, { courtId: c2 });
  await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 3) });
  await post(owner, '/hearings', { caseId: privateMatter.caseId, scheduledDate: addDays(today, 20) });
  const clientId = (await pool.query(`SELECT id FROM clients WHERE organization_id = $1`, [firm.orgId]))
    .rows[0].id as string;
  const c = await post(owner, '/matters', { clientId, title: 'Third matter' });
  return { ...fx, c1, c2, third: c.body.data.id as string, clientId };
}

describe('cases page filters (API)', () => {
  it('filters by the court a matter has a case in', async () => {
    const { owner, c1, c2 } = await setup();
    expect(await find(owner, { courtId: c1 })).toEqual(['Sharma v ABC']);
    expect(await find(owner, { courtId: c2 })).toEqual(['Partner only']);
    expect(await find(owner, { courtId: '00000000-0000-4000-8000-000000000000' })).toEqual([]);
    expect((await owner.agent.get('/api/v1/matters').query({ courtId: 'nope' })).status).toBe(422);
  });

  it('filters by next hearing: within 7 days, within 30 days, or none scheduled', async () => {
    const { owner } = await setup();
    expect(await find(owner, { hearing: 'week' })).toEqual(['Sharma v ABC']);
    expect(await find(owner, { hearing: 'month' })).toEqual(['Partner only', 'Sharma v ABC']);
    expect(await find(owner, { hearing: 'none' })).toEqual(['Third matter']);
    expect((await owner.agent.get('/api/v1/matters').query({ hearing: 'someday' })).status).toBe(422);
  });

  it('a hearing that is cancelled or already past does not count as upcoming', async () => {
    const { owner, main, privateMatter, today } = await setup();
    const hearingOf = async (caseId: string) =>
      (await pool.query(`SELECT id FROM hearings WHERE case_id = $1`, [caseId])).rows[0].id as string;
    expect(
      (await post(owner, `/hearings/${await hearingOf(main.caseId)}/cancel`, { reason: 'Listing withdrawn' }))
        .status,
    ).toBe(200);
    await pool.query(`UPDATE hearings SET scheduled_date = $2::date - 1 WHERE case_id = $1`, [
      privateMatter.caseId,
      today,
    ]);
    expect(await find(owner, { hearing: 'week' })).toEqual([]);
    expect(await find(owner, { hearing: 'month' })).toEqual([]);
    expect(await find(owner, { hearing: 'none' })).toEqual(['Partner only', 'Sharma v ABC', 'Third matter']);
  });

  it('combines filters, and a lawyer still only sees the matters they are on', async () => {
    const { owner, c1 } = await setup();
    expect(await find(owner, { courtId: c1, hearing: 'week' })).toEqual(['Sharma v ABC']);
    expect(await find(owner, { courtId: c1, hearing: 'none' })).toEqual([]);
    const lawyer = await loginAs(app, 'l1@a.test'); // on "Sharma v ABC" only
    expect(await find(lawyer, { hearing: 'month' })).toEqual(['Sharma v ABC']);
    expect(await find(await loginAs(app, 'l2@a.test'), { hearing: 'month' })).toEqual([]);
  });

  it('keeps the filters that already existed', async () => {
    const { owner, clientId } = await setup();
    expect(await find(owner, { clientId })).toEqual(['Partner only', 'Sharma v ABC', 'Third matter']);
    expect(
      await find(owner, {
        lawyerId: (await pool.query(`SELECT id FROM users WHERE email = 'l1@a.test'`)).rows[0].id,
      }),
    ).toEqual(['Sharma v ABC']);
  });
});
