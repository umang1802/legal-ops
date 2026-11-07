import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../src/deps.js';
import { ProviderError, type EmailMessage, type EmailProvider } from '../src/modules/notifications/providers.js';
import { ensureInstalmentLink } from '../src/modules/online-payments/payment-links.service.js';
import { DEFAULT_WORKFLOWS, ensureDefaultsOnce } from '../src/modules/workflows/defaults.js';
import { tick } from '../src/modules/workflows/processor.js';
import { addDays, buildApp, createFirm, deps as baseDeps, loginAs, pool, practiceFixture, type Session, storage, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin, type PlatformSession } from './platform-helpers.js';

useDatabase();
const app = buildApp();

/** Records what would have been emailed; can be told to fail. */
class CaptureEmail implements EmailProvider {
  readonly name = 'capture';
  sent: EmailMessage[] = [];
  failWith: 'transient' | 'permanent' | null = null;
  async send(m: EmailMessage) {
    if (this.failWith) throw new ProviderError(`simulated ${this.failWith} failure`, this.failWith === 'permanent');
    this.sent.push(m);
    return { providerMessageId: `cap-${this.sent.length}` };
  }
  to(addr: string) {
    return this.sent.filter((m) => m.to === addr);
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
const platformPatch = (s: PlatformSession, path: string, body: object) =>
  s.agent.patch(`/api/v1/platform${path}`).set('X-CSRF-Token', s.csrf).send(body);
/** A firm-local (IST) wall-clock instant. */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const CLIENT = 'raj@client.test';

async function setup() {
  const fx = await practiceFixture(app);
  const clientId = (await pool.query(`SELECT client_id FROM matters WHERE id = $1`, [fx.main.matterId])).rows[0].client_id as string;
  await pool.query(`UPDATE clients SET email = $2 WHERE id = $1`, [clientId, CLIENT]);
  const email = new CaptureEmail();
  const deps: Deps = { ...baseDeps, email };
  const run = (at: Date) => tick(deps, at);
  const fin = await loginAs(app, 'finance@a.test');
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
  const dates = [addDays(fx.today, 10), addDays(fx.today, 20), addDays(fx.today, 30)];

  /** A ₹30,000 invoice in three ₹10,000 instalments; issued (and sent, unless told otherwise). */
  const instalmentInvoice = async (opts: { sendToClient?: boolean } = {}) => {
    const draft = await post(fin, '/invoices', {
      matterId: fx.main.matterId,
      items: [{ description: 'Professional fees', unitPrice: '30000' }],
      instalments: ['10000', '10000', '10000'].map((amount, i) => ({ amount, dueDate: dates[i] })),
    });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    const issued = await post(fin, `/invoices/${draft.body.data.id}/issue`, opts.sendToClient === undefined ? {} : { sendToClient: opts.sendToClient });
    if (issued.status !== 200) throw new Error(JSON.stringify(issued.body));
    return issued.body.data as { id: string; sentAt: string | null; instalments: { id: string; seq: number }[] };
  };
  const pay = (invoiceId: string, amount: string) =>
    post(fin, '/payments', { clientId, amount, paymentDate: fx.today, method: 'upi', allocations: [{ invoiceId, amount }] });
  const linkEmails = () => email.to(CLIENT).filter((m) => /^Instalment/.test(m.subject));
  const invoiceEmails = () => email.to(CLIENT).filter((m) => /^Invoice/.test(m.subject));
  const reminders = () => email.to(CLIENT).filter((m) => /^Payment (due|overdue)/.test(m.subject));
  return { ...fx, clientId, email, deps, run, fin, dates, instalmentInvoice, pay, linkEmails, invoiceEmails, reminders };
}

const actionsFor = async (systemKey: string) =>
  (
    await pool.query(
      `SELECT sa.target_type, sa.target_id, sa.status, sa.run_at, sa.result FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
       WHERE w.system_key = $1 ORDER BY sa.run_at`,
      [systemKey],
    )
  ).rows;
const scheduledCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM scheduled_actions`)).rows[0].n as number;

describe('issue options and Send', () => {
  it('issue with sendToClient=false sends nothing and plans nothing; POST /send then emails the invoice with instalment 1\'s link', async () => {
    const { fin, run, email, instalmentInvoice } = await setup();
    const inv = await instalmentInvoice({ sendToClient: false });
    expect(inv.sentAt).toBeNull();
    await run(new Date());
    expect(email.to(CLIENT)).toHaveLength(0);
    expect(await scheduledCount()).toBe(0);

    const sent = await post(fin, `/invoices/${inv.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.data.sentAt).not.toBeNull();
    await run(new Date());
    const mails = email.to(CLIENT);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/^Invoice/);
    expect(mails[0]!.html).toContain('https://payments.zoho.in/paymentlinks/token1');
    const link = (await pool.query(`SELECT instalment_id, amount::text FROM payment_links WHERE status = 'active'`)).rows;
    expect(link).toEqual([{ instalment_id: inv.instalments[0]!.id, amount: '10000.00' }]);
    expect(await scheduledCount()).toBeGreaterThan(0);
  });

  it('a draft cannot be sent; only issued invoices', async () => {
    const { fin, main } = await setup();
    const draft = await post(fin, '/invoices', { matterId: main.matterId, items: [{ description: 'Fees', unitPrice: '100' }] });
    expect((await post(fin, `/invoices/${draft.body.data.id}/send`)).status).toBe(409);
  });

  it('pressing Send twice re-sends the invoice email but does not duplicate scheduled reminders', async () => {
    const { fin, run, instalmentInvoice, invoiceEmails } = await setup();
    const inv = await instalmentInvoice({ sendToClient: false });
    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(invoiceEmails()).toHaveLength(1);
    const planned = await scheduledCount();

    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(invoiceEmails()).toHaveLength(2);
    // Only the new immediate "invoice issued" action was added; reminders stay one per instalment.
    expect(await scheduledCount()).toBe(planned + 1);
    expect(await actionsFor('instalment_link_3d')).toHaveLength(2);
  });
});

describe('per-instalment scheduling', () => {
  it('3 instalments → link emails for #2 and #3 at due-3 10:00 IST; none for #1', async () => {
    const { run, dates, instalmentInvoice, linkEmails, invoiceEmails } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    expect(invoiceEmails()).toHaveLength(1);

    const planned = await actionsFor('instalment_link_3d');
    expect(planned.map((p) => p.target_id)).toEqual([inv.instalments[1]!.id, inv.instalments[2]!.id]);
    expect(planned.every((p) => p.target_type === 'instalment')).toBe(true);
    expect(planned[0].run_at.toISOString()).toBe(ist(addDays(dates[1]!, -3), '10:00').toISOString());
    // The link email replaces the -3 reminder for instalment invoices.
    expect(await actionsFor('invoice_due_3d')).toHaveLength(0);

    await run(ist(addDays(dates[1]!, -3), '09:59'));
    expect(linkEmails()).toHaveLength(0);
    await run(ist(addDays(dates[1]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(1);
    expect(linkEmails()[0]!.subject).toContain('Instalment 2 of 3');
    expect(linkEmails()[0]!.html).toContain('https://payments.zoho.in/paymentlinks/token2');

    await run(ist(addDays(dates[2]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(2);
    expect(linkEmails()[1]!.subject).toContain('Instalment 3 of 3');
    // A repeat pass sends nothing new.
    await run(ist(addDays(dates[2]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(2);
    const stamped = (await pool.query(`SELECT seq, emailed_at IS NOT NULL AS e FROM invoice_instalments ORDER BY seq`)).rows;
    expect(stamped).toEqual([{ seq: 1, e: false }, { seq: 2, e: true }, { seq: 3, e: true }]);
  });

  it('instalment #2 fully paid by a manual payment before its run time → skipped, no email', async () => {
    const { run, dates, instalmentInvoice, linkEmails, pay } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    expect((await pay(inv.id, '20000')).status).toBe(201); // covers #1 and #2, in order
    await run(new Date());
    const creates = zoho.calls.filter((c) => c.method === 'POST' && /paymentlinks\?/.test(c.url)).length;

    await run(ist(addDays(dates[1]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(0);
    const [a2] = (await actionsFor('instalment_link_3d')).filter((a) => a.target_id === inv.instalments[1]!.id);
    expect(a2).toMatchObject({ status: 'skipped', result: { reason: 'Instalment already paid' } });
    expect(zoho.calls.filter((c) => c.method === 'POST' && /paymentlinks\?/.test(c.url)).length).toBe(creates);

    await run(ist(addDays(dates[2]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(1);
    expect(linkEmails()[0]!.subject).toContain('Instalment 3 of 3');
  });

  it('instalment overdue reminders are per instalment', async () => {
    const { run, dates, instalmentInvoice, reminders } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    const overdue = await actionsFor('invoice_overdue_3d');
    expect(overdue.map((a) => a.target_id)).toEqual(inv.instalments.map((i) => i.id));

    await run(ist(dates[0]!, '10:05'));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.subject).toMatch(/due today/);

    await run(ist(addDays(dates[0]!, 3), '10:05'));
    expect(reminders()).toHaveLength(2);
    const r = reminders()[1]!;
    expect(r.subject).toMatch(/overdue by 3 days/);
    expect(r.subject).toContain('₹10,000.00');
  });

  it('invoice without instalments behaves exactly as before', async () => {
    const { fin, main, today, run, email } = await setup();
    const dueDate = addDays(today, 10);
    const inv = await post(fin, '/invoices', { matterId: main.matterId, dueDate, items: [{ description: 'Professional fees', unitPrice: '50000' }], issue: true });
    expect(inv.status).toBe(201);
    expect(inv.body.data.sentAt).not.toBeNull();
    await run(new Date());
    expect(email.to(CLIENT)).toHaveLength(1);
    expect(email.to(CLIENT)[0]!.html).not.toContain('paymentlinks');
    expect(await actionsFor('instalment_link_3d')).toHaveLength(0);

    await run(ist(addDays(dueDate, 3), '10:05'));
    // -3, 0 and +3 reminders were all due by now.
    expect(email.to(CLIENT)).toHaveLength(4);
    expect((await actionsFor('invoice_due_3d')).map((a) => a.target_type)).toEqual(['invoice']);
  });
});

describe('stale payment links are never sent', () => {
  it('after a part payment, when Zoho cannot cancel the old link, the invoice email goes without it', async () => {
    const { fin, run, instalmentInvoice, invoiceEmails, pay } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    expect(invoiceEmails()[0]!.html).toContain('paymentlinks/token1'); // ₹10,000 link for #1
    expect((await pay(inv.id, '4000')).status).toBe(201);
    await run(new Date());
    zoho.state.failCancel = true;
    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(invoiceEmails()).toHaveLength(2);
    expect(invoiceEmails()[1]!.html).not.toContain('paymentlinks');
    // The stale ₹10,000 link is still active at Zoho and in our table, but was not exposed.
    expect((await pool.query(`SELECT amount::text FROM payment_links WHERE status = 'active'`)).rows).toEqual([{ amount: '10000.00' }]);
  });

  it('an instalment link email with no link for what is owed is not sent; the action fails visibly', async () => {
    const { run, dates, uid, instalmentInvoice, linkEmails, pay, deps, firm } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    await ensureInstalmentLink(deps, firm.orgId, inv.instalments[1]!.id, uid('finance@a.test')); // ₹10,000 for #2
    expect((await pay(inv.id, '14000')).status).toBe(201); // #1 paid, ₹4,000 of #2
    await run(new Date());
    zoho.state.failCancel = true;

    await run(ist(addDays(dates[1]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(0);
    const a = (await pool.query(
      `SELECT sa.status, sa.last_error FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
       WHERE w.system_key = 'instalment_link_3d' AND sa.target_id = $1`,
      [inv.instalments[1]!.id],
    )).rows[0];
    expect(a.status).toBe('failed');
    expect(a.last_error).toMatch(/No payment link for the amount still owed on instalment 2: Zoho could not be reached/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE notification_type = 'instalment_payment_link'`)).rows[0].n).toBe(0);
  });
});

describe('firms without online payments', () => {
  it('instalment link emails are skipped (not failed) when the firm has no enabled Zoho Pay gateway', async () => {
    const { run, dates, instalmentInvoice, linkEmails, invoiceEmails, firm } = await setup();
    await pool.query(`DELETE FROM organization_payment_gateways WHERE organization_id = $1`, [firm.orgId]);
    const inv = await instalmentInvoice();
    await run(new Date());
    expect(invoiceEmails()).toHaveLength(1);
    expect(invoiceEmails()[0]!.html).not.toContain('paymentlinks');

    await run(ist(addDays(dates[1]!, -3), '10:00'));
    expect(linkEmails()).toHaveLength(0);
    const a = (await pool.query(
      `SELECT sa.status, sa.result, sa.last_error FROM scheduled_actions sa JOIN workflows w ON w.id = sa.workflow_id
       WHERE w.system_key = 'instalment_link_3d' AND sa.target_id = $1`,
      [inv.instalments[1]!.id],
    )).rows[0];
    expect(a).toEqual({ status: 'skipped', result: { reason: 'Online payments not enabled' }, last_error: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM scheduled_actions WHERE status = 'failed'`)).rows[0].n).toBe(0);
  });
});

describe('default recipes for instalments', () => {
  it('new firms get instalment_link_3d and the guarded invoice_due_3d', async () => {
    const { orgId } = await createFirm('New', [{ email: 'o@new.test', role: 'owner' }]);
    await ensureDefaultsOnce(pool, orgId);
    const rows = (await pool.query(`SELECT system_key, trigger_config, conditions, actions FROM workflows WHERE organization_id = $1 AND system_key IN ('instalment_link_3d', 'invoice_due_3d') ORDER BY system_key`, [orgId])).rows;
    expect(rows).toEqual([
      {
        system_key: 'instalment_link_3d',
        trigger_config: { timing: 'relative', anchor: 'instalment.due_date', offsetDays: -3, at: '10:00' },
        conditions: [{ field: 'instalment.seq', operator: 'greater_than', value: 1 }],
        actions: [{ type: 'notify', channel: 'email', recipient: 'client', templateKey: 'instalment_payment_link' }],
      },
      expect.objectContaining({ system_key: 'invoice_due_3d', conditions: [{ field: 'instalment.count', operator: 'is_empty' }] }),
    ]);
  });

  it('existing firms get the new recipe, and invoice_due_3d is guarded unless the firm changed its conditions', async () => {
    const keysBefore = DEFAULT_WORKFLOWS.map((d) => d.key).filter((k) => k !== 'instalment_link_3d');
    const seedOld = async (name: string) => {
      const { orgId } = await createFirm(name, [{ email: `o@${name}.test`, role: 'owner' }]);
      await ensureDefaultsOnce(pool, orgId);
      await pool.query(`DELETE FROM workflows WHERE organization_id = $1 AND system_key = 'instalment_link_3d'`, [orgId]);
      await pool.query(`UPDATE workflows SET conditions = '[]' WHERE organization_id = $1 AND system_key = 'invoice_due_3d'`, [orgId]);
      await pool.query(`UPDATE organizations SET settings = jsonb_build_object('seededWorkflowKeys', $2::jsonb) WHERE id = $1`, [orgId, JSON.stringify(keysBefore)]);
      return orgId;
    };
    const plain = await seedOld('plain');
    const custom = await seedOld('custom');
    const own = [{ field: 'matter.priority', operator: 'equals', value: 'high' }];
    await pool.query(`UPDATE workflows SET conditions = $2 WHERE organization_id = $1 AND system_key = 'invoice_due_3d'`, [custom, JSON.stringify(own)]);

    expect(await ensureDefaultsOnce(pool, plain)).toEqual(['instalment_link_3d']);
    expect(await ensureDefaultsOnce(pool, custom)).toEqual(['instalment_link_3d']);
    const cond = async (org: string) =>
      (await pool.query(`SELECT conditions FROM workflows WHERE organization_id = $1 AND system_key = 'invoice_due_3d'`, [org])).rows[0].conditions;
    expect(await cond(plain)).toEqual([{ field: 'instalment.count', operator: 'is_empty' }]);
    expect(await cond(custom)).toEqual(own);
    // Offered once: a later firm edit back to no conditions is not overwritten.
    await pool.query(`UPDATE workflows SET conditions = '[]' WHERE organization_id = $1 AND system_key = 'invoice_due_3d'`, [plain]);
    await ensureDefaultsOnce(pool, plain);
    expect(await cond(plain)).toEqual([]);
  });
});

describe('email attachments and CC', () => {
  const SIGNED = readFileSync(new URL('./fixtures/signed.pdf', import.meta.url));
  const pdfMagic = (b: Buffer) => b.subarray(0, 4).toString('latin1') === '%PDF';

  it('invoice email carries the Invoice-…pdf attachment and the client\'s CC addresses', async () => {
    const { clientId, run, email, instalmentInvoice, invoiceEmails } = await setup();
    await pool.query(`UPDATE clients SET cc_emails = $2 WHERE id = $1`, [clientId, ['Acct@Client.test', 'acct@client.test', CLIENT.toUpperCase(), 'boss@client.test']]);
    await instalmentInvoice();
    await run(new Date());
    const mail = invoiceEmails()[0]!;
    // Deduped case-insensitively, and the To address is never repeated in CC.
    expect(mail.cc).toEqual(['Acct@Client.test', 'boss@client.test']);
    expect(mail.attachments).toHaveLength(1);
    const att = mail.attachments![0]!;
    expect(att.filename).toMatch(/^Invoice-.*\.pdf$/);
    expect(att.contentType).toBe('application/pdf');
    expect(pdfMagic(att.content)).toBe(true);
    expect(email.sent).toHaveLength(1);
  });

  it('with a DSC upload, the attachment is the signed bytes', async () => {
    const { fin, firm, run, instalmentInvoice, invoiceEmails } = await setup();
    const inv = await instalmentInvoice({ sendToClient: false });
    const start = await post(fin, `/invoices/${inv.id}/signed-document/uploads`);
    expect(start.status).toBe(201);
    storage.putDirect(`incoming/signed/${firm.orgId}/${inv.id}/${start.body.data.uploadId}`, SIGNED);
    expect((await post(fin, `/invoices/${inv.id}/signed-document/uploads/${start.body.data.uploadId}/complete`)).status).toBe(200);
    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(invoiceEmails()[0]!.attachments![0]!.content.equals(SIGNED)).toBe(true);
  });

  it('receipt email attaches the receipt pdf', async () => {
    const { run, email, instalmentInvoice, pay } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    email.sent.length = 0;
    expect((await pay(inv.id, '10000')).status).toBe(201);
    await run(new Date());
    const mail = email.to(CLIENT).find((m) => /^Payment received/.test(m.subject))!;
    expect(mail).toBeDefined();
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]!.filename).toMatch(/\.pdf$/);
    expect(pdfMagic(mail.attachments![0]!.content)).toBe(true);
  });

  it('the notifications row stores refs, not bytes', async () => {
    const { run, instalmentInvoice } = await setup();
    const inv = await instalmentInvoice();
    await run(new Date());
    const row = (await pool.query(`SELECT attachments, cc FROM notifications WHERE notification_type = 'invoice_issued'`)).rows[0];
    expect(row.attachments).toEqual([{ kind: 'invoice_pdf', invoiceId: inv.id }]);
    expect(JSON.stringify(row.attachments)).not.toMatch(/content|base64/);
  });

  it('staff notifications never get client CCs or attachments', async () => {
    const { clientId, run, instalmentInvoice } = await setup();
    await pool.query(`UPDATE clients SET cc_emails = $2 WHERE id = $1`, [clientId, ['boss@client.test']]);
    await instalmentInvoice();
    await run(new Date());
    const rows = (await pool.query(`SELECT cc, attachments FROM notifications WHERE recipient_type = 'user'`)).rows;
    for (const r of rows) {
      expect(r.cc).toEqual([]);
      expect(r.attachments).toEqual([]);
    }
  });

  it('if the PDF cannot be produced, the email is not sent without it: it fails through the retry path with a clear error', async () => {
    const { fin, firm, run, email, instalmentInvoice } = await setup();
    const inv = await instalmentInvoice({ sendToClient: false });
    const start = await post(fin, `/invoices/${inv.id}/signed-document/uploads`);
    storage.putDirect(`incoming/signed/${firm.orgId}/${inv.id}/${start.body.data.uploadId}`, SIGNED);
    expect((await post(fin, `/invoices/${inv.id}/signed-document/uploads/${start.body.data.uploadId}/complete`)).status).toBe(200);
    // Storage fails when the signed file is read at send time.
    const read = vi.spyOn(storage, 'readObject').mockRejectedValue(new Error('storage unavailable'));
    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(email.sent).toHaveLength(0);
    const n = (await pool.query(`SELECT status, failure_reason, attempts FROM notifications WHERE notification_type = 'invoice_issued'`)).rows[0];
    expect(n.status).toBe('queued');
    expect(n.attempts).toBe(1);
    expect(n.failure_reason).toContain('Could not attach invoice PDF');
    expect(n.failure_reason).toContain('storage unavailable');
    read.mockRestore();
  });

  it('a signed PDF whose storage object is missing is never replaced by the unsigned PDF', async () => {
    const { fin, firm, run, email, instalmentInvoice } = await setup();
    const inv = await instalmentInvoice({ sendToClient: false });
    const start = await post(fin, `/invoices/${inv.id}/signed-document/uploads`);
    storage.putDirect(`incoming/signed/${firm.orgId}/${inv.id}/${start.body.data.uploadId}`, SIGNED);
    expect((await post(fin, `/invoices/${inv.id}/signed-document/uploads/${start.body.data.uploadId}/complete`)).status).toBe(200);
    for (const k of [...storage.data.keys()]) if (k.startsWith(`signed/${firm.orgId}/`)) storage.data.delete(k);
    expect((await post(fin, `/invoices/${inv.id}/send`)).status).toBe(200);
    await run(new Date());
    expect(email.sent).toHaveLength(0);
    const n = (await pool.query(`SELECT status, failure_reason, attempts FROM notifications WHERE notification_type = 'invoice_issued'`)).rows[0];
    expect(n.status).toBe('queued');
    expect(n.attempts).toBe(1);
    expect(n.failure_reason).toContain('signed PDF');
  });
});

describe('payment terms in the invoice email', () => {
  it('instalment invoice: subject carries the first instalment, body has the schedule table and "Due now"', async () => {
    const { run, dates, instalmentInvoice, invoiceEmails } = await setup();
    await instalmentInvoice();
    await run(new Date());
    const mail = invoiceEmails()[0]!;
    expect(mail.subject).toContain('10,000.00');
    expect(mail.subject).toContain(new Date(`${dates[0]}T00:00:00Z`).getUTCFullYear().toString());
    expect(mail.html).toContain('<thead'); // the schedule table (the email layout has its own layout tables)
    expect((/<tbody>(.*?)<\/tbody>/s.exec(mail.html)![1]!.match(/<tr>/g) ?? []).length).toBe(3);
    expect(mail.html).toContain('Due now');
    expect(mail.html).toContain('payable in 3 instalments');
    expect((mail.text.match(/10,000\.00/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The pay link line does not restate the amount.
    expect(mail.html).toContain('(instalment 1 of 3)');
  });

  it('simple invoice: "Due by", no table', async () => {
    const s = await setup();
    const fin = s.fin;
    const draft = await post(fin, '/invoices', { matterId: s.main.matterId, dueDate: addDays(s.today, 15), items: [{ description: 'Fees', unitPrice: '5000' }] });
    expect(draft.status).toBe(201);
    expect((await post(fin, `/invoices/${draft.body.data.id}/issue`, {})).status).toBe(200);
    await s.run(new Date());
    const mail = s.invoiceEmails()[0]!;
    expect(mail.html).toContain('Due by');
    expect(mail.html).not.toContain('<thead');
    expect(mail.subject).toMatch(/5,000\.00 due /);
  });

  it('payment_terms_html is built from escaped values only', async () => {
    const { buildContext } = await import('../src/modules/notifications/context.js');
    const { instalmentInvoice } = await setup();
    const inv = await instalmentInvoice();
    const orgId = (await pool.query(`SELECT organization_id FROM invoices WHERE id = $1`, [inv.id])).rows[0].organization_id as string;
    const ctx = await buildContext(pool as never, orgId, { invoiceId: inv.id }, new Date(), 'https://app.test');
    const html = ctx.vars.invoice!.payment_terms_html as string;
    expect(html).not.toMatch(/<script|onerror|javascript:/i);
    expect(html.replace(/<\/?(p|br|strong|table|thead|tbody|tr|th|td)\b[^>]*>/g, '')).not.toMatch(/[<>]/);
  });
});

describe('credit notes count towards instalments (F1)', () => {
  /** ₹90,000 in three ₹30,000 instalments, issued and sent. */
  const bigInvoice = async (s: Awaited<ReturnType<typeof setup>>) => {
    const draft = await post(s.fin, '/invoices', {
      matterId: s.main.matterId,
      items: [{ description: 'Professional fees', unitPrice: '90000' }],
      instalments: ['30000', '30000', '30000'].map((amount, i) => ({ amount, dueDate: s.dates[i] })),
    });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    const issued = await post(s.fin, `/invoices/${draft.body.data.id}/issue`, {});
    if (issued.status !== 200) throw new Error(JSON.stringify(issued.body));
    return issued.body.data as { id: string; instalments: { id: string; seq: number }[] };
  };
  const credit = (s: Awaited<ReturnType<typeof setup>>, invoiceId: string, amount: string) =>
    post(s.fin, `/invoices/${invoiceId}/credit-notes`, { amount, reason: 'Fee reduced' });

  it('pay #1, credit 30k → #2 covered (remaining 0), #3 still 30k; only #3 gets a link email, for 30k', async () => {
    const s = await setup();
    const inv = await bigInvoice(s);
    await s.run(new Date());
    expect((await s.pay(inv.id, '30000')).status).toBe(201);
    expect((await credit(s, inv.id, '30000')).status).toBe(200);
    await s.run(new Date());

    const got = await s.fin.agent.get(`/api/v1/invoices/${inv.id}`);
    expect(got.body.data.instalments.map((i: { seq: number; remaining: string; status: string }) => [i.seq, i.remaining, i.status])).toEqual([
      [1, '0.00', 'paid'],
      [2, '0.00', 'paid'],
      [3, '30000.00', 'due'],
    ]);

    await s.run(ist(addDays(s.dates[1]!, -3), '10:00'));
    expect(s.linkEmails()).toHaveLength(0);
    const [a2] = (await actionsFor('instalment_link_3d')).filter((a) => a.target_id === inv.instalments[1]!.id);
    expect(a2).toMatchObject({ status: 'skipped' });

    await s.run(ist(addDays(s.dates[2]!, -3), '10:00'));
    expect(s.linkEmails()).toHaveLength(1);
    expect(s.linkEmails()[0]!.subject).toContain('Instalment 3 of 3');
    const links = (await pool.query(`SELECT amount::text FROM payment_links WHERE status = 'active' AND instalment_id = $1`, [inv.instalments[2]!.id])).rows;
    expect(links).toEqual([{ amount: '30000.00' }]);
    // No link was ever opened for the credited instalment #2.
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment_links WHERE instalment_id = $1`, [inv.instalments[1]!.id])).rows[0].n).toBe(0);
  });

  it('a fully credited instalment invoice sends no instalment emails or reminders', async () => {
    const s = await setup();
    const inv = await bigInvoice(s);
    await s.run(new Date());
    expect((await credit(s, inv.id, '90000')).status).toBe(200);
    s.email.sent.length = 0;
    const createsBefore = zoho.calls.filter((c) => c.method === 'POST' && /paymentlinks\?/.test(c.url)).length;
    for (const d of s.dates) {
      await s.run(ist(addDays(d, -3), '10:00'));
      await s.run(ist(d, '10:05'));
      await s.run(ist(addDays(d, 3), '10:05'));
    }
    expect(s.linkEmails()).toHaveLength(0);
    expect(s.reminders()).toHaveLength(0);
    expect(zoho.calls.filter((c) => c.method === 'POST' && /paymentlinks\?/.test(c.url)).length).toBe(createsBefore);
    void inv;
  });
});

describe('void and write-off withdraw open payment links (F3)', () => {
  const openLinks = async (s: Awaited<ReturnType<typeof setup>>, inv: { id: string; instalments: { id: string }[] }) => {
    await s.run(new Date()); // invoice email → link for #1
    await ensureInstalmentLink(s.deps, s.firm.orgId, inv.instalments[1]!.id, s.uid('finance@a.test'));
    const active = async () => (await pool.query(`SELECT count(*)::int AS n FROM payment_links WHERE invoice_id = $1 AND status = 'active'`, [inv.id])).rows[0].n as number;
    expect(await active()).toBe(2);
    return active;
  };
  const cancels = () => zoho.calls.filter((c) => c.url.includes('/cancel')).length;

  it('void cancels every active link of the invoice at Zoho after commit', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    const active = await openLinks(s, inv);
    const res = await post(s.fin, `/invoices/${inv.id}/void`, { reason: 'Raised in error' });
    expect(res.status).toBe(200);
    expect(await active()).toBe(0);
    expect(cancels()).toBe(2);
  });

  it('write-off cancels every active link; a Zoho failure is logged, not thrown', async () => {
    const s = await setup();
    const inv = await s.instalmentInvoice();
    const active = await openLinks(s, inv);
    zoho.state.failCancel = true;
    const res = await post(s.fin, `/invoices/${inv.id}/write-off`, { reason: 'Client insolvent' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('written_off');
    expect(await active()).toBe(2);

    const inv2 = await s.instalmentInvoice();
    zoho.state.failCancel = false;
    const active2 = await openLinks(s, inv2);
    const before = cancels();
    expect((await post(s.fin, `/invoices/${inv2.id}/write-off`, { reason: 'Client insolvent' })).status).toBe(200);
    expect(await active2()).toBe(0);
    expect(cancels() - before).toBe(2);
  });
});

describe('sender display name (K2)', () => {
  it('client emails go out as "{firm} via LexForgeX"; staff emails keep the default sender', async () => {
    const s = await setup();
    await pool.query(`UPDATE organizations SET name = $2 WHERE id = $1`, [s.firm.orgId, 'Shah & "Partners", Advocates']);
    await s.instalmentInvoice();
    await s.run(new Date());
    const client = s.invoiceEmails()[0]!;
    expect(client.fromName).toBe('Shah & "Partners", Advocates via LexForgeX');
    const staff = s.email.sent.filter((m) => m.to !== CLIENT);
    for (const m of staff) expect(m.fromName ?? null).toBeNull();
  });
});
