import { DEFAULT_INVOICE_FORMAT, resolveInvoiceFormat } from '@legalops/validation';
import { describe, expect, it } from 'vitest';
import { invoiceDocumentModel, sampleInvoiceDocData } from '../src/modules/billing/pdf/invoice-pdf.js';
import { modelText } from '../src/modules/billing/pdf/layout.js';
import { buildApp, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

const org = {
  name: 'Firm A',
  legalName: 'Firm A LLP',
  address: '1 Court Road',
  city: 'Delhi',
  state: 'Delhi',
  pincode: '110001',
  email: 'a@firm.test',
  phone: '99999',
  gstin: null,
  pan: 'ABCDE1234F',
  registrationLabel: 'LLPIN',
  registrationValue: 'ADB-8169',
  bankAccountName: 'Firm A LLP',
  bankAccountNumber: '1234567890',
  bankIfsc: 'HDFC0001234',
  bankName: 'HDFC Bank',
  bankBranch: null,
  upiId: null,
};
const sample = (format: Parameters<typeof resolveInvoiceFormat>[0] = {}) => {
  const f = resolveInvoiceFormat(format);
  return { f, data: sampleInvoiceDocData({ org, logo: null }, f, '2026-11-07') };
};
const kinds = (m: ReturnType<typeof invoiceDocumentModel>) => m.blocks.map((b) => b.kind);

describe('invoice format: the standard format', () => {
  it('is the default for a firm that never configured anything', () => {
    expect(resolveInvoiceFormat(null)).toEqual(DEFAULT_INVOICE_FORMAT);
    expect(resolveInvoiceFormat({ accentColor: 'not-a-colour' })).toEqual(DEFAULT_INVOICE_FORMAT); // damaged values never break printing
    expect(DEFAULT_INVOICE_FORMAT).toMatchObject({
      accentColor: '#2F4E7B',
      ruleColor: '#C9AE74',
      currencyStyle: 'rs',
      letterhead: { align: 'center', rule: true },
      title: { text: 'INVOICE', align: 'left' },
      watermark: { mode: 'logo', opacity: 0.045 },
    });
    expect(DEFAULT_INVOICE_FORMAT.sections.map((s) => s.id)).toEqual([
      'parties',
      'subject',
      'items',
      'schedule',
      'payment',
      'notes',
      'signature',
    ]);
  });

  it('lays an invoice out as: letterhead, title, billed-to, subject, items, total, how to pay, notes, signature', () => {
    const { data } = sample();
    const m = invoiceDocumentModel(data);
    expect(kinds(m)).toEqual([
      'letterhead',
      'title',
      'parties',
      'subject',
      'table',
      'totals',
      'labeled',
      'labeled',
      'signature',
    ]);
    const text = modelText(m);
    for (const s of [
      'FIRM A LLP',
      'LLPIN: ADB-8169',
      'Registered Office: 1 Court Road, Delhi, Delhi – 110001',
      'INVOICE',
      'BILLED TO',
      'INVOICE DETAILS',
      'Invoice No.',
      'Amount Due',
      'PAN',
      'HOW TO PAY',
      'NOTES',
      'Rs. 15,000.00',
      'For and on behalf of Firm A LLP',
    ])
      expect(text).toContain(s);
    expect(m.theme).toEqual({ accent: '#2F4E7B', rule: '#C9AE74' });
  });
});

describe('invoice format: sections', () => {
  it('follows the order the firm chose and leaves out hidden sections', () => {
    const { data, f } = sample({
      sections: [
        { id: 'signature', show: true },
        { id: 'parties', show: true },
        { id: 'items', show: true },
        { id: 'notes', show: false },
        { id: 'payment', show: false },
      ],
    });
    expect(f.sections.map((s) => s.id)).toEqual([
      'signature',
      'parties',
      'items',
      'notes',
      'payment',
      'subject',
      'schedule',
    ]); // anything missing is appended
    const m = invoiceDocumentModel(data, f);
    expect(kinds(m)).toEqual(['letterhead', 'title', 'signature', 'parties', 'table', 'totals', 'subject']);
    expect(modelText(m)).not.toContain('HOW TO PAY');
    expect(modelText(m)).not.toContain('NOTES');
  });

  it('never lets the customer block or the items be hidden, and ignores duplicates', () => {
    const f = resolveInvoiceFormat({
      sections: [
        { id: 'parties', show: false },
        { id: 'items', show: false },
        { id: 'items', show: true },
      ],
    });
    expect(f.sections.filter((s) => s.id === 'items')).toHaveLength(1);
    expect(f.sections.find((s) => s.id === 'parties')?.show).toBe(true);
    expect(f.sections.find((s) => s.id === 'items')?.show).toBe(true);
  });

  it('shows only the invoice-detail rows the firm switched on, with its own labels', () => {
    const { data, f } = sample({
      parties: {
        details: [
          { id: 'number', label: 'Bill No.', show: true },
          { id: 'dueDate', label: 'Pay by', show: true },
          { id: 'pan', label: 'PAN', show: false },
        ],
      },
    });
    const text = modelText(invoiceDocumentModel(data, f));
    expect(text).toContain('Bill No.');
    expect(text).toContain('Pay by');
    expect(text).not.toContain('PAN');
    expect(text).toContain('Invoice Date'); // a row the firm didn't mention keeps its standard setting
  });
});

describe('invoice format: look and wording', () => {
  it('prints ₹ instead of Rs. when asked', () => {
    const { data, f } = sample({ currencyStyle: 'symbol' });
    const text = modelText(invoiceDocumentModel(data, f));
    expect(text).toContain('₹15,000.00');
    expect(text).not.toContain('Rs.');
  });

  it('shows quantity and rate when asked, and always when a quantity is not 1', () => {
    const plain = sample();
    expect(modelText(invoiceDocumentModel(plain.data, plain.f))).not.toContain('QTY');
    const asked = sample({ items: { showQuantityRate: true } });
    expect(modelText(invoiceDocumentModel(asked.data, asked.f))).toContain('QTY');
    const multi = sample();
    multi.data.invoice.items = [
      {
        description: 'Appearance',
        quantity: '3',
        unitPrice: '5000.00',
        amount: '15000.00',
        sacCode: null,
        isPureAgent: false,
      },
    ];
    expect(modelText(invoiceDocumentModel(multi.data, multi.f))).toContain('QTY'); // an amount must never be unexplained
  });

  it('uses the tax-invoice title and SAC column for GST invoices', () => {
    const g = sample();
    g.data.invoice.taxMode = 'gst';
    g.data.invoice.placeOfSupply = '07';
    const text = modelText(invoiceDocumentModel(g.data, g.f));
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('SAC');
    expect(text).toContain('Place of Supply');
  });

  it('puts a custom total label, signature wording and footer text where the firm set them', () => {
    const { data, f } = sample({
      totals: { totalLabel: 'Grand Total' },
      signature: { onBehalfText: 'Yours faithfully, {firm}', align: 'left' },
      footer: { thankYou: 'Thanks!', website: 'www.firm.test', tagline: 'Law, done right', poweredBy: true },
    });
    const m = invoiceDocumentModel(data, f);
    const text = modelText(m);
    expect(text).toContain('Grand Total');
    expect(text).toContain('Yours faithfully, Firm A LLP');
    expect(m.blocks.find((b) => b.kind === 'signature')).toMatchObject({ align: 'left' });
    expect(m.footer).toMatchObject({ thankYou: 'Thanks!', tagline: 'Law, done right', poweredBy: true });
    expect(m.footer?.contact).toBe('99999   |   a@firm.test   |   www.firm.test');
  });

  it('keeps one space between the address prefix and the address, however the prefix was typed', () => {
    for (const prefix of ['Registered Office:', 'Registered Office: ', '  Registered Office:  ']) {
      const { data, f } = sample({ letterhead: { addressPrefix: prefix } });
      expect(modelText(invoiceDocumentModel(data, f))).toContain('Registered Office: 1 Court Road');
    }
    const bare = sample({ letterhead: { addressPrefix: '' } });
    expect(modelText(invoiceDocumentModel(bare.data, bare.f))).toContain(
      '\n1 Court Road, Delhi, Delhi – 110001',
    );
  });

  it('can switch the footer off', () => {
    const { data, f } = sample({ footer: { show: false } });
    expect(invoiceDocumentModel(data, f).footer).toBeUndefined();
  });
});

describe('invoice format: watermark', () => {
  const logo = { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' as const };
  it('draws the logo by default, with the firm’s opacity, size, angle and position', () => {
    const { data, f } = sample({
      watermark: { opacity: 0.1, scale: 0.4, rotation: -30, position: 'bottom' },
    });
    data.logo = logo;
    expect(invoiceDocumentModel(data, f).watermark).toMatchObject({
      kind: 'image',
      opacity: 0.1,
      scale: 0.4,
      rotation: -30,
      position: 'bottom',
    });
  });
  it('draws text instead when asked, and nothing when off or when there is no logo', () => {
    const text = sample({ watermark: { mode: 'text', text: 'PAID' } });
    expect(invoiceDocumentModel(text.data, text.f).watermark).toMatchObject({ kind: 'text', text: 'PAID' });
    const off = sample({ watermark: { mode: 'none' } });
    off.data.logo = logo;
    expect(invoiceDocumentModel(off.data, off.f).watermark).toBeUndefined();
    const noLogo = sample();
    expect(invoiceDocumentModel(noLogo.data, noLogo.f).watermark).toBeUndefined();
  });
  it('rejects values outside the safe range', () => {
    expect(resolveInvoiceFormat({ watermark: { opacity: 0.9 } })).toEqual(DEFAULT_INVOICE_FORMAT);
  });
});

describe('invoice format: settings API', () => {
  it('starts on the standard format, saves changes, and resets', async () => {
    const { owner } = await practiceFixture(app);
    const first = await owner.agent.get('/api/v1/organization/invoice-format');
    expect(first.body.data).toMatchObject({ isDefault: true });
    expect(first.body.data.format).toEqual(DEFAULT_INVOICE_FORMAT);

    const saved = await patch(owner, '/organization/invoice-format', {
      accentColor: '#112233',
      currencyStyle: 'symbol',
      watermark: { mode: 'text', text: 'DRAFT' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.isDefault).toBe(false);
    expect(saved.body.data.format).toMatchObject({
      accentColor: '#112233',
      currencyStyle: 'symbol',
      watermark: { mode: 'text', text: 'DRAFT' },
      title: { text: 'INVOICE' },
    });
    expect((await owner.agent.get('/api/v1/organization/invoice-format')).body.data.format.accentColor).toBe(
      '#112233',
    );

    const reset = await post(owner, '/organization/invoice-format/reset');
    expect(reset.body.data.isDefault).toBe(true);
    expect(reset.body.data.format).toEqual(DEFAULT_INVOICE_FORMAT);
    const audit = (
      await pool.query(
        `SELECT action FROM audit_logs WHERE action LIKE 'organization.invoice_format%' ORDER BY created_at`,
      )
    ).rows.map((r) => r.action);
    expect(audit).toEqual(['organization.invoice_format_updated', 'organization.invoice_format_reset']);
  });

  it('rejects a bad colour or an out-of-range watermark', async () => {
    const { owner } = await practiceFixture(app);
    expect((await patch(owner, '/organization/invoice-format', { accentColor: 'blue' })).status).toBe(422);
    expect((await patch(owner, '/organization/invoice-format', { watermark: { opacity: 5 } })).status).toBe(
      422,
    );
    expect(
      (await patch(owner, '/organization/invoice-format', { watermark: { rotation: 200 } })).status,
    ).toBe(422);
  });

  it('only people who can manage the firm may change it', async () => {
    await practiceFixture(app);
    const staff = await loginAs(app, 'clerk@a.test');
    expect((await patch(staff, '/organization/invoice-format', { accentColor: '#112233' })).status).toBe(403);
    expect((await staff.agent.get('/api/v1/organization/invoice-format')).status).toBe(403);
    expect((await post(staff, '/organization/invoice-format/preview', {})).status).toBe(403);
  });

  it('previews a sample invoice in an unsaved draft, with the firm’s own letterhead', async () => {
    const { owner } = await practiceFixture(app);
    const res = await post(owner, '/organization/invoice-format/preview', {
      currencyStyle: 'symbol',
      title: { text: 'BILL' },
      sections: [{ id: 'signature', show: true }],
    });
    expect(res.status).toBe(200);
    const m = res.body.data;
    expect(m.blocks[0].kind).toBe('letterhead');
    expect(m.blocks[1]).toMatchObject({ kind: 'title', text: 'BILL' });
    expect(m.blocks[2].kind).toBe('signature');
    expect(JSON.stringify(m)).toContain('₹15,000.00');
    expect((await owner.agent.get('/api/v1/organization/invoice-format')).body.data.isDefault).toBe(true); // nothing was saved
  });
});

describe('invoice format: real invoices', () => {
  it('GET /invoices/:id/document draws the invoice in the firm’s saved format', async () => {
    const fx = await practiceFixture(app);
    const fin = await loginAs(app, 'finance@a.test');
    const made = await post(fin, '/invoices', {
      matterId: fx.main.matterId,
      items: [{ description: 'Professional fees', unitPrice: '5000' }],
      issue: true,
    });
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;

    const before = await fin.agent.get(`/api/v1/invoices/${id}/document`);
    expect(before.status).toBe(200);
    expect(JSON.stringify(before.body.data)).toContain('Rs. 5,000.00');
    expect(before.body.data.theme.accent).toBe('#2F4E7B');

    await patch(fx.owner, '/organization/invoice-format', {
      currencyStyle: 'symbol',
      accentColor: '#AA0000',
    });
    const after = await fin.agent.get(`/api/v1/invoices/${id}/document`);
    expect(JSON.stringify(after.body.data)).toContain('₹5,000.00');
    expect(after.body.data.theme.accent).toBe('#AA0000');

    const pdf = await fin.agent
      .get(`/api/v1/invoices/${id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});
