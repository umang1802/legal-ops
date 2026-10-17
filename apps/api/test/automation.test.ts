import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { ProviderError, type EmailMessage, type EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { addDays, buildApp, deps as baseDeps, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

/** Records what would have been emailed; can be told to fail. */
class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  failWith: 'transient' | 'permanent' | null = null;
  async send(m: EmailMessage) {
    if (this.failWith) throw new ProviderError(`simulated ${this.failWith} failure`, this.failWith === 'permanent');
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
  to(addr: string) {
    return this.sent.filter((m) => m.to === addr);
  }
}

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
/** A firm-local (IST) wall-clock instant. */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

async function setup() {
  const fx = await practiceFixture(app);
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId])).rows[0].client_id as string;
  await pool.query(`UPDATE clients SET email = 'raj@client.test' WHERE id = $1`, [clientId]);
  const email = new CaptureEmail();
  const deps: Deps = { ...baseDeps, email };
  const run = (at: Date) => tick(deps, at);
  return { ...fx, clientId, email, deps, run };
}

const statusOf = async (where: string, params: unknown[] = []) =>
  (await pool.query(`SELECT notification_type, status, skip_reason, destination FROM notifications WHERE ${where} ORDER BY created_at`, params)).rows;

describe('automations: hearing reminders (pilot test 2)', () => {
  it('plans reminders from the hearing date and sends each one once, at its time', async () => {
    const { owner, main, today, email, run } = await setup();
    const date = addDays(today, 5);
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date, startTime: '10:30' });
    expect(h.status).toBe(201);

    await run(new Date());
    // 7-days-before is already in the past for a hearing 5 days out, so it isn't planned late.
    const planned = (await pool.query(`SELECT w.system_key, sa.run_at FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id WHERE sa.status = 'scheduled' ORDER BY sa.run_at`)).rows;
    expect(planned.map((p) => p.system_key)).toEqual(['hearing_3d_team', 'hearing_1d_client', 'hearing_morning_lead']);
    expect(planned[1].run_at.toISOString()).toBe(ist(addDays(date, -1), '09:00').toISOString());

    await run(ist(addDays(date, -1), '08:59'));
    expect(email.to('raj@client.test')).toHaveLength(0);
    expect(email.to('l1@a.test')).toHaveLength(1); // 3-day team reminder: lead…
    expect(email.to('clerk@a.test')).toHaveLength(1); // …and the clerk on the matter

    await run(ist(addDays(date, -1), '09:01'));
    const client = email.to('raj@client.test');
    expect(client).toHaveLength(1);
    expect(client[0]!.subject).toMatch(/hearing/i);
    expect(client[0]!.text).toContain('10:30');

    // Re-running the same moment (worker restart, double tick) sends nothing new.
    await run(ist(addDays(date, -1), '09:01'));
    expect(email.to('raj@client.test')).toHaveLength(1);

    const tl = (await pool.query(`SELECT event_type FROM timeline_events WHERE matter_id = $1 AND event_type = 'notification.sent'`, [main.matterId])).rows;
    expect(tl.length).toBeGreaterThanOrEqual(1);
  });

  it('a rescheduled hearing cancels the old reminders and plans new ones', async () => {
    const { owner, main, today, email, run } = await setup();
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 4) });
    await run(new Date());
    await owner.agent.patch(`/api/v1/hearings/${h.body.data.id}`).set('X-CSRF-Token', owner.csrf).send({ scheduledDate: addDays(today, 10) });
    await run(new Date());

    const rows = (await pool.query(`SELECT status, cancel_reason, payload->>'anchor' AS anchor FROM scheduled_actions WHERE target_id = $1`, [h.body.data.id])).rows;
    expect(rows.filter((r) => r.status === 'cancelled').every((r) => r.cancel_reason === 'Hearing rescheduled')).toBe(true);
    expect(rows.filter((r) => r.status === 'scheduled').every((r) => r.anchor === addDays(today, 10))).toBe(true);
    expect(rows.filter((r) => r.status === 'scheduled')).toHaveLength(4); // 7d, 3d, 1d, morning

    // The old "day before" moment passes quietly.
    await run(ist(addDays(today, 3), '09:30'));
    expect(email.to('raj@client.test')).toHaveLength(0);
  });

  it('a client who opted out is skipped, and the skip is visible on the matter', async () => {
    const { owner, main, today, clientId, email, run } = await setup();
    await pool.query(`UPDATE clients SET email_notifications_enabled = false WHERE id = $1`, [clientId]);
    const date = addDays(today, 3);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date });
    await run(new Date());
    await run(ist(addDays(date, -1), '09:30'));
    expect(email.to('raj@client.test')).toHaveLength(0);
    expect(await statusOf(`recipient_type = 'client'`)).toEqual([
      expect.objectContaining({ notification_type: 'hearing_reminder_client', status: 'skipped', skip_reason: 'client_opted_out' }),
    ]);
    const tl = await pool.query(`SELECT 1 FROM timeline_events WHERE matter_id = $1 AND event_type = 'notification.skipped'`, [main.matterId]);
    expect(tl.rowCount).toBe(1);
  });
});

describe('automations: hearing outcome (pilot test 3)', () => {
  async function completedHearing(approval: boolean) {
    const s = await setup();
    if (approval) {
      await s.run(new Date()); // seeds default automations
      await pool.query(`UPDATE workflows SET requires_approval = true WHERE system_key = 'hearing_outcome_client'`);
    }
    const h = await post(s.owner, '/hearings', { caseId: s.main.caseId, scheduledDate: s.today });
    const done = await post(s.owner, `/hearings/${h.body.data.id}/complete`, {
      result: 'adjourned',
      outcome: 'Adjourned at request of respondent',
      nextHearingDate: addDays(s.today, 12),
    });
    expect(done.status).toBe(200);
    await s.run(new Date());
    return s;
  }

  it('emails the client the next date right away', async () => {
    const { email } = await completedHearing(false);
    const m = email.to('raj@client.test').find((x) => /next/i.test(x.subject) || /next/i.test(x.text));
    expect(m).toBeTruthy();
  });

  it('in approval mode, holds the message until a lawyer releases it', async () => {
    const { email, run } = await completedHearing(true);
    expect(email.to('raj@client.test').filter((m) => /next/i.test(m.text))).toHaveLength(0);
    const [held] = (await pool.query(`SELECT id FROM notifications WHERE status = 'awaiting_approval'`)).rows;
    expect(held).toBeTruthy();

    const l1 = await loginAs(app, 'l1@a.test');
    const list = await l1.agent.get('/api/v1/notifications').query({ status: 'awaiting_approval' });
    expect(list.body.data.map((n: { id: string }) => n.id)).toContain(held.id);
    const ok = await post(l1, `/notifications/${held.id}/approve`);
    expect(ok.status).toBe(200);
    await run(new Date());
    expect(email.to('raj@client.test').filter((m) => /next/i.test(m.text))).toHaveLength(1);
    expect((await post(l1, `/notifications/${held.id}/approve`)).status).toBe(409);
  });
});

describe('automations: invoices (pilot tests 4 and 6)', () => {
  async function invoiceSetup() {
    const s = await setup();
    const fin = await loginAs(app, 'finance@a.test');
    const dueDate = addDays(s.today, 10);
    const inv = await post(fin, '/invoices', { matterId: s.main.matterId, dueDate, items: [{ description: 'Professional fees', unitPrice: '50000' }], issue: true });
    expect(inv.status).toBe(201);
    await s.run(new Date());
    return { ...s, fin, inv: inv.body.data, dueDate };
  }

  it('emails the invoice on issue, then one reminder per threshold, never twice', async () => {
    const { email, run, dueDate } = await invoiceSetup();
    expect(email.to('raj@client.test').map((m) => m.subject).join()).toMatch(/invoice/i);
    expect(email.to('raj@client.test')).toHaveLength(1);

    await run(ist(addDays(dueDate, 3), '10:05')); // test clock: past due + 3 days
    // -3, 0 and +3 reminders were all due by now.
    expect(email.to('raj@client.test')).toHaveLength(4);
    await run(ist(addDays(dueDate, 3), '10:05'));
    expect(email.to('raj@client.test')).toHaveLength(4);

    await run(ist(addDays(dueDate, 7), '10:05'));
    expect(email.to('raj@client.test')).toHaveLength(5);
    expect(email.to('l1@a.test').some((m) => /overdue/i.test(m.subject))).toBe(true);
    await run(ist(addDays(dueDate, 15), '10:05'));
    expect(email.to('owner@a.test').some((m) => /overdue/i.test(m.subject))).toBe(true);
  });

  it('stops reminding once paid, and confirms the payment', async () => {
    const { email, run, fin, clientId, inv, dueDate, today } = await invoiceSetup();
    const pay = await post(fin, '/payments', {
      clientId,
      amount: '50000',
      paymentDate: today,
      method: 'upi',
      allocations: [{ invoiceId: inv.id, amount: '50000' }],
    });
    expect(pay.status).toBe(201);
    await run(new Date());
    expect(email.to('raj@client.test').some((m) => /payment|receipt/i.test(m.subject))).toBe(true);
    const before = email.to('raj@client.test').length;

    await run(ist(addDays(dueDate, 20), '10:05'));
    expect(email.to('raj@client.test')).toHaveLength(before);
    const left = await pool.query(`SELECT count(*)::int AS n FROM scheduled_actions WHERE target_id = $1 AND status = 'scheduled'`, [inv.id]);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('automations: delivery', () => {
  it('retries transient failures with backoff, fails permanent ones, and a person can retry', async () => {
    const { owner, main, clientId, email, run } = await setup();
    email.failWith = 'transient';
    const sent = await post(owner, '/notifications/send-email', { clientId, matterId: main.matterId, customNote: 'Documents received.' });
    expect(sent.status).toBe(201);
    const id = sent.body.data.id as string;
    const t0 = new Date();
    await run(t0);
    let n = (await pool.query(`SELECT status, attempts, scheduled_at FROM notifications WHERE id = $1`, [id])).rows[0];
    expect(n).toMatchObject({ status: 'queued', attempts: 1 });
    expect(n.scheduled_at.getTime()).toBeGreaterThan(t0.getTime());

    email.failWith = 'permanent';
    await run(new Date(t0.getTime() + 2 * 60_000));
    n = (await pool.query(`SELECT status, failure_reason FROM notifications WHERE id = $1`, [id])).rows[0];
    expect(n.status).toBe('failed');

    email.failWith = null;
    expect((await post(owner, `/notifications/${id}/retry`)).status).toBe(200);
    await run(new Date(Date.now() + 1000));
    expect(email.to('raj@client.test')).toHaveLength(1);
    expect(email.to('raj@client.test')[0]!.text).toContain('Documents received.');
  });

  it('password reset links are minted at send time and never stored', async () => {
    const { email, run } = await setup();
    const r = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'l1@a.test' });
    expect(r.status).toBeLessThan(300);
    await run(new Date());
    const [m] = email.to('l1@a.test');
    expect(m!.text).toMatch(/reset-password\?token=[\w-]{20,}/);
    const stored = (await pool.query(`SELECT body_html, body_text FROM notifications WHERE notification_type = 'password_reset'`)).rows[0];
    expect(JSON.stringify(stored)).not.toMatch(/token=/);
  });

  it('task assignment emails the assignee, but not when you assign yourself', async () => {
    const { owner, main, email, run, uid } = await setup();
    await post(owner, '/tasks', { title: 'File vakalatnama', matterId: main.matterId, assigneeId: uid('l1@a.test') });
    const l1 = await loginAs(app, 'l1@a.test');
    await post(l1, '/tasks', { title: 'Read the file', matterId: main.matterId, assigneeId: uid('l1@a.test') });
    await run(new Date());
    expect(email.to('l1@a.test').map((m) => m.subject)).toEqual([expect.stringMatching(/vakalatnama/i)]);
  });
});

describe('automations: settings API', () => {
  it('owners see the default recipes, can test and switch them; lawyers cannot', async () => {
    const { owner, main, today } = await setup();
    const list = await owner.agent.get('/api/v1/workflows');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(13);
    const dayBefore = list.body.data.find((w: { systemKey: string }) => w.systemKey === 'hearing_1d_client');

    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 6) });
    const dry = await post(owner, `/workflows/${dayBefore.id}/dry-run`);
    expect(dry.body.data).toMatchObject({ conditionsMet: true, note: null });
    expect(dry.body.data.plan[0].runAt).toBe(ist(addDays(today, 5), '09:00').toISOString());

    const off = await post(owner, `/workflows/${dayBefore.id}/active`, { isActive: false });
    expect(off.body.data.isActive).toBe(false);

    const bad = await post(owner, '/workflows', {
      name: 'Bad',
      triggerType: 'HEARING_SCHEDULED',
      triggerConfig: { timing: 'immediate' },
      actions: [{ type: 'notify', channel: 'email', recipient: 'client', templateKey: 'nope_missing' }],
    });
    expect(bad.status).toBe(422);

    const l1 = await loginAs(app, 'l1@a.test');
    expect((await l1.agent.get('/api/v1/workflows')).status).toBe(403);
  });

  it('a switched-off automation sends nothing even if already planned', async () => {
    const { owner, main, today, email, run } = await setup();
    const date = addDays(today, 3);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: date });
    await run(new Date());
    await pool.query(`UPDATE workflows SET is_active = false WHERE system_key = 'hearing_1d_client'`);
    await run(ist(addDays(date, -1), '09:30'));
    expect(email.to('raj@client.test')).toHaveLength(0);
  });

  it('the dev test clock endpoint runs a pass', async () => {
    const { owner } = await setup();
    const res = await post(owner, '/dev/worker/tick', { asOf: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('events');
  });
});
