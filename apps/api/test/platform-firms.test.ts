import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { issueInvitationToken } from '../src/modules/auth/auth.service.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { buildApp, createFirm, deps as baseDeps, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
}
const post = (s: PlatformSession, path: string, body: object = {}) => s.agent.post(`${P}${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function ops() {
  const { secret } = await createPlatformAdmin('ops@lfx.test');
  return platformLogin(app, 'ops@lfx.test', secret);
}
async function invite(s: PlatformSession, email = 'partner@vidhimeya.test') {
  const res = await post(s, '/firms', { firmName: 'Vidhimeya', partnerName: 'Asha Rao', partnerEmail: email });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; invitation: { id: string } };
}

describe('platform: firms', () => {
  it('invite creates an invited firm, emails the partner a set-up link, and is audited', async () => {
    const s = await ops();
    const firm = await invite(s);
    expect(firm).toMatchObject({ name: 'Vidhimeya', status: 'invited', inviteEmail: 'partner@vidhimeya.test', invitation: { state: 'pending' } });
    const email = new CaptureEmail();
    await tick({ ...baseDeps, email } as Deps, new Date());
    const [m] = email.sent;
    expect(m!.to).toBe('partner@vidhimeya.test');
    expect(m!.subject).toBe('Set up Vidhimeya on LexForgeX');
    expect(m!.text).toMatch(/Hello Asha/);
    expect(m!.text).toMatch(/accept-invite\?token=/);
    const audit = await s.agent.get(`${P}/audit-logs`).query({ organizationId: firm.id });
    expect(audit.body.data.map((a: { action: string }) => a.action)).toContain('firm.invited');
  });

  it('accepting the owner invite makes the partner owner and the firm active', async () => {
    const s = await ops();
    const firm = await invite(s);
    const token = await issueInvitationToken(baseDeps, firm.invitation.id);
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token, firstName: 'Asha', password: PASSWORD });
    expect(acc.status).toBe(200);
    const detail = await s.agent.get(`${P}/firms/${firm.id}`);
    expect(detail.body.data).toMatchObject({ status: 'active', ownerEmail: 'partner@vidhimeya.test', userCount: 1, invitation: { state: 'accepted' } });
  });

  it('existing user: accepting adds them as owner of the new firm without changing their password', async () => {
    await createFirm('Other firm', [{ email: 'asha@shared.test', role: 'lawyer' }]);
    const before = (await pool.query(`SELECT password_hash FROM users WHERE email = 'asha@shared.test'`)).rows[0].password_hash;
    const s = await ops();
    const firm = await invite(s, 'asha@shared.test');
    const token = await issueInvitationToken(baseDeps, firm.invitation.id);
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token, firstName: 'Asha', password: 'a-different-password-1' });
    expect(acc.status).toBe(200);
    expect((await pool.query(`SELECT password_hash FROM users WHERE email = 'asha@shared.test'`)).rows[0].password_hash).toBe(before);
    expect((await s.agent.get(`${P}/firms/${firm.id}`)).body.data.status).toBe('active');
    const me = await loginAs(app, 'asha@shared.test');
    const mine = await me.agent.get('/api/v1/auth/me');
    expect(mine.body.data.memberships.map((x: { organizationName: string }) => x.organizationName)).toEqual(expect.arrayContaining(['Other firm', 'Vidhimeya']));
  });

  it('resend voids the old link; revoke then re-invite to a corrected email', async () => {
    const s = await ops();
    const firm = await invite(s, 'typo@vidhimeya.test');
    const oldToken = await issueInvitationToken(baseDeps, firm.invitation.id);
    expect((await post(s, `/firms/${firm.id}/invitation/resend`)).status).toBe(200);
    await tick({ ...baseDeps, email: new CaptureEmail() } as Deps, new Date()); // sending mints the new link
    const stale = await request(app).post('/api/v1/auth/invitations/accept').send({ token: oldToken, firstName: 'X', password: PASSWORD });
    expect(stale.status).toBe(400);
    const revoked = await post(s, `/firms/${firm.id}/invitation/revoke`);
    expect(revoked.body.data.invitation.state).toBe('revoked');
    const re = await post(s, `/firms/${firm.id}/invitation`, { partnerName: 'Asha Rao', partnerEmail: 'asha@vidhimeya.test' });
    expect(re.body.data).toMatchObject({ status: 'invited', inviteEmail: 'asha@vidhimeya.test', invitation: { state: 'pending', email: 'asha@vidhimeya.test' } });
  });

  it('notes are saved for the team and never shown to the firm', async () => {
    const s = await ops();
    const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const saved = await s.agent.patch(`${P}/firms/${orgId}`).set('X-CSRF-Token', s.csrf).send({ platformNotes: 'Paid ₹60,000 till 31 Mar 2027' });
    expect(saved.body.data.platformNotes).toBe('Paid ₹60,000 till 31 Mar 2027');
    const owner = await loginAs(app, 'owner@a.test');
    const org = await owner.agent.get('/api/v1/organization');
    expect(JSON.stringify(org.body)).not.toContain('60,000');
  });

  it('suspend needs a reason and an active firm; reactivate only from suspended; both audited', async () => {
    const s = await ops();
    const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    expect((await post(s, `/firms/${orgId}/suspend`, {})).status).toBe(422);
    const sus = await post(s, `/firms/${orgId}/suspend`, { reason: 'Unpaid since September' });
    expect(sus.body.data).toMatchObject({ status: 'suspended', suspendedReason: 'Unpaid since September' });
    expect((await post(s, `/firms/${orgId}/suspend`, { reason: 'again' })).status).toBe(409);
    const re = await post(s, `/firms/${orgId}/reactivate`);
    expect(re.body.data).toMatchObject({ status: 'active', suspendedAt: null, suspendedReason: null });
    expect((await post(s, `/firms/${orgId}/reactivate`)).status).toBe(409);
    const actions = (await s.agent.get(`${P}/audit-logs`).query({ organizationId: orgId })).body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['firm.suspended', 'firm.reactivated']));
  });

  it('lists firms with counts, search and status filter', async () => {
    const s = await ops();
    await createFirm('Alpha Legal', [{ email: 'o@alpha.test', role: 'owner' }, { email: 'l@alpha.test', role: 'lawyer' }]);
    await invite(s);
    const all = await s.agent.get(`${P}/firms`);
    expect(all.body.meta.total).toBe(2);
    const alpha = all.body.data.find((f: { name: string }) => f.name === 'Alpha Legal');
    expect(alpha).toMatchObject({ status: 'active', userCount: 2, caseCount: 0, ownerEmail: 'o@alpha.test' });
    expect((await s.agent.get(`${P}/firms`).query({ search: 'vidhi' })).body.data.map((f: { name: string }) => f.name)).toEqual(['Vidhimeya']);
    expect((await s.agent.get(`${P}/firms`).query({ status: 'invited' })).body.meta.total).toBe(1);
  });

  it('unknown firm id is a 404, not a 500', async () => {
    const s = await ops();
    expect((await s.agent.get(`${P}/firms/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
  });
});
