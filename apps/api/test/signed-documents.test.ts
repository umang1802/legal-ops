import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { invoicePdfForSending, loadInvoiceDocData } from '../src/modules/billing/pdf/invoice-pdf.js';
import { buildApp, deps, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const SIGNED = readFileSync(new URL('./fixtures/signed.pdf', import.meta.url));
const UNSIGNED = readFileSync(new URL('./fixtures/unsigned.pdf', import.meta.url));
const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const binary = (res: import('supertest').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function setup(issue = true) {
  const fx = await practiceFixture(app);
  const fin = await loginAs(app, 'finance@a.test');
  const inv = (await post(fin, '/invoices', { matterId: fx.main.matterId, issue, items: [{ description: 'Fees', unitPrice: '1000' }] })).body.data;
  return { ...fx, fin, inv };
}

/** Start → the browser's PUT → complete. */
async function upload(s: Session, orgId: string, invoiceId: string, bytes: Buffer) {
  const start = await post(s, `/invoices/${invoiceId}/signed-document/uploads`);
  if (start.status !== 201) return { start, done: null, key: null };
  const key = `incoming/signed/${orgId}/${invoiceId}/${start.body.data.uploadId}`;
  storage.putDirect(key, bytes);
  const done = await post(s, `/invoices/${invoiceId}/signed-document/uploads/${start.body.data.uploadId}/complete`);
  return { start, done, key };
}
const pdf = async (s: Session, invoiceId: string) => {
  const res = await s.agent.get(`/api/v1/invoices/${invoiceId}/pdf`).buffer(true).parse(binary);
  return { status: res.status, body: res.body as Buffer };
};
const count = async (invoiceId: string) =>
  Number((await pool.query(`SELECT count(*) FROM invoice_signed_documents WHERE invoice_id = $1`, [invoiceId])).rows[0].count);

describe('DSC-signed invoice PDF', () => {
  it('accepts a signed PDF; GET /pdf returns its bytes; DTO shows it; audited', async () => {
    const { fin, firm, inv } = await setup();
    const { start, done, key } = await upload(fin, firm.orgId, inv.id, SIGNED);
    expect(start.status).toBe(201);
    expect(start.body.data.url).toEqual(expect.any(String));
    expect(done!.status).toBe(200);
    expect(done!.body.data.signedDocument).toMatchObject({ sizeBytes: SIGNED.length });
    expect(storage.data.has(key!)).toBe(false);
    const got = await pdf(fin, inv.id);
    expect(got.status).toBe(200);
    expect(got.body.equals(SIGNED)).toBe(true);
    const a = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'invoice.signed_document_uploaded' AND entity_id = $1`, [inv.id]);
    expect(a.rowCount).toBe(1);
  });

  it('an unsigned PDF is refused with 422 and nothing is stored', async () => {
    const { fin, firm, inv } = await setup();
    const { done, key } = await upload(fin, firm.orgId, inv.id, UNSIGNED);
    expect(done!.status).toBe(422);
    expect(done!.body.error.message).toBe('This PDF has no digital signature. Sign it with the DSC (e.g. in Adobe Acrobat or emSigner) and upload the signed file.');
    expect(await count(inv.id)).toBe(0);
    expect([...storage.data.keys()].some((k) => k.startsWith(`signed/${firm.orgId}/`))).toBe(false);
    expect(storage.data.has(key!)).toBe(false);
  });

  it('non-PDF bytes are refused with 422', async () => {
    const { fin, firm, inv } = await setup();
    const { done } = await upload(fin, firm.orgId, inv.id, Buffer.from('hello world'));
    expect(done!.status).toBe(422);
    expect(await count(inv.id)).toBe(0);
  });

  it('a file over 10 MB is refused with 422', async () => {
    const { fin, firm, inv } = await setup();
    const { done } = await upload(fin, firm.orgId, inv.id, Buffer.concat([SIGNED, Buffer.alloc(10 * 1024 * 1024)]));
    expect(done!.status).toBe(422);
    expect(await count(inv.id)).toBe(0);
  });

  it('uploading again supersedes the first', async () => {
    const { fin, firm, inv } = await setup();
    await upload(fin, firm.orgId, inv.id, SIGNED);
    const second = Buffer.concat([SIGNED, Buffer.from('\n% second\n')]);
    await upload(fin, firm.orgId, inv.id, second);
    const rows = await pool.query(`SELECT superseded_at FROM invoice_signed_documents WHERE invoice_id = $1 ORDER BY uploaded_at`, [inv.id]);
    expect(rows.rows.map((r) => r.superseded_at !== null)).toEqual([true, false]);
    expect((await pdf(fin, inv.id)).body.equals(second)).toBe(true);
  });

  it('a draft invoice is refused with 409', async () => {
    const { fin, inv } = await setup(false);
    const start = await post(fin, `/invoices/${inv.id}/signed-document/uploads`);
    expect(start.status).toBe(409);
  });

  it('a void invoice is refused with 409', async () => {
    const { fin, inv, owner } = await setup();
    expect((await post(owner, `/invoices/${inv.id}/void`, { reason: 'Raised in error' })).status).toBe(200);
    expect((await post(fin, `/invoices/${inv.id}/signed-document/uploads`)).status).toBe(409);
  });

  it('needs invoices.manage', async () => {
    const { inv } = await setup();
    const viewer = await loginAs(app, 'viewer@a.test');
    expect((await post(viewer, `/invoices/${inv.id}/signed-document/uploads`)).status).toBe(403);
  });

  it('removing the signed copy returns GET /pdf to the generated PDF', async () => {
    const { fin, firm, inv } = await setup();
    await upload(fin, firm.orgId, inv.id, SIGNED);
    const del = await fin.agent.delete(`/api/v1/invoices/${inv.id}/signed-document`).set('X-CSRF-Token', fin.csrf);
    expect(del.status).toBe(200);
    expect(del.body.data.signedDocument).toBeNull();
    expect((await pdf(fin, inv.id)).body.equals(SIGNED)).toBe(false);
  });

  it('a signed copy goes stale when the invoice is revised: GET /pdf and the email attachment use the generated PDF', async () => {
    const { fin, firm, inv } = await setup();
    await upload(fin, firm.orgId, inv.id, SIGNED);
    expect((await pdf(fin, inv.id)).body.equals(SIGNED)).toBe(true);
    expect((await invoicePdfForSending(deps, firm.orgId, inv.id)).content.equals(SIGNED)).toBe(true);
    await pool.query(`UPDATE invoices SET revision = revision + 1, revised_at = now() WHERE id = $1`, [inv.id]);
    const got = await pdf(fin, inv.id);
    expect(got.body.equals(SIGNED)).toBe(false);
    expect(got.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await invoicePdfForSending(deps, firm.orgId, inv.id)).content.equals(SIGNED)).toBe(false);
    expect((await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data.signedDocument).toBeNull();
  });

  it('invoicePdfForSending works for an invoice whose matter has no members', async () => {
    const { firm, inv, main } = await setup();
    await pool.query(`DELETE FROM matter_staff WHERE matter_id = $1`, [main.matterId]);
    const out = await invoicePdfForSending(deps, firm.orgId, inv.id);
    expect(out.filename).toMatch(/^Invoice-.*\.pdf$/);
    expect(out.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('the letterhead GSTIN is the one stored on the invoice, not the firm\'s current one', async () => {
    const { firm, inv } = await setup();
    await pool.query(`UPDATE organizations SET gstin = '29BBBBB0000B1Z5' WHERE id = $1`, [firm.orgId]);
    await pool.query(`UPDATE invoices SET supplier_gstin = '27AAAAA0000A1Z5' WHERE id = $1`, [inv.id]);
    const ctx = { userId: firm.users['owner@a.test']!.userId, organizationId: firm.orgId, role: 'owner' as const, features: [] };
    expect((await loadInvoiceDocData(deps, ctx, inv.id)).org.gstin).toBe('27AAAAA0000A1Z5');
  });

  it('a voided invoice no longer serves its signed copy', async () => {
    const { fin, firm, inv, owner } = await setup();
    await upload(fin, firm.orgId, inv.id, SIGNED);
    expect((await post(owner, `/invoices/${inv.id}/void`, { reason: 'Raised in error' })).status).toBe(200);
    expect((await pdf(fin, inv.id)).body.equals(SIGNED)).toBe(false);
    expect((await invoicePdfForSending(deps, firm.orgId, inv.id)).content.equals(SIGNED)).toBe(false);
    expect((await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data.signedDocument).toBeNull();
  });

  it('an upload started for invoice A cannot be completed against invoice B', async () => {
    const { fin, firm, inv, main } = await setup();
    const b = (await post(fin, '/invoices', { matterId: main.matterId, issue: true, items: [{ description: 'More', unitPrice: '500' }] })).body.data;
    const start = await post(fin, `/invoices/${inv.id}/signed-document/uploads`);
    storage.putDirect(`incoming/signed/${firm.orgId}/${inv.id}/${start.body.data.uploadId}`, SIGNED);
    const done = await post(fin, `/invoices/${b.id}/signed-document/uploads/${start.body.data.uploadId}/complete`);
    expect(done.status).toBe(404);
    expect(await count(b.id)).toBe(0);
    expect(await count(inv.id)).toBe(0);
  });
});
