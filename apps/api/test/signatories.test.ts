import { describe, expect, it } from 'vitest';
import { loadInvoiceDocData } from '../src/modules/billing/pdf/invoice-pdf.js';
import { buildApp, deps, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 1)]);
const PNG2 = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 9)]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(300, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(300, 3)]);
const MAX = 512_000;
const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) => s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const binary = (res: import('supertest').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function setup() {
  const fx = await practiceFixture(app);
  const fin = await loginAs(app, 'finance@a.test');
  const l1 = await loginAs(app, 'l1@a.test');
  const l2 = await loginAs(app, 'l2@a.test');
  const member = (email: string) => fx.firm.users[email]!.memberId;
  const ctx = { userId: fx.uid('owner@a.test'), organizationId: fx.firm.orgId, role: 'owner' as const, features: [] };
  return { ...fx, fin, l1, l2, member, ctx };
}
type Fx = Awaited<ReturnType<typeof setup>>;

const stagingKey = (orgId: string, userId: string, uploadId: string) => `incoming/signatures/${orgId}/${userId}/${uploadId}`;

/** Start → (the browser's PUT) → complete, for the member `memberId` (belonging to user `userId`). */
async function upload(s: Session, fx: Fx, memberId: string, userId: string, bytes: Buffer, contentType = 'image/png') {
  const start = await post(s, `/organization/members/${memberId}/signature/uploads`, { contentType, sizeBytes: Math.min(bytes.length, MAX) });
  if (start.status !== 201) return { start, done: null, key: null };
  const key = stagingKey(fx.firm.orgId, userId, start.body.data.uploadId);
  storage.putDirect(key, bytes);
  const done = await post(s, `/organization/members/${memberId}/signature/uploads/${start.body.data.uploadId}/complete`);
  return { start, done, key };
}
const draft = async (fx: Fx) =>
  (await post(fx.fin, '/invoices', { matterId: fx.main.matterId, items: [{ description: 'Fees', unitPrice: '1000' }] })).body.data.id as string;
const row = async (id: string) => (await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id])).rows[0];
const sigKey = async (memberId: string) => (await pool.query(`SELECT signature_key FROM organization_members WHERE id = $1`, [memberId])).rows[0].signature_key as string | null;

describe('signatories', () => {
  it('member uploads own signature; GET returns it', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    const { start, done } = await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG);
    expect(start.status).toBe(201);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(done!.status).toBe(200);
    expect(done!.body.data).toMatchObject({ hasSignature: true });
    const key = (await sigKey(m))!;
    expect(key).toMatch(new RegExp(`^signatures/${fx.firm.orgId}/${fx.uid('l1@a.test')}/[0-9a-f-]{36}\\.png$`));
    // any firm member can preview it
    const got = await fx.fin.agent.get(`/api/v1/organization/members/${m}/signature`).buffer(true).parse(binary);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect((got.body as Buffer).equals(PNG)).toBe(true);
    const list = (await fx.owner.agent.get('/api/v1/organization/members')).body.data;
    expect(list.find((x: { id: string }) => x.id === m).hasSignature).toBe(true);
    const a = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'member.signature_updated' AND entity_id = $1`, [m]);
    expect(a.rowCount).toBe(1);
  });

  it('a JPG is served as image/jpeg; a member with no signature is 404; another firm cannot read it', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    expect((await fx.fin.agent.get(`/api/v1/organization/members/${m}/signature`)).status).toBe(404);
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), JPG, 'image/jpeg');
    const got = await fx.fin.agent.get(`/api/v1/organization/members/${m}/signature`).buffer(true).parse(binary);
    expect(got.headers['content-type']).toBe('image/jpeg');
    const { createFirm } = await import('./helpers.js');
    await createFirm('Firm B', [{ email: 'o@b.test', role: 'owner' }]);
    const other = await loginAs(app, 'o@b.test');
    expect((await other.agent.get(`/api/v1/organization/members/${m}/signature`)).status).toBe(404);
  });

  it('lawyer cannot upload for another member → 403; owner can', async () => {
    const fx = await setup();
    const m2 = fx.member('l2@a.test');
    const denied = await post(fx.l1, `/organization/members/${m2}/signature/uploads`, { contentType: 'image/png', sizeBytes: 300 });
    expect(denied.status).toBe(403);
    expect((await fx.l1.agent.delete(`/api/v1/organization/members/${m2}/signature`).set('X-CSRF-Token', fx.l1.csrf)).status).toBe(403);
    const ok = await upload(fx.owner, fx, m2, fx.uid('l2@a.test'), PNG);
    expect(ok.done!.status).toBe(200);
    expect(await sigKey(m2)).toMatch(new RegExp(`^signatures/${fx.firm.orgId}/${fx.uid('l2@a.test')}/`));
  });

  it('an upload started for one member cannot be completed for another', async () => {
    const fx = await setup();
    const a = fx.member('l1@a.test');
    const b = fx.member('l2@a.test');
    const start = await post(fx.owner, `/organization/members/${a}/signature/uploads`, { contentType: 'image/png', sizeBytes: 300 });
    storage.putDirect(stagingKey(fx.firm.orgId, fx.uid('l1@a.test'), start.body.data.uploadId), PNG);
    const crossed = await post(fx.owner, `/organization/members/${b}/signature/uploads/${start.body.data.uploadId}/complete`);
    expect(crossed.status).toBe(404);
    expect(await sigKey(b)).toBeNull();
    expect((await post(fx.owner, `/organization/members/${a}/signature/uploads/not-a-uuid/complete`)).status).toBe(422);
  });

  it('500 KB+1 → 422; GIF → 422', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    const u = fx.uid('l1@a.test');
    // declared too large / wrong type are refused at start
    expect((await post(fx.l1, `/organization/members/${m}/signature/uploads`, { contentType: 'image/png', sizeBytes: MAX + 1 })).status).toBe(422);
    expect((await post(fx.l1, `/organization/members/${m}/signature/uploads`, { contentType: 'image/gif', sizeBytes: 300 })).status).toBe(422);
    // a lying browser: the bytes decide at complete
    const big = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(MAX + 1 - 8, 1)]);
    expect(big.length).toBe(MAX + 1);
    const tooBig = await upload(fx.l1, fx, m, u, big);
    expect(tooBig.done!.status).toBe(422);
    expect(storage.removed).toContain(tooBig.key);
    const gif = await upload(fx.l1, fx, m, u, GIF);
    expect(gif.done!.status).toBe(422);
    expect(storage.removed).toContain(gif.key);
    expect(await sigKey(m)).toBeNull();
    // exactly 500 KB is fine
    const edge = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(MAX - 8, 1)]);
    expect((await upload(fx.l1, fx, m, u, edge)).done!.status).toBe(200);
  });

  it('removing a signature clears the pointer but never deletes the file', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG);
    const key = (await sigKey(m))!;
    const del = await fx.l1.agent.delete(`/api/v1/organization/members/${m}/signature`).set('X-CSRF-Token', fx.l1.csrf);
    expect(del.status).toBe(200);
    expect(del.body.data.hasSignature).toBe(false);
    expect(await sigKey(m)).toBeNull();
    expect(storage.data.has(key)).toBe(true);
    expect(storage.removed).not.toContain(key);
  });

  it('designation: self or users.manage; length-limited', async () => {
    const fx = await setup();
    const own = await patch(fx.l1, `/organization/members/${fx.member('l1@a.test')}`, { designation: 'Partner' });
    expect(own.status).toBe(200);
    expect(own.body.data.designation).toBe('Partner');
    expect((await patch(fx.l1, `/organization/members/${fx.member('l2@a.test')}`, { designation: 'Partner' })).status).toBe(403);
    expect((await patch(fx.owner, `/organization/members/${fx.member('l2@a.test')}`, { designation: 'Senior Partner' })).body.data.designation).toBe('Senior Partner');
    // a lawyer still cannot change their own role
    expect((await patch(fx.l1, `/organization/members/${fx.member('l1@a.test')}`, { role: 'owner' })).status).toBe(403);
    expect((await patch(fx.l1, `/organization/members/${fx.member('l1@a.test')}`, { designation: 'x'.repeat(121) })).status).toBe(422);
    expect((await patch(fx.l1, `/organization/members/${fx.member('l1@a.test')}`, { designation: '  ' })).status).toBe(422);
  });

  it('issue with signatory and image snapshots name/designation/key; later changes do not alter the invoice or its PDF image', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    await patch(fx.l1, `/organization/members/${m}`, { designation: 'Partner' });
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG);
    const original = (await sigKey(m))!;
    const id = await draft(fx);
    const issued = await post(fx.fin, `/invoices/${id}/issue`, { signatoryUserId: fx.uid('l1@a.test'), signWithImage: true });
    expect(issued.status).toBe(200);
    expect(issued.body.data.signatory).toMatchObject({ userId: fx.uid('l1@a.test'), designation: 'Partner', withImage: true });
    const r = await row(id);
    expect(r.signatory_name).toBe('l1');
    expect(r.signatory_signature_key).toBe(original);

    // designation changes, and the signature is replaced, then removed
    await patch(fx.l1, `/organization/members/${m}`, { designation: 'Retired' });
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG2);
    expect(await sigKey(m)).not.toBe(original);
    await fx.l1.agent.delete(`/api/v1/organization/members/${m}/signature`).set('X-CSRF-Token', fx.l1.csrf);

    const after = await row(id);
    expect(after.signatory_designation).toBe('Partner');
    expect(after.signatory_signature_key).toBe(original);
    const doc = await loadInvoiceDocData(deps, fx.ctx, id);
    expect(doc.invoice.signatory).toMatchObject({ designation: 'Partner', withImage: true });
    expect(doc.signature!.bytes.equals(PNG)).toBe(true);
  });

  it('GET /invoices/:id/signature serves the issue-time snapshot, 404 for hidden / no-image invoices', async () => {
    const fx = await setup();
    const m = fx.member('l1@a.test');
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG);
    const id = await draft(fx);
    await post(fx.fin, `/invoices/${id}/issue`, { signatoryUserId: fx.uid('l1@a.test'), signWithImage: true });
    const url = `/api/v1/invoices/${id}/signature`;
    const got = await fx.fin.agent.get(url).buffer(true).parse(binary);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toBe('private, no-store');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect((got.body as Buffer).equals(PNG)).toBe(true);
    // the member replaces their signature: the invoice still returns the original
    await upload(fx.l1, fx, m, fx.uid('l1@a.test'), PNG2);
    const again = await fx.fin.agent.get(url).buffer(true).parse(binary);
    expect((again.body as Buffer).equals(PNG)).toBe(true);
    // a lawyer not on the matter cannot see it
    expect((await fx.l2.agent.get(url)).status).toBe(404);
    // an invoice issued without the image has none to serve
    const id2 = await draft(fx);
    await post(fx.fin, `/invoices/${id2}/issue`, { signatoryUserId: fx.uid('l1@a.test'), signWithImage: false });
    expect((await fx.fin.agent.get(`/api/v1/invoices/${id2}/signature`)).status).toBe(404);
  });

  it('withImage when the signatory has no signature → 422 and the invoice stays a draft', async () => {
    const fx = await setup();
    const id = await draft(fx);
    const res = await post(fx.fin, `/invoices/${id}/issue`, { signatoryUserId: fx.uid('l1@a.test'), signWithImage: true });
    expect(res.status).toBe(422);
    expect((await row(id)).status).toBe('draft');
    // withImage with no resolvable signatory at all is refused too
    await pool.query(`DELETE FROM matter_staff WHERE matter_id = $1 AND role = 'lead'`, [fx.main.matterId]);
    expect((await post(fx.fin, `/invoices/${id}/issue`, { signWithImage: true })).status).toBe(422);
  });

  it('signatoryUserId must be an active member of the same firm → 422', async () => {
    const fx = await setup();
    const { createFirm } = await import('./helpers.js');
    const other = await createFirm('Firm B', [{ email: 'o@b.test', role: 'owner' }]);
    const id = await draft(fx);
    expect((await post(fx.fin, `/invoices/${id}/issue`, { signatoryUserId: other.users['o@b.test']!.userId })).status).toBe(422);
    await pool.query(`UPDATE organization_members SET status = 'suspended' WHERE id = $1`, [fx.member('l2@a.test')]);
    expect((await post(fx.fin, `/invoices/${id}/issue`, { signatoryUserId: fx.uid('l2@a.test') })).status).toBe(422);
    expect((await row(id)).status).toBe('draft');
  });

  it('default signatory: the issuer if they set a designation, else the matter lead, else none', async () => {
    const fx = await setup();
    // finance has only the placeholder designation → the matter lead (l1)
    const a = await draft(fx);
    await post(fx.fin, `/invoices/${a}/issue`);
    expect((await row(a)).signatory_user_id).toBe(fx.uid('l1@a.test'));
    // finance sets a designation → finance
    await patch(fx.fin, `/organization/members/${fx.member('finance@a.test')}`, { designation: 'Accounts Head' });
    const b = await draft(fx);
    await post(fx.fin, `/invoices/${b}/issue`);
    const rb = await row(b);
    expect(rb.signatory_user_id).toBe(fx.uid('finance@a.test'));
    expect(rb.signatory_designation).toBe('Accounts Head');
    expect(rb.sign_with_image).toBe(false);
    // no designation, no lead → no signatory, issue still works
    await pool.query(`UPDATE organization_members SET designation = 'Authorized Signatory' WHERE id = $1`, [fx.member('finance@a.test')]);
    await pool.query(`DELETE FROM matter_staff WHERE matter_id = $1 AND role = 'lead'`, [fx.main.matterId]);
    const c = await draft(fx);
    expect((await post(fx.fin, `/invoices/${c}/issue`)).status).toBe(200);
    const rc = await row(c);
    expect([rc.signatory_user_id, rc.signatory_name, rc.signatory_designation, rc.signatory_signature_key]).toEqual([null, null, null, null]);
  });
});
