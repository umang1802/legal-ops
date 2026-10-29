import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
/** Fetch a feed the way a calendar app does: no cookies, just the URL. */
const fetchFeed = (url: string) => request(app).get(new URL(url).pathname);
const compactDate = (d: string) => d.replace(/-/g, '');

async function setup() {
  const fx = await practiceFixture(app);
  const privCase = (await pool.query(`SELECT id FROM cases WHERE matter_id = $1`, [fx.privateMatter.matterId])).rows[0].id as string;
  return { ...fx, privCase };
}

describe('calendar sync (subscribe link)', () => {
  it('creates a personal link; the feed lists visible hearings with correct UTC times, and leaves out cancelled ones', async () => {
    const { owner, main, today } = await setup();
    const d = addDays(today, 3);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: d, startTime: '10:30', courtroom: '12', hearingType: 'Arguments' });
    const allDay = addDays(today, 5);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: allDay });
    const gone = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 6) });
    await post(owner, `/hearings/${gone.body.data.id}/cancel`, { reason: 'Mistake' });

    expect((await owner.agent.get('/api/v1/calendar-feed')).body.data).toMatchObject({ active: false });
    const created = await post(owner, '/calendar-feed');
    expect(created.status).toBe(201);
    expect(created.body.data.url).toMatch(/\/api\/v1\/ical\/[A-Za-z0-9_-]{40,}\.ics$/);

    const feed = await fetchFeed(created.body.data.url);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/^text\/calendar/);
    expect(feed.headers['cache-control']).toBe('no-store');
    const ics = feed.text;
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain(`DTSTART:${compactDate(d)}T050000Z`); // 10:30 IST = 05:00 UTC
    expect(ics).toContain(`DTEND:${compactDate(d)}T060000Z`); // default 1 hour
    expect(ics).toContain(`DTSTART;VALUE=DATE:${compactDate(allDay)}`);
    expect(ics).toContain('SUMMARY:CS 12/2026 · Sharma v ABC case');
    expect(ics).toContain('Client: Raj Sharma');
    expect((await owner.agent.get('/api/v1/calendar-feed')).body.data).toMatchObject({ active: true });
  });

  it('follows matter visibility: a lawyer’s feed has only their matters', async () => {
    const { owner, main, privCase, today } = await setup();
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 2) });
    await post(owner, '/hearings', { caseId: privCase, scheduledDate: addDays(today, 2) });
    const l1 = await loginAs(app, 'l1@a.test');
    const ownerIcs = (await fetchFeed((await post(owner, '/calendar-feed')).body.data.url)).text;
    const l1Ics = (await fetchFeed((await post(l1, '/calendar-feed')).body.data.url)).text;
    expect(ownerIcs.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(l1Ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(l1Ics).not.toContain('Partner only');
  });

  it('reset replaces the link; turning off and leaving the firm stop it working', async () => {
    const { owner, firm } = await setup();
    const first = (await post(owner, '/calendar-feed')).body.data.url;
    const second = (await post(owner, '/calendar-feed')).body.data.url;
    expect((await fetchFeed(first)).status).toBe(404);
    expect((await fetchFeed(second)).status).toBe(200);
    expect((await owner.agent.delete('/api/v1/calendar-feed').set('X-CSRF-Token', owner.csrf)).status).toBe(204);
    expect((await fetchFeed(second)).status).toBe(404);

    const l1 = await loginAs(app, 'l1@a.test');
    const l1Url = (await post(l1, '/calendar-feed')).body.data.url;
    await pool.query(`UPDATE organization_members SET status = 'removed' WHERE user_id = $1 AND organization_id = $2`, [firm.users['l1@a.test']!.userId, firm.orgId]);
    expect((await fetchFeed(l1Url)).status).toBe(404);
  });

  it('a suspended firm’s feeds stop working, and unknown tokens get a plain 404', async () => {
    const { owner, firm } = await setup();
    const url = (await post(owner, '/calendar-feed')).body.data.url;
    await pool.query(`UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = 'x' WHERE id = $1`, [firm.orgId]);
    expect((await fetchFeed(url)).status).toBe(404);
    expect((await request(app).get('/api/v1/ical/not-a-real-token-at-all-0123456789abcdef.ics')).status).toBe(404);
  });

  it('"Hide parties in calendar" shows only the case number and drops client and matter names', async () => {
    const { owner, main, today } = await setup();
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 2) });
    const patched = await owner.agent.patch('/api/v1/organization').set('X-CSRF-Token', owner.csrf).send({ calendarHideParties: true });
    expect(patched.status).toBe(200);
    expect(patched.body.data.calendarHideParties).toBe(true);
    const ics = (await fetchFeed((await post(owner, '/calendar-feed')).body.data.url)).text;
    expect(ics).toContain('SUMMARY:CS 12/2026 · Hearing');
    expect(ics).not.toContain('Raj Sharma');
    expect(ics).not.toContain('Sharma v ABC');
  });
});
