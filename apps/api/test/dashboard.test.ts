import { describe, expect, it } from 'vitest';
import { addDays, buildApp, loginAs, practiceFixture, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

describe('dashboard', () => {
  it('lawyer sees only assigned matters and own tasks; owner sees the firm; money stays null', async () => {
    const { main, privateMatter, owner, uid, today } = await practiceFixture(app);
    const post = (path: string, body: Record<string, unknown>) =>
      owner.agent.post(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);

    await post('/hearings', { caseId: main.caseId, scheduledDate: today, startTime: '10:30' });
    await post('/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 1) });
    await post('/hearings', { caseId: main.caseId, scheduledDate: addDays(today, -3) }); // pending outcome
    await post('/hearings', { caseId: privateMatter.caseId, scheduledDate: today }); // not visible to l1
    await post('/tasks', {
      title: 'Due today',
      matterId: main.matterId,
      assigneeId: uid('l1@a.test'),
      dueDate: today,
    });
    await post('/tasks', {
      title: 'Overdue',
      matterId: main.matterId,
      assigneeId: uid('l1@a.test'),
      dueDate: addDays(today, -1),
    });
    await post('/tasks', {
      title: 'Someone else’s',
      matterId: main.matterId,
      assigneeId: uid('clerk@a.test'),
      dueDate: today,
    });

    const l1 = await loginAs(app, 'l1@a.test');
    const d = (await l1.agent.get('/api/v1/dashboard')).body.data;
    expect(d.today).toBe(today);
    expect(d.scope).toBe('mine');
    expect(d.counts).toEqual({
      hearingsToday: 1,
      tasksDueToday: 1,
      overdueTasks: 1,
      pendingOutcomes: 1,
      outstanding: null,
      overdueAmount: null,
    });
    expect(d.upcomingHearings.map((h: { scheduledDate: string }) => h.scheduledDate)).toEqual([
      addDays(today, 1),
    ]);
    expect(d.recentChanges.every((e: { matter: { id: string } }) => e.matter.id === main.matterId)).toBe(
      true,
    );

    const o = (await owner.agent.get('/api/v1/dashboard')).body.data;
    expect(o.scope).toBe('firm');
    expect(o.counts.hearingsToday).toBe(2);
    expect(o.counts.tasksDueToday).toBe(2);
  });
});
