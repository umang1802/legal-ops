import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { addDays, buildApp, createFirm, deps as baseDeps, loginAs, pool, practiceFixture, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin } from './platform-helpers.js';

useDatabase();
const app = buildApp();

const suspend = (orgId: string) =>
  pool.query(`UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = 'Unpaid' WHERE id = $1`, [orgId]);
const reactivate = (orgId: string) =>
  pool.query(`UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [orgId]);

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
}
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

describe('suspended firms are read-only', () => {
  it('reads and exports still work; /auth/me reports the status', async () => {
    const { firm, main } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    expect((await owner.agent.get('/api/v1/auth/me')).body.data.organization.status).toBe('suspended');
    expect((await owner.agent.get(`/api/v1/matters/${main.matterId}`)).status).toBe(200);
    expect((await owner.agent.get('/api/v1/clients')).status).toBe(200);
  });

  it('sweep: every write under every mounted prefix, and an unknown path, is refused', async () => {
    const { firm } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    const prefixes = ['/organization', '/clients', '/matters', '/cases', '/courts', '/search', '/hearings', '/tasks', '/dashboard',
      '/invoices', '/payments', '/expenses', '/fee-agreements', '/fee-milestones', '/billing', '/notifications', '/email-templates',
      '/workflows', '/no-such-route'];
    for (const prefix of prefixes) {
      for (const method of ['post', 'patch', 'delete'] as const) {
        const res = await owner.agent[method](`/api/v1${prefix}/anything`).set('X-CSRF-Token', owner.csrf).send({});
        expect({ prefix, method, code: res.body.error?.code }).toEqual({ prefix, method, code: 'FIRM_SUSPENDED' });
        expect(res.status).toBe(403);
      }
    }
  });

  it('logout and login still work while suspended', async () => {
    const { firm } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    expect((await owner.agent.post('/api/v1/auth/logout').set('X-CSRF-Token', owner.csrf).send({})).status).toBeLessThan(300);
  });

  it('multi-firm user: can switch to their active firm and write there', async () => {
    const { firm } = await practiceFixture(app);
    const other = await createFirm('Firm B', [{ email: 'owner@a.test', role: 'owner' }]);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    const switched = await owner.agent.post('/api/v1/auth/switch-organization').set('X-CSRF-Token', owner.csrf).send({ organizationId: other.orgId });
    expect(switched.status).toBe(200);
    const csrf = switched.body.data.csrfToken;
    const created = await owner.agent.post('/api/v1/clients').set('X-CSRF-Token', csrf).send({ name: 'New client' });
    expect(created.status).toBe(201);
  });

  it('reactivation: reminders due during suspension are skipped, nothing stale is sent, later ones resume', async () => {
    const { firm, owner, main, today } = await practiceFixture(app);
    await pool.query(`UPDATE clients SET email = 'raj@client.test' WHERE organization_id = $1`, [firm.orgId]);
    const email = new CaptureEmail();
    const deps = { ...baseDeps, email } as Deps;
    const date = addDays(today, 5);
    await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: date });
    await tick(deps, new Date());
    await suspend(firm.orgId);
    await tick(deps, ist(addDays(date, -1), '09:01')); // day-before client reminder falls due while suspended
    expect(email.sent.filter((m) => m.to === 'raj@client.test')).toHaveLength(0);
    const skipped = (await pool.query(`SELECT result->>'reason' AS reason FROM scheduled_actions WHERE status = 'skipped'`)).rows;
    expect(skipped.map((r) => r.reason)).toContain('Firm suspended');
    await reactivate(firm.orgId);
    await tick(deps, ist(addDays(date, -1), '09:02'));
    expect(email.sent.filter((m) => m.to === 'raj@client.test')).toHaveLength(0); // the skipped one is not resent
    await tick(deps, ist(date, '07:31'));
    expect(email.sent.filter((m) => m.to === 'raj@client.test').map((m) => m.subject)).toEqual([expect.stringMatching(/^Today:/)]);
  });

  it('token-based auth endpoints are not blocked by a suspended firm session', async () => {
    const { firm } = await practiceFixture(app);
    await suspend(firm.orgId);
    const owner = await loginAs(app, 'owner@a.test');
    const token = 'x'.repeat(43);
    const calls = [
      owner.agent.post('/api/v1/auth/forgot-password').set('X-CSRF-Token', owner.csrf).send({ email: 'owner@a.test' }),
      owner.agent.post('/api/v1/auth/reset-password').set('X-CSRF-Token', owner.csrf).send({ token, password: 'a-new-password-1' }),
      owner.agent.post('/api/v1/auth/verify-email').set('X-CSRF-Token', owner.csrf).send({ token }),
      owner.agent.post('/api/v1/auth/invitations/accept').set('X-CSRF-Token', owner.csrf).send({ token, firstName: 'A', password: 'a-new-password-1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.body.error?.code).not.toBe('FIRM_SUSPENDED');
  });

  it('reactivation skips actions that fell due during suspension even if the worker never ran', async () => {
    const { firm, owner, main, today } = await practiceFixture(app);
    await pool.query(`UPDATE clients SET email = 'raj@client.test' WHERE organization_id = $1`, [firm.orgId]);
    const email = new CaptureEmail();
    const deps = { ...baseDeps, email } as Deps;
    await owner.agent.post('/api/v1/hearings').set('X-CSRF-Token', owner.csrf).send({ caseId: main.caseId, scheduledDate: addDays(today, 5) });
    await tick(deps, new Date());
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const ops = await platformLogin(app, 'ops@lfx.test', secret);
    await ops.agent.post(`/api/v1/platform/firms/${firm.orgId}/suspend`).set('X-CSRF-Token', ops.csrf).send({ reason: 'Unpaid' });
    // The worker was down: the day-before client reminder became due during the suspension and was never claimed.
    await pool.query(`UPDATE scheduled_actions sa SET run_at = now() - interval '1 hour' FROM workflows w WHERE w.id = sa.workflow_id AND w.system_key = 'hearing_1d_client'`);
    await ops.agent.post(`/api/v1/platform/firms/${firm.orgId}/reactivate`).set('X-CSRF-Token', ops.csrf).send({});
    await tick(deps, new Date());
    expect(email.sent.filter((m) => m.to === 'raj@client.test')).toHaveLength(0);
  });
});
