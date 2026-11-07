import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../src/deps.js';
import type { TenantContext } from '../src/http/context.js';
import { invoiceDocumentModel, loadInvoiceDocData } from '../src/modules/billing/pdf/invoice-pdf.js';
import { modelText } from '../src/modules/billing/pdf/layout.js';
import type { EmailMessage, EmailProvider } from '../src/modules/notifications/providers.js';
import { tick } from '../src/modules/workflows/processor.js';
import { addDays, buildApp, deps as baseDeps, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';
import { readFileSync } from 'node:fs';

useDatabase();
const app = buildApp();

class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Stands in for Zoho: token exchange, create link, cancel link. */
function fakeZoho() {
  const calls: { url: string; method: string }[] = [];
  const state = { failCancel: false };
  let n = 0;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('accounts.zoho.in/oauth/v2/token')) return json({ access_token: 'access-token-xyz', expires_in: 3600 });
    if (url.includes('/paymentlinks') && url.includes('/cancel'))
      return state.failCancel ? json({ code: 1, message: 'Zoho is down' }, 500) : json({ code: 0, message: 'Payment link Cancelled' });
    if (url.includes('/paymentlinks') && method === 'POST') {
      n += 1;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return json(
        {
          code: 0,
          message: 'Payment link created successfully',
          payment_links: {
            payment_link_id: `PL${n}`,
            url: `https://payments.zoho.in/paymentlinks/token${n}`,
            amount: Number(body.amount).toFixed(2),
            currency: 'INR',
            status: 'active',
            expires_at: body.expires_at,
          },
        },
        201,
      );
    }
    return json({ code: 1, message: 'unexpected call' }, 404);
  });
  return { impl, calls, state };
}

let zoho: ReturnType<typeof fakeZoho>;
beforeEach(() => {
  zoho = fakeZoho();
  vi.stubGlobal('fetch', zoho.impl);
});
afterEach(() => vi.unstubAllGlobals());

const post = (s: Session, path: string, body: object = {}) => s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) => s.agent.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const platformPatch = (s: PlatformSession, path: string, body: object) =>
  s.agent.patch(`/api/v1/platform${path}`).set('X-CSRF-Token', s.csrf).send(body);
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const CLIENT = 'raj@client.test';
const fees = (amount: string) => [{ description: 'Professional fees', unitPrice: amount }];

async function setup(opts: { zoho?: boolean } = {}) {
  const fx = await practiceFixture(app);
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId])).rows[0].client_id as string;
  await pool.query(`UPDATE clients SET email = $2 WHERE id = $1`, [clientId, CLIENT]);
  const email = new CaptureEmail();
  const deps: Deps = { ...baseDeps, email };
  const run = (at: Date) => tick(deps, at);
  const fin = await loginAs(app, 'finance@a.test');
  if (opts.zoho) {
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const ops = await platformLogin(app, 'ops@lfx.test', secret);
    const cfg = await platformPatch(ops, `/firms/${fx.firm.orgId}/zohopay`, {
      environment: 'sandbox',
      accountId: '105078477',
      clientId: '1000.CLIENTIDEXAMPLE',
      clientSecret: 'client-secret-value-123',
      refreshToken: '1000.refresh.token-value-456',
      signingKey: 'whsec-test-signing-key-0123456789abcdef',
      enabled: true,
    });
    if (cfg.status !== 200) throw new Error(JSON.stringify(cfg.body));
  }
  const dates = [addDays(fx.today, 10), addDays(fx.today, 20), addDays(fx.today, 30)];

  const issue = async (body: Record<string, unknown>, issueOpts: Record<string, unknown> = {}) => {
    const draft = await post(fin, '/invoices', { matterId: fx.main.matterId, ...body });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    const issued = await post(fin, `/invoices/${draft.body.data.id}/issue`, issueOpts);
    if (issued.status !== 200) throw new Error(JSON.stringify(issued.body));
    return issued.body.data as {
      id: string;
      invoiceNumber: string;
      dueDate: string;
      instalments: { id: string; seq: number; amount: string; dueDate: string }[];
    };
  };
  /** ₹50,000, no schedule. */
  const simpleInvoice = () => issue({ dueDate: addDays(fx.today, 15), items: fees('50000') });
  /** ₹30,000 in three ₹10,000 instalments. */
  const instalmentInvoice = () =>
    issue({ items: fees('30000'), instalments: ['10000', '10000', '10000'].map((amount, i) => ({ amount, dueDate: dates[i] })) });
  const pay = (invoiceId: string, amount: string) =>
    post(fin, '/payments', { clientId, amount, paymentDate: fx.today, method: 'upi', allocations: [{ invoiceId, amount }] });
  const revise = (invoiceId: string, body: Record<string, unknown>) => patch(fin, `/invoices/${invoiceId}/revision`, body);
  return { ...fx, clientId, email, deps, run, fin, dates, issue, simpleInvoice, instalmentInvoice, pay, revise };
}

const snapshot = async (invoiceId: string) => ({
  invoice: (await pool.query(`SELECT total_amount::text, revision, revised_at, due_date::text FROM invoices WHERE id = $1`, [invoiceId])).rows[0],
  items: (await pool.query(`SELECT description, amount::text FROM invoice_items WHERE invoice_id = $1 ORDER BY position`, [invoiceId])).rows,
  ledger: (await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE invoice_id = $1`, [invoiceId])).rows[0].n,
  events: (await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'INVOICE_REVISED'`)).rows[0].n,
});

/** AR movement per invoice in the ledger. */
const arBalance = async (invoiceId: string) =>
  Number(
    (
      await pool.query(
        `SELECT COALESCE(sum(CASE WHEN debit_account = 'accounts_receivable' THEN amount ELSE 0 END), 0)
              - COALESCE(sum(CASE WHEN credit_account = 'accounts_receivable' THEN amount ELSE 0 END), 0) AS ar
         FROM ledger_entries WHERE invoice_id = $1`,
        [invoiceId],
      )
    ).rows[0].ar,
  );

describe('invoice revisions (simple mode)', () => {
  it('GST firm → 409 and the DB is unchanged', async () => {
    const s = await setup();
    await patch(s.owner, '/organization', { taxMode: 'gst', gstin: '07AAACS1234A1Z5', stateCode: '07' });
    const inv = await s.simpleInvoice();
    const before = await snapshot(inv.id);
    const res = await s.revise(inv.id, { items: fees('60000') });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('GST invoices can’t be edited; issue a credit note');
    expect(await snapshot(inv.id)).toEqual(before);
  });

  it('a simple-mode invoice is refused once the firm has switched to GST', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    await pool.query(`UPDATE organizations SET tax_mode = 'gst', gstin = '07AAACS1234A1Z5', state_code = '07' WHERE id = $1`, [s.firm.orgId]);
    const res = await s.revise(inv.id, { items: fees('60000') });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('GST invoices');
  });

  it('only an issued invoice can be revised', async () => {
    const s = await setup();
    const draft = await post(s.fin, '/invoices', { matterId: s.main.matterId, items: fees('1000') });
    expect((await s.revise(draft.body.data.id, { items: fees('2000') })).status).toBe(409);
  });

  it('simple firm: total 50,000 → 60,000; revision=1; AR balance and v_invoice_balances show 60,000 minus paid', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    expect(inv).toMatchObject({ revision: 0, canRevise: true });
    expect((await s.pay(inv.id, '20000')).status).toBe(201);
    const res = await s.revise(inv.id, { items: fees('60000'), notes: 'Added appearance fee' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: '60000.00', amountDue: '40000.00', revision: 1, notes: 'Added appearance fee' });
    expect(res.body.data.revisedAt).toBeTruthy();
    expect(res.body.data.invoiceNumber).toBe(inv.invoiceNumber);
    const bal = (await pool.query(`SELECT amount_due::text FROM v_invoice_balances WHERE invoice_id = $1`, [inv.id])).rows[0];
    expect(bal.amount_due).toBe('40000.00');
    expect(await arBalance(inv.id)).toBe(40000);
    const delta = (await pool.query(`SELECT debit_account, credit_account, amount::text FROM ledger_entries WHERE invoice_id = $1 AND entry_type = 'invoice_revised'`, [inv.id])).rows;
    expect(delta).toEqual([{ debit_account: 'accounts_receivable', credit_account: 'fee_revenue', amount: '10000.00' }]);
    const evt = (await pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'INVOICE_REVISED'`)).rows[0];
    expect(evt.payload).toMatchObject({ invoiceId: inv.id, notifyClient: false });
    const audit = (await pool.query(`SELECT before_json AS before, after_json AS after FROM audit_logs WHERE action = 'invoice.revised'`)).rows[0];
    expect(audit.before).toMatchObject({ total: '50000.00', revision: 0 });
    expect(audit.after).toMatchObject({ total: '60000.00', revision: 1 });
    const tl = (await pool.query(`SELECT title FROM timeline_events WHERE event_type = 'invoice.revised'`)).rows;
    expect(tl).toHaveLength(1);
  });

  it('a decrease with simple tax posts the exact contra deltas', async () => {
    const s = await setup();
    const inv = await s.issue({ dueDate: addDays(s.today, 15), items: fees('50000'), taxAmount: '5000' });
    const res = await s.revise(inv.id, { items: fees('40000'), taxAmount: '4000.50' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: '44000.50', taxAmount: '4000.50' });
    const delta = (await pool.query(`SELECT debit_account, credit_account, amount::text FROM ledger_entries WHERE invoice_id = $1 AND entry_type = 'invoice_revised' ORDER BY credit_account`, [inv.id])).rows;
    expect(delta).toEqual([
      { debit_account: 'fee_revenue', credit_account: 'accounts_receivable', amount: '10000.00' },
      { debit_account: 'gst_output', credit_account: 'accounts_receivable', amount: '999.50' },
    ]);
    expect(await arBalance(inv.id)).toBe(44000.5);
  });

  it('decrease below the paid amount → 422', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    expect((await s.pay(inv.id, '30000')).status).toBe(201);
    const res = await s.revise(inv.id, { items: fees('25000') });
    expect(res.status).toBe(422);
    expect((await snapshot(inv.id)).invoice.revision).toBe(0);
  });

  it('changing a paid instalment → 409; changing an unpaid one → ok', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    expect((await s.pay(inv.id, '10000')).status).toBe(201);
    const ids = inv.instalments.map((i) => i.id);

    const paidChanged = await s.revise(inv.id, {
      items: fees('30000'),
      instalments: [
        { amount: '12000', dueDate: s.dates[0] },
        { amount: '8000', dueDate: s.dates[1] },
        { amount: '10000', dueDate: s.dates[2] },
      ],
    });
    expect(paidChanged.status).toBe(409);
    const paidMoved = await s.revise(inv.id, {
      items: fees('30000'),
      instalments: [
        { amount: '10000', dueDate: addDays(s.today, 5) },
        { amount: '10000', dueDate: s.dates[1] },
        { amount: '10000', dueDate: s.dates[2] },
      ],
    });
    expect(paidMoved.status).toBe(409);
    const paidRemoved = await s.revise(inv.id, { items: fees('30000'), instalments: [] });
    expect(paidRemoved.status).toBe(409);

    const ok = await s.revise(inv.id, {
      items: fees('35000'),
      instalments: [
        { amount: '10000', dueDate: s.dates[0] },
        { amount: '10000', dueDate: s.dates[1] },
        { amount: '15000', dueDate: s.dates[2] },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.instalments.map((i: { id: string; amount: string; status: string }) => [i.id, i.amount, i.status])).toEqual([
      [ids[0], '10000.00', 'paid'],
      [ids[1], '10000.00', 'due'],
      [ids[2], '15000.00', 'due'],
    ]);
  });

  it('a part-paid instalment cannot drop below what is paid on it', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    expect((await s.pay(inv.id, '6000')).status).toBe(201);
    const res = await s.revise(inv.id, {
      items: fees('30000'),
      instalments: [
        { amount: '5000', dueDate: s.dates[0] },
        { amount: '15000', dueDate: s.dates[1] },
        { amount: '10000', dueDate: s.dates[2] },
      ],
    });
    expect(res.status).toBe(409);
  });

  it('instalments key absent keeps the schedule, but it must still add up to the new total', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    expect((await s.revise(inv.id, { items: fees('31000') })).status).toBe(422);
    const ok = await s.revise(inv.id, { items: fees('30000'), notes: 'Notes only' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.instalments.map((i: { id: string }) => i.id)).toEqual(inv.instalments.map((i) => i.id));
  });

  it('instalment due date moved → old link-email action cancelled, new one planned at new due-3 10:00', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    await s.run(new Date());
    const actions = async () =>
      (
        await pool.query(
          `SELECT sa.target_id, sa.status, sa.run_at FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
           WHERE w.system_key = 'instalment_link_3d' ORDER BY sa.created_at`,
        )
      ).rows as { target_id: string; status: string; run_at: Date }[];
    expect(await actions()).toHaveLength(2);
    await pool.query(`UPDATE invoice_instalments SET emailed_at = now() WHERE id = $1`, [inv.instalments[1]!.id]);

    const moved = addDays(s.today, 25);
    const res = await s.revise(inv.id, {
      items: fees('30000'),
      instalments: [
        { amount: '10000', dueDate: s.dates[0] },
        { amount: '10000', dueDate: moved },
        { amount: '10000', dueDate: s.dates[2] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.instalments[1].emailedAt).toBeNull();
    await s.run(new Date());

    const after = await actions();
    const second = after.filter((a) => a.target_id === inv.instalments[1]!.id);
    expect(second.map((a) => a.status)).toEqual(['cancelled', 'scheduled']);
    expect(second[1]!.run_at.toISOString()).toBe(ist(addDays(s.today, 22), '10:00').toISOString());
    // The unchanged instalment keeps its single plan; nothing is duplicated, and the invoice email is not re-sent.
    const third = after.filter((a) => a.target_id === inv.instalments[2]!.id);
    expect(third.map((a) => a.status)).toEqual(['scheduled']);
    expect(s.email.sent.filter((m) => /^Invoice/.test(m.subject))).toHaveLength(1);
  });

  it('invoice without a schedule: a moved due date re-plans its reminders; unchanged ones are not duplicated', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    await s.run(new Date());
    const dueToday = async () =>
      (
        await pool.query(
          `SELECT sa.status, sa.run_at FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
           WHERE w.system_key = 'invoice_due_today' ORDER BY sa.created_at`,
        )
      ).rows as { status: string; run_at: Date }[];
    expect((await dueToday()).map((a) => a.status)).toEqual(['scheduled']);
    // Amount-only revision: same due date, so the plan stands.
    expect((await s.revise(inv.id, { items: fees('51000'), dueDate: inv.dueDate })).status).toBe(200);
    await s.run(new Date());
    expect((await dueToday()).map((a) => a.status)).toEqual(['scheduled']);
    const moved = addDays(s.today, 40);
    expect((await s.revise(inv.id, { items: fees('51000'), dueDate: moved })).status).toBe(200);
    await s.run(new Date());
    const after = await dueToday();
    expect(after.map((a) => a.status)).toEqual(['cancelled', 'scheduled']);
    expect(after[1]!.run_at.toISOString()).toBe(ist(moved, '10:00').toISOString());
  });

  it('notifyClient sends invoice_updated with the PDF showing "Revision 1"', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    await s.run(new Date());
    s.email.sent.length = 0;
    const res = await s.revise(inv.id, { items: fees('60000'), notifyClient: true });
    expect(res.status).toBe(200);
    await s.run(new Date());
    const mail = s.email.sent.find((m) => /^Revised invoice/.test(m.subject))!;
    expect(mail).toBeDefined();
    expect(mail.to).toBe(CLIENT);
    expect(mail.subject).toContain('60,000.00');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]!.content.subarray(0, 4).toString('latin1')).toBe('%PDF');
    const ctx: TenantContext = { userId: s.firm.users['finance@a.test']!.userId, organizationId: s.firm.orgId, role: 'finance', features: ['billing'] };
    const text = modelText(invoiceDocumentModel(await loadInvoiceDocData(s.deps, ctx, inv.id)));
    expect(text).toContain('Revision 1 · ');
    // Without notifyClient nothing goes to the client.
    s.email.sent.length = 0;
    expect((await s.revise(inv.id, { items: fees('61000') })).status).toBe(200);
    await s.run(new Date());
    expect(s.email.sent.filter((m) => m.to === CLIENT)).toHaveLength(0);
  });

  it('active DSC document superseded after revision', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    const SIGNED = readFileSync(new URL('./fixtures/signed.pdf', import.meta.url));
    const start = await post(s.fin, `/invoices/${inv.id}/signed-document/uploads`);
    storage.putDirect(`incoming/signed/${s.firm.orgId}/${inv.id}/${start.body.data.uploadId}`, SIGNED);
    const done = await post(s.fin, `/invoices/${inv.id}/signed-document/uploads/${start.body.data.uploadId}/complete`);
    expect(done.body.data.signedDocument).not.toBeNull();
    const res = await s.revise(inv.id, { items: fees('60000') });
    expect(res.status).toBe(200);
    expect(res.body.data.signedDocument).toBeNull();
    const rows = (await pool.query(`SELECT superseded_at FROM invoice_signed_documents WHERE invoice_id = $1`, [inv.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].superseded_at).not.toBeNull();
  });

  it('cancels instalment links whose amount no longer matches; a Zoho failure aborts with nothing changed', async () => {
    const s = await setup({ zoho: true });
    const inv = await s.instalmentInvoice();
    await s.run(new Date()); // invoice email → link for instalment 1
    const active = async () =>
      (await pool.query(`SELECT instalment_id, amount::text FROM payment_links WHERE invoice_id = $1 AND status = 'active'`, [inv.id])).rows;
    expect(await active()).toEqual([{ instalment_id: inv.instalments[0]!.id, amount: '10000.00' }]);

    const body = {
      items: fees('32000'),
      instalments: [
        { amount: '12000', dueDate: s.dates[0] },
        { amount: '10000', dueDate: s.dates[1] },
        { amount: '10000', dueDate: s.dates[2] },
      ],
    };
    zoho.state.failCancel = true;
    const failed = await s.revise(inv.id, body);
    expect(failed.status).toBe(502);
    expect((await snapshot(inv.id)).invoice).toMatchObject({ total_amount: '30000.00', revision: 0 });
    expect(await active()).toHaveLength(1);

    zoho.state.failCancel = false;
    const ok = await s.revise(inv.id, body);
    expect(ok.status).toBe(200);
    expect(await active()).toEqual([]);
    expect(zoho.calls.filter((c) => c.url.includes('/cancel'))).toHaveLength(2);
  });

  it('an instalment that is removed loses its schedule; a whole-invoice link with a stale amount is cancelled', async () => {
    const s = await setup({ zoho: true });
    const inv = await s.instalmentInvoice();
    const res = await s.revise(inv.id, {
      items: fees('30000'),
      instalments: [
        { amount: '10000', dueDate: s.dates[0] },
        { amount: '20000', dueDate: s.dates[2] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.instalments.map((i: { seq: number; amount: string }) => [i.seq, i.amount])).toEqual([
      [1, '10000.00'],
      [2, '20000.00'],
    ]);
    expect(res.body.data.dueDate).toBe(s.dates[2]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM invoice_instalments WHERE invoice_id = $1`, [inv.id])).rows[0].n).toBe(2);

    const plain = await s.simpleInvoice();
    expect((await post(s.fin, `/invoices/${plain.id}/payment-links`, {})).status).toBe(201);
    expect((await s.revise(plain.id, { items: fees('55000') })).status).toBe(200);
    const links = (await pool.query(`SELECT status FROM payment_links WHERE invoice_id = $1`, [plain.id])).rows;
    expect(links).toEqual([{ status: 'canceled' }]);
  });

  it('canRevise needs invoices.manage', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    const lawyer = await loginAs(app, 'l1@a.test');
    const seen = await lawyer.agent.get(`/api/v1/invoices/${inv.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.canRevise).toBe(false);
    expect((await patch(lawyer, `/invoices/${inv.id}/revision`, { items: fees('60000') })).status).toBe(403);
  });
});

describe('invoice_updated carries the payment terms', () => {
  it('revising an instalment invoice with notifyClient includes the schedule', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    await s.run(new Date());
    s.email.sent.length = 0;
    expect((await s.revise(inv.id, { items: fees('30000'), notifyClient: true })).status).toBe(200);
    await s.run(new Date());
    const mail = s.email.sent.find((m) => /^Revised invoice/.test(m.subject))!;
    expect(mail).toBeDefined();
    expect(mail.subject).toContain('10,000.00 due');
    expect(mail.html).toContain('<thead');
    expect(mail.html).toContain('Due now');
    expect((mail.text.match(/10,000\.00/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('final-review fixes', () => {
  it('F2: a held invoice_issued email is cancelled by a revision; approving it afterwards is refused', async () => {
    const s = await setup();
    await s.run(new Date()); // seeds the firm's default workflows
    await pool.query(`UPDATE workflows SET requires_approval = true WHERE system_key = 'invoice_issued'`);
    const inv = await s.simpleInvoice();
    await s.run(new Date());
    const [held] = (await pool.query(`SELECT id FROM notifications WHERE notification_type = 'invoice_issued' AND status = 'awaiting_approval'`)).rows;
    expect(held).toBeTruthy();

    expect((await s.revise(inv.id, { items: fees('60000') })).status).toBe(200);
    const row = (await pool.query(`SELECT status, skip_reason FROM notifications WHERE id = $1`, [held.id])).rows[0];
    expect(row).toEqual({ status: 'cancelled', skip_reason: 'invoice_revised' });
    expect((await post(s.owner, `/notifications/${held.id}/approve`)).status).toBe(409);
    await s.run(new Date());
    expect(s.email.sent.filter((m) => m.to === CLIENT)).toHaveLength(0);
  });

  it('F4: notifyClient on a never-sent invoice → 422; without it the revision saves', async () => {
    const s = await setup();
    const inv = await s.issue({ dueDate: addDays(s.today, 15), items: fees('50000') }, { sendToClient: false });
    const res = await s.revise(inv.id, { items: fees('60000'), notifyClient: true });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('This invoice hasn’t been sent yet. Save without notifying, then use Send.');
    expect((await snapshot(inv.id)).invoice.revision).toBe(0);
    expect((await s.revise(inv.id, { items: fees('60000') })).status).toBe(200);
  });

  const dueToday = async () =>
    (
      await pool.query(
        `SELECT sa.status, sa.run_at, sa.cancel_reason FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
         WHERE w.system_key = 'invoice_due_today' ORDER BY sa.created_at`,
      )
    ).rows as { status: string; run_at: Date; cancel_reason: string | null }[];

  it('F5: a fully paid invoice revised upward gets its reminders back', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    await s.run(new Date());
    expect((await s.pay(inv.id, '50000')).status).toBe(201);
    await s.run(new Date());
    expect((await dueToday()).map((a) => a.status)).toEqual(['cancelled']);

    expect((await s.revise(inv.id, { items: fees('60000') })).status).toBe(200);
    await s.run(new Date());
    expect(await dueToday()).toEqual([{ status: 'scheduled', run_at: ist(inv.dueDate, '10:00'), cancel_reason: null }]);
  });

  it('F5: due date moved away and back → the original reminder is revived', async () => {
    const s = await setup();
    const inv = await s.simpleInvoice();
    await s.run(new Date());
    const moved = addDays(s.today, 40);
    expect((await s.revise(inv.id, { items: fees('50000'), dueDate: moved })).status).toBe(200);
    await s.run(new Date());
    expect((await dueToday()).map((a) => a.status)).toEqual(['cancelled', 'scheduled']);
    expect((await s.revise(inv.id, { items: fees('50000'), dueDate: inv.dueDate })).status).toBe(200);
    await s.run(new Date());
    const after = await dueToday();
    expect(after.map((a) => a.status)).toEqual(['scheduled', 'cancelled']);
    expect(after[0]!.run_at.toISOString()).toBe(ist(inv.dueDate, '10:00').toISOString());
  });
});
