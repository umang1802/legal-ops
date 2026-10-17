import { describe, expect, it } from 'vitest';
import { addDays, buildApp, createFirm, loginAs, pool, practiceFixture, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('hearings', () => {
  it('schedules a hearing: listed in range, on the timeline, event emitted, matter shows next hearing', async () => {
    const { main, today } = await practiceFixture(app);
    const l1 = await loginAs(app, 'l1@a.test');
    const date = addDays(today, 7);
    const res = await l1.agent.post('/api/v1/hearings').set('X-CSRF-Token', l1.csrf).send({
      caseId: main.caseId,
      scheduledDate: date,
      startTime: '10:30',
      courtroom: '12',
      hearingType: 'Arguments',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      scheduledDate: date,
      startTime: '10:30',
      status: 'scheduled',
      pendingOutcome: false,
    });
    expect(res.body.data.lead.userId).toBeTruthy();

    const list = await l1.agent.get('/api/v1/hearings').query({ from: today, until: addDays(today, 14) });
    expect(list.body.data.map((h: { id: string }) => h.id)).toEqual([res.body.data.id]);

    const matter = await l1.agent.get(`/api/v1/matters/${main.matterId}`);
    expect(matter.body.data.nextHearingDate).toBe(date);
    expect(matter.body.data.cases[0].nextHearingDate).toBe(date);

    const outbox = await pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'HEARING_SCHEDULED'`,
    );
    expect(outbox.rows[0].payload).toMatchObject({ scheduledDate: date, startTime: '10:30' });
    const tl = await l1.agent.get(`/api/v1/matters/${main.matterId}/timeline`);
    expect(tl.body.data[0].eventType).toBe('hearing.scheduled');
  });

  it('rescheduling emits HEARING_CHANGED with before/after for reminder re-planning', async () => {
    const { main, today, owner } = await practiceFixture(app);
    const h = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: addDays(today, 5) });
    const moved = await owner.agent
      .patch(`/api/v1/hearings/${h.body.data.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ scheduledDate: addDays(today, 9), startTime: '11:00' });
    expect(moved.body.data.scheduledDate).toBe(addDays(today, 9));
    const { rows } = await pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'HEARING_CHANGED'`,
    );
    expect(rows[0].payload.before.scheduledDate).toBe(addDays(today, 5));
    expect(rows[0].payload.after).toEqual({ scheduledDate: addDays(today, 9), startTime: '11:00' });

    // Notes-only edits don't spam the timeline or re-plan reminders.
    await owner.agent
      .patch(`/api/v1/hearings/${h.body.data.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ notes: 'Bring originals' });
    expect(
      (await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE event_type = 'HEARING_CHANGED'`))
        .rows[0].n,
    ).toBe(1);
  });

  it('Pilot Test 3: complete -> next date -> follow-up task for the lead -> events, all atomic and not replayable', async () => {
    const { main, today, uid } = await practiceFixture(app);
    const l1 = await loginAs(app, 'l1@a.test');
    const h = await l1.agent.post('/api/v1/hearings').set('X-CSRF-Token', l1.csrf).send({
      caseId: main.caseId,
      scheduledDate: today,
      courtroom: '12',
      benchJudge: 'Hon. Justice R. Mehta',
    });
    const id = h.body.data.id;
    const next = addDays(today, 12);

    const done = await l1.agent
      .post(`/api/v1/hearings/${id}/complete`)
      .set('X-CSRF-Token', l1.csrf)
      .send({
        result: 'adjourned',
        outcome: 'Respondent sought time to file reply',
        nextHearingDate: next,
        nextActions: [{ title: 'Prepare written submissions', dueDate: addDays(today, 10) }],
      });
    expect(done.status).toBe(200);
    expect(done.body.data.hearing).toMatchObject({ status: 'adjourned', nextHearingDate: next });
    expect(done.body.data.nextHearing).toMatchObject({
      scheduledDate: next,
      status: 'scheduled',
      courtroom: '12',
      benchJudge: 'Hon. Justice R. Mehta',
      previousHearingId: id,
    });
    expect(done.body.data.taskIds).toHaveLength(1);

    const task = await l1.agent.get(`/api/v1/tasks/${done.body.data.taskIds[0]}`);
    expect(task.body.data).toMatchObject({
      title: 'Prepare written submissions',
      hearingId: id,
      dueDate: addDays(today, 10),
    });
    expect(task.body.data.assignee.userId).toBe(uid('l1@a.test'));
    const completedEvent = await pool.query(
      `SELECT id FROM outbox_events WHERE event_type = 'HEARING_COMPLETED'`,
    );
    expect(task.body.data.sourceEventId).toBe(completedEvent.rows[0].id);

    const events = await pool.query(`SELECT event_type FROM outbox_events ORDER BY created_at, event_type`);
    expect(events.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['HEARING_COMPLETED', 'HEARING_SCHEDULED', 'TASK_CREATED']),
    );
    const matter = await l1.agent.get(`/api/v1/matters/${main.matterId}`);
    expect(matter.body.data.nextHearingDate).toBe(next);

    const again = await l1.agent
      .post(`/api/v1/hearings/${id}/complete`)
      .set('X-CSRF-Token', l1.csrf)
      .send({ result: 'completed', outcome: 'dup', nextHearingDate: addDays(today, 20) });
    expect(again.status).toBe(409);
    expect((await pool.query(`SELECT count(*)::int n FROM hearings`)).rows[0].n).toBe(2);
  });

  it('validates outcomes: next date must follow, future hearings cannot be completed yet', async () => {
    const { main, today, owner } = await practiceFixture(app);
    const past = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: addDays(today, -1) });
    const bad = await owner.agent
      .post(`/api/v1/hearings/${past.body.data.id}/complete`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ result: 'completed', outcome: 'x', nextHearingDate: addDays(today, -1) });
    expect(bad.status).toBe(422);

    const future = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: addDays(today, 3) });
    const early = await owner.agent
      .post(`/api/v1/hearings/${future.body.data.id}/complete`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ result: 'completed', outcome: 'x' });
    expect(early.status).toBe(422);
  });

  it('a past hearing with no outcome is flagged pending; cancelling clears the next-hearing date', async () => {
    const { main, today, owner } = await practiceFixture(app);
    const past = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: addDays(today, -2) });
    expect(past.body.data.pendingOutcome).toBe(true);
    const pending = await owner.agent
      .get('/api/v1/hearings')
      .query({ status: 'pending_outcome', matterId: main.matterId });
    expect(pending.body.data).toHaveLength(1);

    const future = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: addDays(today, 4) });
    const cancel = await owner.agent
      .post(`/api/v1/hearings/${future.body.data.id}/cancel`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ reason: 'Bench not sitting' });
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Bench not sitting' });
    const matter = await owner.agent.get(`/api/v1/matters/${main.matterId}`);
    expect(matter.body.data.nextHearingDate).toBeNull();
    const twice = await owner.agent
      .post(`/api/v1/hearings/${future.body.data.id}/cancel`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ reason: 'again' });
    expect(twice.status).toBe(409);
    const edit = await owner.agent
      .patch(`/api/v1/hearings/${future.body.data.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ notes: 'x' });
    expect(edit.status).toBe(409);
  });

  it('visibility and permissions: unassigned 404, finance read-only, other firm 404', async () => {
    const { main, privateMatter, today, owner } = await practiceFixture(app);
    const h = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: privateMatter.caseId, scheduledDate: today });
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await l1.agent.get(`/api/v1/hearings/${h.body.data.id}`)).status).toBe(404);
    expect(
      (
        await l1.agent
          .post(`/api/v1/hearings/${h.body.data.id}/complete`)
          .set('X-CSRF-Token', l1.csrf)
          .send({ result: 'completed', outcome: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await l1.agent.get('/api/v1/hearings').query({ from: today, until: today })).body.data,
    ).toHaveLength(0);
    expect(
      (
        await l1.agent
          .post('/api/v1/hearings')
          .set('X-CSRF-Token', l1.csrf)
          .send({ caseId: privateMatter.caseId, scheduledDate: today })
      ).status,
    ).toBe(404);

    const fin = await loginAs(app, 'finance@a.test');
    expect((await fin.agent.get(`/api/v1/hearings/${h.body.data.id}`)).status).toBe(200);
    expect(
      (
        await fin.agent
          .post('/api/v1/hearings')
          .set('X-CSRF-Token', fin.csrf)
          .send({ caseId: main.caseId, scheduledDate: today })
      ).status,
    ).toBe(403);

    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const b = await loginAs(app, 'owner@b.test');
    expect((await b.agent.get(`/api/v1/hearings/${h.body.data.id}`)).status).toBe(404);
    expect(
      (
        await b.agent
          .post('/api/v1/hearings')
          .set('X-CSRF-Token', b.csrf)
          .send({ caseId: main.caseId, scheduledDate: today })
      ).status,
    ).toBe(404);
  });

  it('rejects ranges longer than 3 months', async () => {
    const { owner, today } = await practiceFixture(app);
    const res = await owner.agent.get('/api/v1/hearings').query({ from: today, until: addDays(today, 120) });
    expect(res.status).toBe(422);
  });
});
