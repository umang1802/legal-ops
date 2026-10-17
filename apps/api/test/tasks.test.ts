import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, pool, practiceFixture, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('tasks', () => {
  it('stores due date + time in the firm timezone and reports the local due date', async () => {
    const { main, owner, uid } = await practiceFixture(app);
    const res = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({
        title: 'File vakalatnama',
        matterId: main.matterId,
        assigneeId: uid('l1@a.test'),
        dueDate: '2026-10-10',
        dueTime: '10:00',
      });
    expect(res.status).toBe(201);
    // 10:00 IST = 04:30 UTC
    expect(res.body.data).toMatchObject({
      dueAt: '2026-10-10T04:30:00.000Z',
      dueDate: '2026-10-10',
      status: 'todo',
    });
    const noTime = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ title: 'Collect certified copy', dueDate: '2026-10-10' });
    // No time = end of that local day, so it isn't "overdue" during the day it's due.
    expect(noTime.body.data).toMatchObject({ dueAt: '2026-10-10T18:29:00.000Z', dueDate: '2026-10-10' });
  });

  it('derives case and matter from a hearing link and rejects mismatched links', async () => {
    const { main, privateMatter, owner, today } = await practiceFixture(app);
    const h = await owner.agent
      .post('/api/v1/hearings')
      .set('X-CSRF-Token', owner.csrf)
      .send({ caseId: main.caseId, scheduledDate: today });
    const t = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ title: 'Brief counsel', hearingId: h.body.data.id });
    expect(t.body.data).toMatchObject({
      caseId: main.caseId,
      matter: { id: main.matterId },
      hearingId: h.body.data.id,
    });
    const bad = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ title: 'x', hearingId: h.body.data.id, matterId: privateMatter.matterId });
    expect(bad.status).toBe(422);
  });

  it('visibility: assigned matter, direct assignment and own tasks only; views filter correctly', async () => {
    const { main, privateMatter, owner, uid, today } = await practiceFixture(app);
    const mk = (body: Record<string, unknown>) =>
      owner.agent.post('/api/v1/tasks').set('X-CSRF-Token', owner.csrf).send(body);
    await mk({
      title: 'On main, for clerk',
      matterId: main.matterId,
      assigneeId: uid('clerk@a.test'),
      dueDate: addDays(today, -2),
    });
    await mk({
      title: 'Private matter, for l2',
      matterId: privateMatter.matterId,
      assigneeId: uid('l2@a.test'),
      dueDate: addDays(today, 3),
    });
    await mk({ title: 'Private matter, unassigned', matterId: privateMatter.matterId });

    const titles = async (email: string, view: string) => {
      const s = await loginAs(app, email);
      return (await s.agent.get('/api/v1/tasks').query({ view })).body.data
        .map((t: { title: string }) => t.title)
        .sort();
    };
    // l1 leads main: sees the clerk's task in team view, nothing on the private matter.
    expect(await titles('l1@a.test', 'team')).toEqual(['On main, for clerk']);
    // l2 isn't on the private matter but was assigned a task there: sees that task only.
    expect(await titles('l2@a.test', 'team')).toEqual(['Private matter, for l2']);
    expect(await titles('l2@a.test', 'mine')).toEqual(['Private matter, for l2']);
    expect(await titles('clerk@a.test', 'overdue')).toEqual(['On main, for clerk']);
    expect(await titles('owner@a.test', 'team')).toHaveLength(3);

    const l2 = await loginAs(app, 'l2@a.test');
    expect((await l2.agent.get(`/api/v1/matters/${privateMatter.matterId}`)).status).toBe(404);
  });

  it('assignee without tasks.manage can complete their own task but not create, reassign or comment (read-only)', async () => {
    const { main, owner, uid } = await practiceFixture(app);
    const t = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ title: 'Review file', matterId: main.matterId, assigneeId: uid('viewer@a.test') });
    const viewer = await loginAs(app, 'viewer@a.test');
    const id = t.body.data.id;
    expect(
      (await viewer.agent.post('/api/v1/tasks').set('X-CSRF-Token', viewer.csrf).send({ title: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await viewer.agent
          .post(`/api/v1/tasks/${id}/reassign`)
          .set('X-CSRF-Token', viewer.csrf)
          .send({ assigneeId: null })
      ).status,
    ).toBe(403);
    expect(
      (
        await viewer.agent
          .post(`/api/v1/tasks/${id}/comments`)
          .set('X-CSRF-Token', viewer.csrf)
          .send({ body: 'hi' })
      ).status,
    ).toBe(403);
    const done = await viewer.agent
      .post(`/api/v1/tasks/${id}/complete`)
      .set('X-CSRF-Token', viewer.csrf)
      .send({});
    expect(done.body.data).toMatchObject({ status: 'done', completedBy: { userId: uid('viewer@a.test') } });
    expect(
      (await viewer.agent.post(`/api/v1/tasks/${id}/complete`).set('X-CSRF-Token', viewer.csrf).send({}))
        .status,
    ).toBe(409);
    const events = await pool.query(
      `SELECT count(*)::int n FROM outbox_events WHERE event_type = 'TASK_COMPLETED'`,
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('reassign, update status/due date, and comments', async () => {
    const { main, owner, uid, firm } = await practiceFixture(app);
    const t = await owner.agent
      .post('/api/v1/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ title: 'Draft reply', matterId: main.matterId, assigneeId: uid('l1@a.test') });
    const id = t.body.data.id;
    const re = await owner.agent
      .post(`/api/v1/tasks/${id}/reassign`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ assigneeId: uid('l2@a.test') });
    expect(re.body.data.assignee.userId).toBe(uid('l2@a.test'));
    const stranger = await pool.query(
      `INSERT INTO users (email, first_name) VALUES ('x@else.test', 'X') RETURNING id`,
    );
    const bad = await owner.agent
      .post(`/api/v1/tasks/${id}/reassign`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ assigneeId: stranger.rows[0].id });
    expect(bad.status).toBe(422);

    const upd = await owner.agent
      .patch(`/api/v1/tasks/${id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'in_progress', dueDate: '2026-12-01', priority: 'high' });
    expect(upd.body.data).toMatchObject({ status: 'in_progress', dueDate: '2026-12-01', priority: 'high' });
    const c = await owner.agent
      .post(`/api/v1/tasks/${id}/comments`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ body: 'Draft shared on email' });
    expect(c.body.data).toHaveLength(1);
    const tl = await owner.agent.get(`/api/v1/matters/${main.matterId}/timeline`);
    expect(tl.body.data.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['task.created', 'task.reassigned', 'task.status_changed']),
    );
    void firm;
  });
});
