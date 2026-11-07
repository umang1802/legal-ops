import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { invoiceDocumentModel, renderInvoicePdf, type InvoiceDocData } from '../src/modules/billing/pdf/invoice-pdf.js';
import { fontPath, modelText, renderDocument } from '../src/modules/billing/pdf/layout.js';
import { receiptDocumentModel, renderReceiptPdf } from '../src/modules/billing/pdf/receipt-pdf.js';
import { addDays, buildApp, deps, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const binary = (res: import('supertest').Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function setup() {
  const fx = await practiceFixture(app);
  const fin = await loginAs(app, 'finance@a.test');
  const ctx = { userId: fx.firm.users['owner@a.test']!.userId, organizationId: fx.firm.orgId, role: 'owner' as const, features: [] };
  return { ...fx, fin, ctx };
}

/** A solid grey PNG of the given size (a signature stand-in at its real display height). */
function solidPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const baseData = (): InvoiceDocData => ({
  org: {
    name: 'Firm A', legalName: 'Firm A LLP', address: '1 Court Road', city: 'Delhi', state: 'Delhi', pincode: '110001',
    email: 'a@firm.test', phone: '99999', gstin: null, pan: null, registrationLabel: 'Bar Council No.', registrationValue: 'D/123/2001',
    bankAccountName: 'Firm A LLP', bankAccountNumber: '1234567890', bankIfsc: 'HDFC0001234', bankName: 'HDFC Bank', bankBranch: 'CP', upiId: null,
  },
  client: { name: 'Raj Sharma', salutation: 'Mr', contactPerson: null, address: 'Long address '.repeat(20), city: 'Mumbai', state: 'MH' },
  invoice: {
    invoiceNumber: 'LGL/2026-27/000001', status: 'issued', voidReason: null, taxMode: 'simple', issueDate: '2026-11-06', dueDate: '2026-12-06',
    matter: { title: 'Sharma v ABC' }, recipientGstin: null, placeOfSupply: null, isReverseCharge: false, rcmTax: '0.00',
    subtotal: '50000.00', discountAmount: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', taxAmount: '0.00', total: '50000.00',
    amountPaid: '0.00', amountCredited: '0.00', amountDue: '50000.00', notes: null, revision: 0, revisedAt: null,
    items: [{ description: 'Professional fees', quantity: '1', unitPrice: '50000.00', amount: '50000.00', sacCode: null, isPureAgent: false }],
    instalments: [], signatory: null,
  },
  logo: null,
  signature: null,
});

describe('billing pdf: models', () => {
  it('invoice model has the number, Rs. 50,000.00 and the client name', () => {
    const text = modelText(invoiceDocumentModel(baseData()));
    expect(text).toContain('LGL/2026-27/000001');
    expect(text).toContain('Rs. 50,000.00');
    expect(text).toContain('Raj Sharma');
    expect(text).toContain('Mr Raj Sharma');
    expect(text).toContain('Bar Council No.: D/123/2001');
    expect(text).not.toContain('Powered by LexForgeX'); // off unless the firm turns it on
  });

  it('model includes instalment rows, bank IFSC, signatory and revision line', () => {
    const d = baseData();
    d.invoice.instalments = [
      { seq: 1, amount: '20000.00', dueDate: '2026-11-20', paid: '20000.00', status: 'paid' },
      { seq: 2, amount: '30000.00', dueDate: '2026-12-06', paid: '0.00', status: 'due' },
    ];
    d.invoice.revision = 2;
    d.invoice.revisedAt = '2026-11-10';
    d.invoice.signatory = { name: 'Asha Rao', designation: 'Partner', withImage: false };
    const text = modelText(invoiceDocumentModel(d));
    expect(text).toContain('Rs. 20,000.00');
    expect(text).toContain('Rs. 30,000.00');
    expect(text).toContain('20 Nov 2026');
    expect(text).toContain('Paid');
    expect(text).toContain('HDFC0001234');
    expect(text).toContain('Asha Rao');
    expect(text).toContain('Partner');
    expect(text).toContain('Revision 2 · 10 Nov 2026');
  });

  it('omits instalments, bank, revision when not set', () => {
    const d = baseData();
    d.org.bankIfsc = null; d.org.bankAccountNumber = null; d.org.bankAccountName = null; d.org.bankName = null; d.org.bankBranch = null;
    const text = modelText(invoiceDocumentModel(d));
    expect(text).not.toContain('IFSC');
    expect(text).not.toContain('Revision');
    expect(text).not.toContain('Instalment');
  });

  it('receipt model has the receipt number', () => {
    const text = modelText(
      receiptDocumentModel({
        org: baseData().org,
        logo: null,
        payment: {
          receiptNumber: 'RCT/2026-27/000007', status: 'posted', reversalReason: null, client: { name: 'Raj Sharma' }, amount: '20000.00',
          tdsAmount: '0.00', settlement: '20000.00', unallocated: '0.00', paymentDate: '2026-11-06', method: 'upi', referenceNumber: 'UTR1',
          allocations: [{ invoiceNumber: 'LGL/2026-27/000001', amount: '20000.00', active: true }],
        },
      }),
    );
    expect(text).toContain('RCT/2026-27/000007');
    expect(text).toContain('₹20,000.00');
    expect(text).toContain('LGL/2026-27/000001');
    expect(text).toContain('Powered by LexForgeX');
  });
});

describe('billing pdf: rendering', () => {
  it('a heavy invoice (3 items, 3 instalments, bank details, signature image, revision) stays within two pages', async () => {
    const d = baseData();
    d.invoice.items = [
      { description: 'Drafting and filing of writ petition including annexures and supporting affidavit, with detailed research on the point of limitation', quantity: '1', unitPrice: '50000.00', amount: '50000.00', sacCode: null, isPureAgent: false },
      { description: 'Appearance on 14 Oct 2026', quantity: '2', unitPrice: '12500.00', amount: '25000.00', sacCode: null, isPureAgent: false },
      { description: 'Court fee', quantity: '1', unitPrice: '5000.00', amount: '5000.00', sacCode: null, isPureAgent: true },
    ];
    d.invoice.total = d.invoice.subtotal = '80000.00';
    d.invoice.amountPaid = '20000.00';
    d.invoice.amountDue = '60000.00';
    d.invoice.notes = 'Fees for the writ petition.\nPlease quote the invoice number in all payments.';
    d.invoice.instalments = [
      { seq: 1, amount: '20000.00', dueDate: '2026-11-20', paid: '20000.00', status: 'paid' },
      { seq: 2, amount: '30000.00', dueDate: '2026-12-10', paid: '0.00', status: 'due' },
      { seq: 3, amount: '30000.00', dueDate: '2027-01-06', paid: '0.00', status: 'due' },
    ];
    d.invoice.revision = 2;
    d.invoice.revisedAt = '2026-11-10';
    d.invoice.signatory = { name: 'Asha Rao', designation: 'Partner', withImage: true };
    d.org.upiId = 'firm@hdfc';
    d.signature = { bytes: solidPng(160, 44), mime: 'image/png' };
    const pdf = await PDFDocument.load(await renderDocument(invoiceDocumentModel(d)));
    expect(pdf.getPageCount()).toBeLessThanOrEqual(2);
  });

  it('Noto Sans contains the ₹ glyph', () => {
    for (const w of ['Regular', 'Bold'] as const) {
      const font = fontkit.create(readFileSync(fontPath(`NotoSans-${w}.ttf`)));
      expect('hasGlyphForCodePoint' in font && font.hasGlyphForCodePoint(0x20b9)).toBe(true);
    }
  });

  it('wraps long text and flows ~60 items onto more than one page', async () => {
    const d = baseData();
    d.invoice.items = Array.from({ length: 60 }, (_, i) => ({
      description: `Item ${i + 1} ${'drafting and filing of long description '.repeat(4)}`,
      quantity: '1', unitPrice: '100.00', amount: '100.00', sacCode: null, isPureAgent: false,
    }));
    const model = invoiceDocumentModel(d);
    const buf = await renderDocument(model);
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const one = await PDFDocument.load(await renderDocument(invoiceDocumentModel(baseData())));
    expect(one.getPageCount()).toBe(1);
  });

  it('smoke: invoice PDF loads, has a page, embeds Noto Sans; ignores missing logo', async () => {
    const { ctx, main, fin, today } = await setup();
    await pool.query(`UPDATE organizations SET logo_id = gen_random_uuid(), logo_type = 'png', bank_ifsc = 'HDFC0001234' WHERE id = $1`, [ctx.organizationId]);
    const inv = (
      await post(fin, '/invoices', {
        matterId: main.matterId,
        issue: true,
        items: [{ description: 'Professional fees', unitPrice: '50000' }],
        instalments: [
          { amount: '20000', dueDate: addDays(today, 10) },
          { amount: '30000', dueDate: addDays(today, 20) },
        ],
      })
    ).body.data;
    const buf = await renderInvoicePdf(deps, ctx, inv.id);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(buf.toString('latin1')).toMatch(/NotoSans-Regular/);
  });

  it('smoke: receipt PDF loads and embeds Noto Sans', async () => {
    const { ctx, main, fin, today, firm } = await setup();
    const inv = (await post(fin, '/invoices', { matterId: main.matterId, issue: true, items: [{ description: 'Fees', unitPrice: '1000' }] })).body.data;
    const clientId = inv.client.id as string;
    const p = await post(fin, '/payments', { clientId, amount: '1000', paymentDate: today, method: 'upi', allocations: [{ invoiceId: inv.id, amount: '1000' }] });
    expect(p.status).toBe(201);
    const buf = await renderReceiptPdf(deps, ctx, p.body.data.id);
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(buf.toString('latin1')).toMatch(/NotoSans-Regular/);
    expect(firm.orgId).toBeTruthy();
  });
});

describe('billing pdf: routes', () => {
  it('GET /invoices/:id/pdf and /payments/:id/receipt.pdf return application/pdf', async () => {
    const { main, fin, today } = await setup();
    const inv = (await post(fin, '/invoices', { matterId: main.matterId, issue: true, items: [{ description: 'Fees', unitPrice: '1000' }] })).body.data;
    const res = await fin.agent.get(`/api/v1/invoices/${inv.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain('Invoice-LGL-');
    const p = await post(fin, '/payments', { clientId: inv.client.id, amount: '1000', paymentDate: today, method: 'upi', allocations: [{ invoiceId: inv.id, amount: '1000' }] });
    const r = await fin.agent.get(`/api/v1/payments/${p.body.data.id}/receipt.pdf`).buffer(true).parse(binary);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect((await PDFDocument.load(r.body as Buffer)).getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('a lawyer not on the matter gets 404', async () => {
    const { main, fin } = await setup();
    const inv = (await post(fin, '/invoices', { matterId: main.matterId, issue: true, items: [{ description: 'Fees', unitPrice: '1000' }] })).body.data;
    const l2 = await loginAs(app, 'l2@a.test');
    expect((await l2.agent.get(`/api/v1/invoices/${inv.id}/pdf`)).status).toBe(404);
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await l1.agent.get(`/api/v1/invoices/${inv.id}/pdf`)).status).toBe(200);
    void patch;
  });
});
