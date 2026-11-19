import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { type EmailMessage, type EmailProvider } from '../src/modules/notifications/providers.js';
import { DEFAULT_WORKFLOWS, ensureDefaultWorkflows } from '../src/modules/workflows/defaults.js';
import { tick } from '../src/modules/workflows/processor.js';
import {
  addDays,
  buildApp,
  deps as baseDeps,
  pool,
  practiceFixture,
  type Session,
  useDatabase,
} from './helpers.js';

useDatabase();
const app = buildApp();

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
  to(addr: string) {
    return this.sent.filter((m) => m.to === addr);
  }
}

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function setup() {
  const fx = await practiceFixture(app);
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId]))
    .rows[0].client_id as string;
  await pool.query(`UPDATE clients SET email = 'raj@client.test' WHERE id = $1`, [clientId]);
  const email = new CaptureEmail();
  const deps: Deps = { ...baseDeps, email };
  const run = (at: Date = new Date()) => tick(deps, at);
  const added = (to: string) =>
    email.to(to).filter((m) => /^(Hearing scheduled|New hearing):/.test(m.subject));
  return { ...fx, clientId, email, deps, run, added };
}

describe('mail when a hearing is added', () => {
  it('tells the client and the matter team, with the date, court and type', async () => {
    const { owner, main, today, run, added, email } = await setup();
    const date = addDays(today, 20);
    expect(
      (
        await post(owner, '/hearings', {
          caseId: main.caseId,
          scheduledDate: date,
          startTime: '10:30',
          courtroom: '12',
          hearingType: 'Arguments',
        })
      ).status,
    ).toBe(201);
    await run();

    const client = added('raj@client.test');
    expect(client).toHaveLength(1);
    expect(client[0]!.subject).toMatch(/^Hearing scheduled: Sharma v ABC on /);
    expect(client[0]!.text).toContain('10:30');
    expect(client[0]!.text).toContain('CS 12/2026');
    expect(client[0]!.text).toContain('Purpose: Arguments');
    expect(client[0]!.text).not.toContain('{{'); // every variable was filled in

    // the matter's lead and its clerk; the partner isn't on this matter
    for (const member of ['l1@a.test', 'clerk@a.test']) {
      const mail = added(member);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toMatch(/^New hearing: CS 12\/2026 \(Sharma v ABC\) on /);
      expect(mail[0]!.text).toContain('court room 12');
    }
    expect(added('owner@a.test')).toHaveLength(0);
    expect(added('l2@a.test')).toHaveLength(0);

    // running the worker again (restart, double tick) doesn't send it twice
    await run();
    expect(added('raj@client.test')).toHaveLength(1);
    expect(email.sent.filter((m) => /^New hearing:/.test(m.subject))).toHaveLength(2);
  });

  it('leaves the type line out when there is no type, and respects a client who opted out of email', async () => {
    const { owner, main, today, clientId, run, added } = await setup();
    await pool.query(`UPDATE clients SET email_notifications_enabled = false WHERE id = $1`, [clientId]);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 20) });
    await run();
    expect(added('raj@client.test')).toHaveLength(0);
    expect(added('l1@a.test')[0]!.text).not.toContain('Purpose:');
    const skipped = (
      await pool.query(`SELECT skip_reason FROM notifications WHERE destination = 'raj@client.test'`)
    ).rows;
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('is not sent again when the hearing is rescheduled', async () => {
    const { owner, main, today, run, added } = await setup();
    const h = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 20) });
    await run();
    expect(added('raj@client.test')).toHaveLength(1);
    expect(
      (await patch(owner, `/hearings/${h.body.data.id}`, { scheduledDate: addDays(today, 25) })).status,
    ).toBe(200);
    await run(new Date(Date.now() + 60_000));
    expect(added('raj@client.test')).toHaveLength(1);
    expect(added('l1@a.test')).toHaveLength(1);
  });

  it('is not sent for the next date entered while recording a hearing: that update already tells the client', async () => {
    const { owner, main, today, run, added, email } = await setup();
    const first = await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: today });
    await run();
    const before = added('raj@client.test').length;
    expect(before).toBe(1); // the first hearing, added directly
    const done = await post(owner, `/hearings/${first.body.data.id}/complete`, {
      result: 'adjourned',
      outcome: 'Adjourned for arguments',
      clientSummary: 'Adjourned to the next date.',
      nextHearingDate: addDays(today, 30),
    });
    expect(done.status).toBe(200);
    await run(new Date(Date.now() + 60_000));
    expect(added('raj@client.test')).toHaveLength(before); // no second "hearing scheduled" for the follow-up
    expect(added('l1@a.test')).toHaveLength(before);
    expect(email.to('raj@client.test').some((m) => /^Case update:/.test(m.subject))).toBe(true); // the outcome update did go out
  });

  it('each automation can be switched off on its own', async () => {
    const { owner, main, today, run, added } = await setup();
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 20) });
    await run(); // seeds the automations and sends for the first hearing
    const list = (await owner.agent.get('/api/v1/workflows')).body.data as {
      id: string;
      systemKey: string;
    }[];
    const client = list.find((w) => w.systemKey === 'hearing_added_client')!;
    expect((await post(owner, `/workflows/${client.id}/active`, { isActive: false })).status).toBe(200);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: addDays(today, 22) });
    await run(new Date(Date.now() + 60_000));
    expect(added('raj@client.test')).toHaveLength(1); // only the first
    expect(added('l1@a.test')).toHaveLength(2); // the team automation is still on
  });
});

describe('mail when a hearing is added: firms that already have hearings', () => {
  it('the first time a firm is offered these automations, hearings already on its calendar are not emailed about', async () => {
    const { firm, owner, main, today, run, added } = await setup();
    // A firm from before this feature: it has the older automations only, and has never been offered the new ones.
    const NEW = ['hearing_added_client', 'hearing_added_team'];
    await ensureDefaultWorkflows(
      pool,
      firm.orgId,
      null,
      DEFAULT_WORKFLOWS.filter((d) => !NEW.includes(d.key)),
    );
    await pool.query(
      `UPDATE organizations SET settings = jsonb_build_object('seededWorkflowKeys', $2::jsonb) WHERE id = $1`,
      [firm.orgId, JSON.stringify(DEFAULT_WORKFLOWS.map((d) => d.key).filter((k) => !NEW.includes(k)))],
    );

    const old1 = addDays(today, 15);
    const old2 = addDays(today, 16);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: old1 });
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: old2 });
    // Before the deploy these were handled by the older code, which didn't know the new automations.
    await pool.query(`UPDATE outbox_events SET status = 'processed', processed_at = now()`);
    expect(
      (await pool.query(`SELECT 1 FROM workflows WHERE system_key = 'hearing_added_client'`)).rowCount,
    ).toBe(0);

    // The firm is now offered the new automations (on the next event) — and only a hearing added from now on is announced.
    const fresh = addDays(today, 21);
    await post(owner, '/hearings', { caseId: main.caseId, scheduledDate: fresh });
    await run(new Date(Date.now() + 60_000));
    const mails = added('raj@client.test');
    expect(mails).toHaveLength(1);
    const day = (d: string) =>
      new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        weekday: 'short',
        timeZone: 'UTC',
      }).format(new Date(`${d}T00:00:00Z`));
    expect(mails[0]!.subject).toContain(day(fresh));
    expect(mails[0]!.subject).not.toContain(day(old1));
    expect(mails[0]!.subject).not.toContain(day(old2));
    expect(added('l1@a.test')).toHaveLength(1);
    expect(
      (await pool.query(`SELECT 1 FROM workflows WHERE system_key = 'hearing_added_client'`)).rowCount,
    ).toBe(1);
  });
});
