import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, createFirm, loginAs, PASSWORD, pool, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();
const P = '/api/v1/platform';

const post = (s: PlatformSession, path: string, body: object = {}) => s.agent.post(`${P}${path}`).set('X-CSRF-Token', s.csrf).send(body);
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const accept = (token: string, firstName = 'Asha') =>
  request(app).post('/api/v1/auth/invitations/accept').send({ token, firstName, password: PASSWORD });

async function setup() {
  const { secret } = await createPlatformAdmin('ops@lfx.test');
  const ops = await platformLogin(app, 'ops@lfx.test', secret);
  const invited = await post(ops, '/firms', { firmName: 'Vidhimeya', partnerName: 'Asha Rao', partnerEmail: 'asha@vidhimeya.test' });
  expect(invited.status).toBe(201);
  return { ops, firmId: invited.body.data.id as string, ownerInviteId: invited.body.data.invitation.id as string };
}

describe('platform: invite links (email-free onboarding)', () => {
  it('lists a firm’s pending invitations, owner and team', async () => {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const ops = await platformLogin(app, 'ops@lfx.test', secret);
    const { orgId } = await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const owner = await loginAs(app, 'owner@a.test');
    await owner.agent.post('/api/v1/organization/members/invite').set('X-CSRF-Token', owner.csrf).send({ email: 'clerk@a.test', role: 'staff' });
    const res = await ops.agent.get(`${P}/firms/${orgId}/invitations`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ email: 'clerk@a.test', role: 'staff', invitedBy: 'owner', expired: false }),
    ]);
  });

  it('a generated link lets the invitee join, and is audited without the token', async () => {
    const { ops, firmId, ownerInviteId } = await setup();
    const res = await post(ops, `/firms/${firmId}/invitations/${ownerInviteId}/link`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'asha@vidhimeya.test', role: 'owner' });
    expect(res.body.data.url).toMatch(/\/accept-invite\?token=[A-Za-z0-9_-]{32,}$/);
    expect((await accept(tokenOf(res.body.data.url))).status).toBe(200);
    const firm = await ops.agent.get(`${P}/firms/${firmId}`);
    expect(firm.body.data).toMatchObject({ status: 'active', ownerEmail: 'asha@vidhimeya.test' });
    const audit = (await pool.query(`SELECT action, details FROM platform_audit_logs WHERE action = 'invite.link_issued'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ invitationId: ownerInviteId, email: 'asha@vidhimeya.test', role: 'owner' });
    expect(JSON.stringify(audit[0].details)).not.toContain(tokenOf(res.body.data.url));
  });

  it('a new link cancels the previous one and resets the 7-day expiry', async () => {
    const { ops, firmId, ownerInviteId } = await setup();
    await pool.query(`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [ownerInviteId]);
    const first = await post(ops, `/firms/${firmId}/invitations/${ownerInviteId}/link`);
    const second = await post(ops, `/firms/${firmId}/invitations/${ownerInviteId}/link`);
    expect((await accept(tokenOf(first.body.data.url))).status).toBe(400);
    expect((await accept(tokenOf(second.body.data.url))).status).toBe(200);
    const exp = Date.parse(second.body.data.expiresAt);
    expect(exp - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it('refuses accepted or revoked invitations, unknown ids, other firms’ invitations and suspended firms', async () => {
    const { ops, firmId, ownerInviteId } = await setup();
    const other = await createFirm('Other', [{ email: 'o@other.test', role: 'owner' }]);
    expect((await post(ops, `/firms/${other.orgId}/invitations/${ownerInviteId}/link`)).status).toBe(404);
    expect((await post(ops, `/firms/${firmId}/invitations/00000000-0000-0000-0000-000000000000/link`)).status).toBe(404);

    const link = await post(ops, `/firms/${firmId}/invitations/${ownerInviteId}/link`);
    await accept(tokenOf(link.body.data.url));
    expect((await post(ops, `/firms/${firmId}/invitations/${ownerInviteId}/link`)).status).toBe(409);

    const owner = await loginAs(app, 'asha@vidhimeya.test');
    const team = await owner.agent.post('/api/v1/organization/members/invite').set('X-CSRF-Token', owner.csrf).send({ email: 'assoc@vidhimeya.test', role: 'lawyer' });
    const teamInviteId = team.body.data.invitationId as string;
    await post(ops, `/firms/${firmId}/suspend`, { reason: 'Unpaid' });
    expect((await post(ops, `/firms/${firmId}/invitations/${teamInviteId}/link`)).status).toBe(409);
    await post(ops, `/firms/${firmId}/reactivate`);
    await pool.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1`, [teamInviteId]);
    expect((await post(ops, `/firms/${firmId}/invitations/${teamInviteId}/link`)).status).toBe(409);
  });

  it('only verified platform admins can list invitations or mint links', async () => {
    const { firmId, ownerInviteId } = await setup();
    await createFirm('Firm A', [{ email: 'owner@a.test', role: 'owner' }]);
    const firmUser = await loginAs(app, 'owner@a.test');
    expect((await firmUser.agent.get(`${P}/firms/${firmId}/invitations`)).status).toBe(401);
    expect((await firmUser.agent.post(`${P}/firms/${firmId}/invitations/${ownerInviteId}/link`).set('X-CSRF-Token', firmUser.csrf).send({})).status).toBe(401);
  });
});
