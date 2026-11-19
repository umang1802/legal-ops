import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const month = (s: Session, q: Record<string, string> = {}) =>
  s.agent.get('/api/v1/hearings/diary/month').query(q);

describe('month diary (printable)', () => {
  it('lists the month’s hearings by date, leaving out other months and cancelled hearings', async () => {
    const { owner, main, privateMatter, today } = await practiceFixture(app);
    const m = addDays(today, 45).slice(0, 7); // a future month
    const outside = addDays(`${m}-28`, 10); // always the month after
    await post(owner, '/hearings', {
      caseId: main.caseId,
      scheduledDate: `${m}-20`,
      startTime: '11:00',
      hearingType: 'Arguments',
    });
    await post(owner, '/hearings', {
      caseId: privateMatter.caseId,
      scheduledDate: `${m}-03`,
      courtroom: '4',
    });
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: `${m}-03`, startTime: '09:30' });
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: outside });
    const gone = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: `${m}-12` });
    await post(owner, `/hearings/${gone.body.data.id}/cancel`, { reason: 'Listing withdrawn' });

    const res = await month(owner, { month: m });
    expect(res.status).toBe(200);
    expect(res.body.data.month).toBe(m);
    expect(res.body.data.rows.map((r: { scheduledDate: string }) => r.scheduledDate)).toEqual([
      `${m}-03`,
      `${m}-03`,
      `${m}-20`,
    ]);
    expect(res.body.data.rows[2]).toMatchObject({
      startTime: '11:00',
      hearingType: 'Arguments',
      caseNumber: 'CS 12/2026',
      clientName: 'Raj Sharma',
    });
  });

  it('shows only matters the person can see, and “mine” narrows a partner to their own', async () => {
    const { owner, main, privateMatter, today } = await practiceFixture(app);
    const m = addDays(today, 45).slice(0, 7);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: `${m}-05` });
    await post(owner, '/hearings', { caseId: privateMatter.caseId, scheduledDate: `${m}-06` });
    const titles = (r: { body: { data: { rows: { caseTitle: string }[] } } }) =>
      r.body.data.rows.map((x) => x.caseTitle).sort();
    expect(titles(await month(owner, { month: m }))).toHaveLength(2);
    expect(titles(await month(owner, { month: m, scope: 'mine' }))).toHaveLength(1); // the partner is only on "Partner only"
    expect(titles(await month(await loginAs(app, 'l1@a.test'), { month: m }))).toHaveLength(1);
    expect(titles(await month(await loginAs(app, 'l2@a.test'), { month: m }))).toHaveLength(0);
  });

  it('defaults to the current month in the firm’s timezone, and refuses a bad month', async () => {
    const { owner, today } = await practiceFixture(app);
    expect((await month(owner)).body.data.month).toBe(today.slice(0, 7));
    expect((await month(owner, { month: '2026-13' })).status).toBe(422);
    expect((await month(owner, { month: 'November' })).status).toBe(422);
    expect((await month(owner, { scope: 'everyone' })).status).toBe(422);
  });

  it('is not available to a firm that has the diary switched off', async () => {
    const { owner, firm } = await practiceFixture(app);
    const { pool } = await import('./helpers.js');
    await pool.query(
      `INSERT INTO organization_features (organization_id, feature_key, enabled) VALUES ($1, 'diary', false) ON CONFLICT (organization_id, feature_key) DO UPDATE SET enabled = false`,
      [firm.orgId],
    );
    expect((await month(owner)).status).toBe(404);
  });
});
