import { fiscalYear } from '@legalops/validation';
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/modules/notifications/context.js';
import { renderTemplate } from '../src/modules/templates/render.js';
import { buildApp, deps, loginAs, pool, practiceFixture, type Session, useDatabase } from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

describe('billing parity: firm settings, client fields, number width', () => {
  it('PATCH /organization stores bank details and returns them', async () => {
    const { owner } = await practiceFixture(app);
    const res = await patch(owner, '/organization', {
      registrationLabel: 'LLPIN',
      registrationValue: 'ADB-8169',
      bankAccountName: 'Firm A LLP',
      bankAccountNumber: '123456789012',
      bankIfsc: 'hdfc0001234',
      bankName: 'HDFC Bank',
      bankBranch: 'Connaught Place',
      upiId: 'firma@hdfc',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      registrationLabel: 'LLPIN',
      registrationValue: 'ADB-8169',
      bankAccountNumber: '123456789012',
      bankIfsc: 'HDFC0001234',
      upiId: 'firma@hdfc',
      invoiceNumberDigits: 6,
    });
    const again = (await owner.agent.get('/api/v1/organization')).body.data;
    expect(again.bankIfsc).toBe('HDFC0001234');
  });

  it("invoice numbers use the firm's digit width", async () => {
    const { owner, main, today } = await practiceFixture(app);
    const fin = await loginAs(app, 'finance@a.test');
    expect((await patch(owner, '/organization', { invoiceNumberDigits: 3 })).status).toBe(200);
    const nums: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await post(fin, '/invoices', {
        matterId: main.matterId,
        items: [{ description: 'Fees', unitPrice: '1000' }],
        issue: true,
      });
      expect(res.status).toBe(201);
      nums.push(res.body.data.invoiceNumber);
    }
    const fy = fiscalYear(today);
    expect(nums).toEqual([`LGL/${fy}/001`, `LGL/${fy}/002`]);
  });

  it('client salutation/contact/cc round-trip', async () => {
    const { owner } = await practiceFixture(app);
    const res = await post(owner, '/clients', {
      name: 'Acme Pvt Ltd',
      clientType: 'company',
      salutation: 'M/s',
      title: 'Director',
      contactPerson: 'Priya Nair',
      ccEmails: ['a@acme.test', 'b@acme.test'],
    });
    expect(res.status).toBe(201);
    const got = (await owner.agent.get(`/api/v1/clients/${res.body.data.id}`)).body.data;
    expect(got).toMatchObject({ salutation: 'M/s', title: 'Director', contactPerson: 'Priya Nair', ccEmails: ['a@acme.test', 'b@acme.test'] });
    const upd = await patch(owner, `/clients/${res.body.data.id}`, { ccEmails: ['c@acme.test'] });
    expect(upd.body.data.ccEmails).toEqual(['c@acme.test']);
  });

  it('client.greeting renders "Dear Mr Raj Sharma"', async () => {
    const { firm, owner } = await practiceFixture(app);
    const clientId = (await pool.query(`SELECT id FROM clients WHERE organization_id = $1`, [firm.orgId])).rows[0].id as string;
    await pool.query(`UPDATE clients SET salutation = 'Mr' WHERE id = $1`, [clientId]);
    const ctx = await buildContext(pool, firm.orgId, { clientId }, new Date(), 'https://app.test');
    expect(ctx.vars.client!.greeting).toBe('Dear Mr Raj Sharma');
    await pool.query(`UPDATE clients SET salutation = NULL, contact_person = 'Meera' WHERE id = $1`, [clientId]);
    expect((await buildContext(pool, firm.orgId, { clientId }, new Date(), 'https://app.test')).vars.client!.greeting).toBe('Dear Meera');
    void owner; void deps;
  });

  it('firm.registration_line and escaped firm.bank_details_html', async () => {
    const { firm, owner } = await practiceFixture(app);
    const empty = await buildContext(pool, firm.orgId, {}, new Date(), 'https://app.test');
    expect(empty.vars.firm).toMatchObject({ bank_details_html: '', registration_line: '' });
    await patch(owner, '/organization', {
      registrationLabel: 'LLPIN',
      registrationValue: 'ADB-8169',
      bankAccountName: 'A <b>&</b> Co',
      bankAccountNumber: '123456789012',
      bankIfsc: 'HDFC0001234',
    });
    const ctx = await buildContext(pool, firm.orgId, {}, new Date(), 'https://app.test');
    expect(ctx.vars.firm!.registration_line).toBe('LLPIN: ADB-8169');
    const html = ctx.vars.firm!.bank_details_html as string;
    expect(html).toContain('A &lt;b&gt;&amp;&lt;/b&gt; Co');
    expect(html).not.toContain('<b>');
    // Rendered raw in HTML mode (not double-escaped), plain text in text mode.
    const out = renderTemplate('{{firm.bank_details_html}}', ctx.vars, 'html');
    expect(out).toBe(html);
    const txt = renderTemplate('{{firm.bank_details_html}}', ctx.vars, 'text');
    expect(txt).not.toContain('<strong>');
    expect(txt).toContain('A <b>&</b> Co');
  });

  it('digit width applies to invoices only: receipts keep 6 digits', async () => {
    const { owner, main, firm, today } = await practiceFixture(app);
    const fin = await loginAs(app, 'finance@a.test');
    await patch(owner, '/organization', { invoiceNumberDigits: 3 });
    const inv = await post(fin, '/invoices', { matterId: main.matterId, items: [{ description: 'Fees', unitPrice: '1000' }], issue: true });
    const clientId = (await pool.query(`SELECT id FROM clients WHERE organization_id = $1`, [firm.orgId])).rows[0].id as string;
    const pay = await post(fin, '/payments', {
      clientId,
      amount: '1000',
      paymentDate: today,
      method: 'upi',
      allocations: [{ invoiceId: inv.body.data.id, amount: '1000' }],
    });
    expect(pay.status).toBe(201);
    expect(pay.body.data.receiptNumber).toBe(`RCPT/${fiscalYear(today)}/000001`);
  });
});
