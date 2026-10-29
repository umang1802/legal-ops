import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const diary = (s: Session, q: Record<string, string> = {}) => s.agent.get('/api/v1/hearings/diary').query(q);

describe('hearings diary (printable board)', () => {
  it('defaults to tomorrow in the firm’s timezone and lists that day’s hearings with case details', async () => {
    const { owner, main, today } = await practiceFixture(app);
    await pool.query(`UPDATE cases SET cnr = 'DLHC010004122026' WHERE id = $1`, [main.caseId]);
    const tomorrow = addDays(today, 1);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: tomorrow, startTime: '10:30', courtroom: '12', hearingType: 'Arguments' });
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 2) });

    const res = await diary(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe(tomorrow);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0]).toMatchObject({
      scheduledDate: tomorrow,
      startTime: '10:30',
      courtroom: '12',
      hearingType: 'Arguments',
      caseNumber: 'CS 12/2026',
      cnr: 'DLHC010004122026',
      clientName: 'Raj Sharma',
      lead: expect.objectContaining({ firstName: 'l1' }),
      previous: null,
    });
  });

  it('shows the last held hearing’s date and internal note, and leaves out cancelled hearings', async () => {
    const { owner, main, today } = await practiceFixture(app);
    const tomorrow = addDays(today, 1);
    const held = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await post(owner, `/hearings/${held.body.data.id}/complete`, {
      result: 'adjourned',
      outcome: 'Respondent sought time to file reply',
      clientSummary: 'Adjourned for reply.',
      nextHearingDate: tomorrow,
    });
    const extra = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: tomorrow, startTime: '15:00' });
    await post(owner, `/hearings/${extra.body.data.id}/cancel`, { reason: 'Listed by mistake' });

    const res = await diary(owner, { date: tomorrow });
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].previous).toEqual({ date: today, result: 'adjourned', outcome: 'Respondent sought time to file reply' });
  });

  it('follows matter visibility, and "mine" narrows partners to their own matters', async () => {
    const { owner, main, privateMatter, today } = await practiceFixture(app);
    const tomorrow = addDays(today, 1);
    const privCase = (await pool.query(`SELECT id FROM cases WHERE matter_id = $1`, [privateMatter.matterId])).rows[0].id;
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: tomorrow });
    await post(owner, '/hearings', { caseId: privCase, scheduledDate: tomorrow });

    const titles = (r: { body: { data: { rows: { matterTitle: string }[] } } }) => r.body.data.rows.map((x) => x.matterTitle).sort();
    expect(titles(await diary(owner, { date: tomorrow }))).toEqual(['Partner only', 'Sharma v ABC']);
    expect(titles(await diary(owner, { date: tomorrow, scope: 'mine' }))).toEqual(['Partner only']);
    expect(titles(await diary(await loginAs(app, 'l1@a.test'), { date: tomorrow }))).toEqual(['Sharma v ABC']);
    expect(titles(await diary(await loginAs(app, 'l2@a.test'), { date: tomorrow }))).toEqual([]);
  });

  it('rejects a malformed date', async () => {
    const { owner } = await practiceFixture(app);
    expect((await diary(owner, { date: '29-10-2026' })).status).toBe(422);
    expect((await diary(owner, { scope: 'everyone' })).status).toBe(422);
  });
});
