import { fiscalYear } from '@legalops/validation';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildApp,
  createFirm,
  loginAs,
  pool,
  practiceFixture,
  type Session,
  useDatabase,
} from './helpers.js';

useDatabase();
const app = buildApp();

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

async function setup() {
  const fx = await practiceFixture(app);
  const fin = await loginAs(app, 'finance@a.test');
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId]))
    .rows[0].client_id as string;
  const invoice = async (amount: string, opts: Record<string, unknown> = {}) => {
    const res = await post(fin, '/invoices', {
      matterId: fx.main.matterId,
      items: [{ description: 'Professional fees', unitPrice: amount }],
      issue: true,
      ...opts,
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data;
  };
  return { ...fx, fin, clientId, invoice };
}

/** AR movement per invoice in the ledger must equal its derived amount due. */
async function ledgerMatchesBalances() {
  const { rows } = await pool.query(`
    SELECT b.invoice_id, b.amount_due::numeric AS due,
           COALESCE(sum(CASE WHEN l.debit_account = 'accounts_receivable' THEN l.amount ELSE 0 END), 0)
         - COALESCE(sum(CASE WHEN l.credit_account = 'accounts_receivable' THEN l.amount ELSE 0 END), 0) AS ar
    FROM v_invoice_balances b JOIN invoices i ON i.id = b.invoice_id
    LEFT JOIN ledger_entries l ON l.invoice_id = b.invoice_id
    WHERE i.status = 'issued' GROUP BY b.invoice_id, b.amount_due`);
  for (const r of rows) expect(Number(r.ar)).toBe(Number(r.due));
  return rows.length;
}

describe('billing: pilot tests 4–6', () => {
  it('Test 4 + 5: ₹50,000 invoice → issue → partial ₹20,000 → balance ₹30,000 → rest → paid', async () => {
    const { fin, clientId, main, today } = await setup();
    const draft = await post(fin, '/invoices', {
      matterId: main.matterId,
      dueDate: addDays(today, 12),
      items: [{ description: 'Professional fees: Sharma v ABC', unitPrice: '50000' }],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', invoiceNumber: null, total: '50000.00' });

    const issued = await post(fin, `/invoices/${draft.body.data.id}/issue`);
    const fy = fiscalYear(today);
    expect(issued.body.data).toMatchObject({
      status: 'issued',
      invoiceNumber: `LGL/${fy}/000001`,
      total: '50000.00',
      amountDue: '50000.00',
      displayStatus: 'unpaid',
    });
    const created = await pool.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'INVOICE_CREATED'`,
    );
    expect(created.rows[0].payload).toMatchObject({ total: '50000.00', invoiceNumber: `LGL/${fy}/000001` });

    const p1 = await post(fin, '/payments', {
      clientId,
      amount: '20000',
      paymentDate: today,
      method: 'upi',
      referenceNumber: 'UTR123',
      allocations: [{ invoiceId: draft.body.data.id, amount: '20000' }],
    });
    expect(p1.status).toBe(201);
    expect(p1.body.data).toMatchObject({ receiptNumber: `RCPT/${fy}/000001`, unallocated: '0.00' });
    const partial = (await fin.agent.get(`/api/v1/invoices/${draft.body.data.id}`)).body.data;
    expect(partial).toMatchObject({
      amountPaid: '20000.00',
      amountDue: '30000.00',
      displayStatus: 'partial',
      paymentState: 'partial',
    });

    await post(fin, '/payments', {
      clientId,
      amount: '30000',
      paymentDate: today,
      method: 'bank_transfer',
      allocations: [{ invoiceId: draft.body.data.id, amount: '30000' }],
    });
    const paid = (await fin.agent.get(`/api/v1/invoices/${draft.body.data.id}`)).body.data;
    expect(paid).toMatchObject({ amountDue: '0.00', displayStatus: 'paid' });
    expect(
      (await pool.query(`SELECT count(*)::int n FROM outbox_events WHERE event_type = 'INVOICE_PAID'`))
        .rows[0].n,
    ).toBe(1);
    expect(await ledgerMatchesBalances()).toBe(1);
  });

  it('Test 6: a past-due invoice is overdue, aged, and counted on the dashboards', async () => {
    const { invoice, today, owner } = await setup();
    const inv = await invoice('12000', { issueDate: addDays(today, -40), dueDate: addDays(today, -10) });
    expect(inv).toMatchObject({ displayStatus: 'overdue', daysOverdue: 10 });
    const summary = (await owner.agent.get('/api/v1/billing/summary')).body.data;
    expect(summary.overdue).toBe('12000.00');
    expect(summary.aging['8-30']).toEqual({ count: 1, amount: '12000.00' });
    const aging = (await owner.agent.get('/api/v1/billing/aging').query({ bucket: '8-30' })).body.data;
    expect(aging.map((i: { id: string }) => i.id)).toEqual([inv.id]);
    const dash = (await owner.agent.get('/api/v1/dashboard')).body.data;
    expect(dash.counts).toMatchObject({ outstanding: '12000.00', overdueAmount: '12000.00' });
    const l1 = await loginAs(app, 'l1@a.test');
    expect((await l1.agent.get('/api/v1/dashboard')).body.data.counts.outstanding).toBeNull();
  });
});

describe('billing: invoice integrity', () => {
  it('numbers are gapless and unique under concurrent issue', async () => {
    const { fin, main, today } = await setup();
    const drafts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post(fin, '/invoices', {
          matterId: main.matterId,
          items: [{ description: `Fee ${i}`, unitPrice: '1000' }],
        }),
      ),
    );
    const issued = await Promise.all(drafts.map((d) => post(fin, `/invoices/${d.body.data.id}/issue`)));
    const numbers = issued.map((r) => r.body.data.invoiceNumber).sort();
    const fy = fiscalYear(today);
    expect(numbers).toEqual([1, 2, 3, 4, 5].map((n) => `LGL/${fy}/${String(n).padStart(6, '0')}`));
  });

  it('issued invoices are immutable; drafts can be edited and deleted', async () => {
    const { fin, main, invoice } = await setup();
    const inv = await invoice('5000');
    expect(
      (await patch(fin, `/invoices/${inv.id}`, { items: [{ description: 'x', unitPrice: '1' }] })).status,
    ).toBe(409);
    expect((await fin.agent.delete(`/api/v1/invoices/${inv.id}`).set('X-CSRF-Token', fin.csrf)).status).toBe(
      409,
    );
    await expect(
      pool.query(`UPDATE invoices SET total_amount = 1, subtotal = 1 WHERE id = $1`, [inv.id]),
    ).rejects.toThrow(/immutable/);

    const d = await post(fin, '/invoices', {
      matterId: main.matterId,
      items: [{ description: 'a', unitPrice: '100' }],
    });
    const edited = await patch(fin, `/invoices/${d.body.data.id}`, {
      items: [{ description: 'a', quantity: '2.5', unitPrice: '3333.33' }],
      discountAmount: '0.33',
      taxAmount: '100',
    });
    expect(edited.body.data).toMatchObject({ subtotal: '8333.33', total: '8433.00' });
    expect(
      (await fin.agent.delete(`/api/v1/invoices/${d.body.data.id}`).set('X-CSRF-Token', fin.csrf)).status,
    ).toBe(204);
  });

  it('client-sent totals are ignored; the server computes them', async () => {
    const { fin, main } = await setup();
    const res = await post(fin, '/invoices', {
      matterId: main.matterId,
      items: [{ description: 'a', unitPrice: '100' }],
      total: '1',
    });
    expect(res.status).toBe(422); // unknown field rejected outright
  });
});

describe('billing: GST mode', () => {
  async function gstSetup() {
    const s = await setup();
    await patch(s.owner, '/organization', { taxMode: 'gst', gstin: '07AAACS1234A1Z5', stateCode: '07' });
    return s;
  }

  it('inter-state client → IGST; issue snapshots both GSTINs', async () => {
    const s = await gstSetup();
    await pool.query(`UPDATE clients SET state_code = '27', client_type = 'person' WHERE id = $1`, [
      s.clientId,
    ]);
    const inv = await s.invoice('50000');
    expect(inv).toMatchObject({
      taxMode: 'gst',
      placeOfSupply: '27',
      igst: '9000.00',
      cgst: '0.00',
      total: '59000.00',
      supplierGstin: '07AAACS1234A1Z5',
    });
    expect(inv.items[0]).toMatchObject({ sacCode: '998212', gstRate: '18.00' });
  });

  it('business client with GSTIN defaults to reverse charge: GST disclosed, not charged', async () => {
    const s = await gstSetup();
    await pool.query(
      `UPDATE clients SET state_code = '07', client_type = 'company', gstin = '07AAACA9999A1Z1' WHERE id = $1`,
      [s.clientId],
    );
    const inv = await s.invoice('50000');
    expect(inv).toMatchObject({
      isReverseCharge: true,
      taxAmount: '0.00',
      rcmTax: '9000.00',
      total: '50000.00',
      recipientGstin: '07AAACA9999A1Z1',
    });
    // Explicit override is respected.
    const fc = await s.invoice('50000', { isReverseCharge: false });
    expect(fc).toMatchObject({ cgst: '4500.00', sgst: '4500.00', total: '59000.00' });
  });

  it('GST mode cannot even be enabled without a firm GSTIN (DB constraint), so GST invoices always carry one', async () => {
    const s = await setup();
    await expect(
      pool.query(`UPDATE organizations SET tax_mode = 'gst', gstin = NULL WHERE id = $1`, [s.firm.orgId]),
    ).rejects.toThrow(/check constraint/);
  });

  it('a failed issue does not burn an invoice number', async () => {
    const s = await setup();
    const d = await post(s.fin, '/invoices', {
      matterId: s.main.matterId,
      items: [{ description: 'a', unitPrice: '100' }],
    });
    const bad = await post(s.fin, `/invoices/${d.body.data.id}/issue`, {
      issueDate: s.today,
      dueDate: addDays(s.today, -1),
    });
    expect(bad.status).toBe(422);
    const ok = await post(s.fin, `/invoices/${d.body.data.id}/issue`, { issueDate: s.today });
    expect(ok.body.data.invoiceNumber).toMatch(/\/000001$/);
  });
});

describe('billing: payments', () => {
  it('one payment with TDS settles two invoices; over-allocation and silent remainders are refused', async () => {
    const { fin, clientId, invoice, today } = await setup();
    const a = await invoice('30000');
    const b = await invoice('20000');
    const tooMuch = await post(fin, '/payments', {
      clientId,
      amount: '45000',
      tdsAmount: '5000',
      paymentDate: today,
      method: 'cheque',
      allocations: [{ invoiceId: a.id, amount: '30000.01' }],
    });
    expect(tooMuch.status).toBe(422);
    const remainder = await post(fin, '/payments', {
      clientId,
      amount: '45000',
      tdsAmount: '5000',
      paymentDate: today,
      method: 'cheque',
      allocations: [{ invoiceId: a.id, amount: '30000' }],
    });
    expect(remainder.status).toBe(422);
    expect(remainder.body.error.message).toMatch(/advance/);

    const ok = await post(fin, '/payments', {
      clientId,
      amount: '45000',
      tdsAmount: '5000',
      paymentDate: today,
      method: 'cheque',
      allocations: [
        { invoiceId: a.id, amount: '30000' },
        { invoiceId: b.id, amount: '20000' },
      ],
    });
    expect(ok.body.data).toMatchObject({ settlement: '50000.00', unallocated: '0.00' });
    for (const id of [a.id, b.id])
      expect((await fin.agent.get(`/api/v1/invoices/${id}`)).body.data.displayStatus).toBe('paid');
    const tds = await post(fin, `/payments/${ok.body.data.id}/tds-certificate`, {
      certificateNumber: '16A-2026-001',
      receivedOn: today,
    });
    expect(tds.body.data.tdsCertificateNumber).toBe('16A-2026-001');
    await ledgerMatchesBalances();
  });

  it('an advance is held, then applied to a later invoice', async () => {
    const { fin, clientId, invoice, today, owner } = await setup();
    const adv = await post(fin, '/payments', {
      clientId,
      amount: '25000',
      paymentDate: today,
      method: 'upi',
      keepRemainderAsAdvance: true,
    });
    expect(adv.body.data.unallocated).toBe('25000.00');
    expect((await owner.agent.get(`/api/v1/billing/clients/${clientId}`)).body.data.advance).toBe('25000.00');
    const inv = await invoice('10000');
    const applied = await post(fin, `/payments/${adv.body.data.id}/allocations`, {
      invoiceId: inv.id,
      amount: '10000',
    });
    expect(applied.body.data.unallocated).toBe('15000.00');
    expect((await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data.displayStatus).toBe('paid');
    const over = await post(fin, `/payments/${adv.body.data.id}/allocations`, {
      invoiceId: inv.id,
      amount: '1',
    });
    expect(over.status).toBe(422); // invoice already paid
  });

  it('reversal restores the receivable; void is blocked while payments apply; voiding releases milestones', async () => {
    const { fin, clientId, main, today } = await setup();
    const fa = await post(fin, '/fee-agreements', {
      matterId: main.matterId,
      agreementType: 'milestone',
      agreedAmount: '100000',
      milestones: [
        { name: 'Retainer', amount: '50000' },
        { name: 'Filing', amount: '50000' },
      ],
    });
    const retainer = fa.body.data.milestones[0];
    const inv = (
      await post(fin, '/invoices', {
        matterId: main.matterId,
        issue: true,
        items: [{ description: 'Retainer', unitPrice: '50000', feeMilestoneId: retainer.id }],
      })
    ).body.data;
    const dup = await post(fin, '/invoices', {
      matterId: main.matterId,
      items: [{ description: 'Retainer again', unitPrice: '50000', feeMilestoneId: retainer.id }],
    });
    expect(dup.status).toBe(422);

    const pay = await post(fin, '/payments', {
      clientId,
      amount: '50000',
      paymentDate: today,
      method: 'cheque',
      allocations: [{ invoiceId: inv.id, amount: '50000' }],
    });
    expect((await post(fin, `/invoices/${inv.id}/void`, { reason: 'Raised in error' })).status).toBe(409);

    const rev = await post(fin, `/payments/${pay.body.data.id}/reverse`, { reason: 'Cheque bounced' });
    expect(rev.body.data.status).toBe('reversed');
    expect((await fin.agent.get(`/api/v1/invoices/${inv.id}`)).body.data).toMatchObject({
      amountDue: '50000.00',
      displayStatus: 'unpaid',
    });
    expect((await post(fin, `/payments/${pay.body.data.id}/reverse`, { reason: 'again' })).status).toBe(409);

    const voided = await post(fin, `/invoices/${inv.id}/void`, { reason: 'Raised in error' });
    expect(voided.body.data.status).toBe('void');
    const agreements = (await fin.agent.get('/api/v1/fee-agreements').query({ matterId: main.matterId })).body
      .data;
    expect(agreements[0].milestones[0]).toMatchObject({ status: 'planned', invoiceId: null });
    await ledgerMatchesBalances();
  });

  it('cannot apply a payment to another client’s invoice', async () => {
    const { fin, invoice, firm, today } = await setup();
    const inv = await invoice('1000');
    const other = await pool.query(
      `INSERT INTO clients (organization_id, name) VALUES ($1, 'Someone else') RETURNING id`,
      [firm.orgId],
    );
    const res = await post(fin, '/payments', {
      clientId: other.rows[0].id,
      amount: '1000',
      paymentDate: today,
      method: 'cash',
      allocations: [{ invoiceId: inv.id, amount: '1000' }],
    });
    expect(res.status).toBe(422);
  });
});

describe('billing: adjustments, expenses, access', () => {
  it('credit note reduces the due; cannot exceed it; write-off closes the rest', async () => {
    const { fin, invoice, today } = await setup();
    const inv = await invoice('10000');
    expect(
      (await post(fin, `/invoices/${inv.id}/credit-notes`, { amount: '10000.01', reason: 'Discount agreed' }))
        .status,
    ).toBe(422);
    const cn = await post(fin, `/invoices/${inv.id}/credit-notes`, {
      amount: '2500',
      reason: 'Discount agreed',
    });
    expect(cn.body.data).toMatchObject({
      amountCredited: '2500.00',
      amountDue: '7500.00',
      displayStatus: 'partial',
    });
    expect(cn.body.data.creditNotes[0].number).toBe(`CN/${fiscalYear(today)}/000001`);
    const wo = await post(fin, `/invoices/${inv.id}/write-off`, { reason: 'Client unreachable' });
    expect(wo.body.data).toMatchObject({ status: 'written_off', displayStatus: 'written_off' });
    const bad = await pool.query(
      `SELECT amount::text FROM ledger_entries WHERE entry_type = 'invoice_written_off'`,
    );
    expect(bad.rows[0].amount).toBe('7500.00');
  });

  it('clerk records a court fee; it is billed once as a pure-agent line; billed expenses are locked', async () => {
    const { fin, main } = await setup();
    const clerk = await loginAs(app, 'clerk@a.test');
    const exp = await post(clerk, '/expenses', {
      matterId: main.matterId,
      category: 'Court fees',
      amount: '1500',
      expenseDate: '2026-10-01',
    });
    expect(exp.status).toBe(201);
    expect((await clerk.agent.get('/api/v1/invoices')).status).toBe(403); // staff has no billing access
    const inv = await post(fin, '/invoices', {
      matterId: main.matterId,
      issue: true,
      items: [
        { description: 'Professional fees', unitPrice: '20000' },
        { description: 'Court fees', unitPrice: '1500', isPureAgent: true, expenseId: exp.body.data.id },
      ],
    });
    expect(inv.body.data.total).toBe('21500.00');
    const again = await post(fin, '/invoices', {
      matterId: main.matterId,
      items: [{ description: 'x', unitPrice: '1500', expenseId: exp.body.data.id }],
    });
    expect(again.status).toBe(422);
    expect((await post(fin, `/expenses/${exp.body.data.id}/void`, { reason: 'mistake' })).status).toBe(409);
    expect((await patch(clerk, `/expenses/${exp.body.data.id}`, { amount: '1600' })).status).toBe(403);
    await expect(pool.query(`DELETE FROM expenses WHERE id = $1`, [exp.body.data.id])).rejects.toThrow();
  });

  it('lawyers see billing only on assigned matters and cannot raise invoices; other firms see nothing', async () => {
    const { fin, privateMatter, invoice } = await setup();
    const mine = await invoice('1000');
    const hidden = (
      await post(fin, '/invoices', {
        matterId: privateMatter.matterId,
        issue: true,
        items: [{ description: 'x', unitPrice: '1' }],
      })
    ).body.data;
    const l1 = await loginAs(app, 'l1@a.test');
    const ids = (await l1.agent.get('/api/v1/invoices')).body.data.map((i: { id: string }) => i.id);
    expect(ids).toEqual([mine.id]);
    expect((await l1.agent.get(`/api/v1/invoices/${hidden.id}`)).status).toBe(404);
    expect(
      (
        await post(l1, '/invoices', {
          matterId: privateMatter.matterId,
          items: [{ description: 'x', unitPrice: '1' }],
        })
      ).status,
    ).toBe(403);

    await createFirm('Firm B', [{ email: 'owner@b.test', role: 'owner' }]);
    const b = await loginAs(app, 'owner@b.test');
    expect((await b.agent.get(`/api/v1/invoices/${mine.id}`)).status).toBe(404);
    expect((await post(b, `/invoices/${mine.id}/void`, { reason: 'steal' })).status).toBe(404);
    expect((await b.agent.get('/api/v1/billing/summary')).body.data.outstanding).toBe('0.00');
  });
});
