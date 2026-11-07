import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signZohoWebhook } from '../src/integrations/zohopay/signature.js';
import { importVidhimeya } from '../src/scripts/vidhimeya/import.js';
import { tick } from '../src/modules/workflows/processor.js';
import { buildApp, createFirm, deps, loginAs, pool, type Session, storage, useDatabase } from './helpers.js';
import { createPlatformAdmin, platformLogin } from './platform-helpers.js';

useDatabase();
const app = buildApp();

const EXPORT = fileURLToPath(new URL('./fixtures/vidhimeya-export.sql', import.meta.url));
const OWNER = 'alokchauhan@vidhimeyaadvisory.com';
const PARTNER = 'shweta@vidhimeyaadvisory.com';
/** A fixed firm-local noon: every 10:00 reminder of "today" is already stale, nothing else is due yet. */
const NOW = new Date('2026-11-06T12:00:00+05:30');

const post = (s: Session, path: string, body: object = {}) =>
  s.agent.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  ),
);
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const firm = await createFirm('Vidhimeya Corporate Advisory LLP', [
    { email: OWNER, role: 'owner' },
    { email: PARTNER, role: 'lawyer' },
  ]);
  const ownerUserId = firm.users[OWNER]!.userId;
  const existing = await pool.query<{ id: string }>(
    `INSERT INTO clients (organization_id, name, email) VALUES ($1, 'Acme Private Limited', 'accounts@acme.test') RETURNING id`,
    [firm.orgId],
  );
  const run = (dryRun = false) =>
    importVidhimeya(deps, { exportPath: EXPORT, organizationId: firm.orgId, ownerUserId, dryRun });
  return { firm, ownerUserId, acmeId: existing.rows[0]!.id, run };
}

const TABLES = [
  'clients',
  'matters',
  'matter_staff',
  'invoices',
  'invoice_items',
  'invoice_instalments',
  'payments',
  'payment_allocations',
  'payment_links',
  'ledger_entries',
  'timeline_events',
  'outbox_events',
  'notifications',
  'document_sequences',
  'invoice_signed_documents',
  'audit_logs',
];

async function snapshot(orgId: string) {
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  const org = (
    await pool.query(`SELECT invoice_prefix, invoice_number_digits FROM organizations WHERE id = $1`, [orgId])
  ).rows[0];
  const members = (
    await pool.query(
      `SELECT designation, signature_key FROM organization_members WHERE organization_id = $1 ORDER BY id`,
      [orgId],
    )
  ).rows;
  return { counts, org, members, stored: storage.data.size };
}

const invoiceByNumber = async (n: string) =>
  (
    await pool.query(
      `SELECT i.*, i.total_amount::text AS total, i.issue_date::text AS issue, i.due_date::text AS due, m.title AS matter_title
       FROM invoices i JOIN matters m ON m.id = i.matter_id WHERE i.invoice_number = $1`,
      [n],
    )
  ).rows[0];

describe('Vidhimeya importer', () => {
  it('dry run returns ok=true and writes nothing', async () => {
    const { firm, run } = await setup();
    const before = await snapshot(firm.orgId);
    const report = await run(true);
    expect(report.ok).toBe(true);
    expect(report.prefixes).toEqual(['VA', 'VMA']);
    expect(report.clients).toEqual({ created: 2, matched: 1 });
    expect(report.invoices).toEqual({ issued: 5, void: 2, draft: 1 });
    expect(report.perClient.every((c) => c.ok)).toBe(true);
    expect(report.counterGaps).toEqual([]);
    expect(await snapshot(firm.orgId)).toEqual(before);
  });

  it('real run: per-client invoiced/paid/due equal old; old numbers kept; next issued invoice continues e.g. VMA/2026-27/008', async () => {
    const { firm, acmeId, run } = await setup();
    const report = await run();
    expect(report.ok).toBe(true);
    const byName = Object.fromEntries(report.perClient.map((c) => [c.name, c]));
    expect(byName['Acme Private Limited']).toMatchObject({
      invoiced: '145000.00',
      paid: '50000.00',
      due: '95000.00',
      oldInvoiced: '145000.00',
      oldPaid: '50000.00',
      oldDue: '95000.00',
      ok: true,
    });
    expect(byName['Priya Nair']).toMatchObject({
      invoiced: '80000.00',
      paid: '65000.00',
      due: '15000.00',
      ok: true,
    });
    expect(byName['Zenith Holdings']).toMatchObject({
      invoiced: '90000.00',
      paid: '30000.00',
      due: '60000.00',
      ok: true,
    });

    // Numbers verbatim, continuation set up on the latest prefix with 3 digits.
    const numbers = (
      await pool.query(`SELECT invoice_number FROM invoices ORDER BY invoice_number`)
    ).rows.map((r) => r.invoice_number);
    expect(numbers).toEqual(['VA/2025-26/012', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `VMA/2026-27/00${n}`)]);
    expect(
      (
        await pool.query(`SELECT invoice_prefix, invoice_number_digits FROM organizations WHERE id = $1`, [
          firm.orgId,
        ])
      ).rows[0],
    ).toEqual({
      invoice_prefix: 'VMA',
      invoice_number_digits: 3,
    });

    // The matched client keeps its id and gains the old greeting fields; the honorific maps to the salutation enum.
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM clients WHERE organization_id = $1`, [firm.orgId]))
        .rows[0].n,
    ).toBe(3);
    const acme = (
      await pool.query(`SELECT salutation, title, contact_person, cc_emails FROM clients WHERE id = $1`, [
        acmeId,
      ])
    ).rows[0];
    expect(acme).toEqual({
      salutation: 'Mr',
      title: null,
      contact_person: 'Rohan Mehta',
      cc_emails: ['cfo@acme.test', 'legal@acme.test'],
    });
    const priya = (await pool.query(`SELECT salutation, notes FROM clients WHERE name = 'Priya Nair'`))
      .rows[0];
    expect(priya).toEqual({ salutation: 'Dr', notes: 'Refers other founders' });
    expect(report.unmappedTitles).toEqual(['Sir']);
    expect(report.droppedGreetingWords).toEqual({ Respected: 1, Dear: 1, Hello: 1 });

    // Matters: one per client per subject; no subject -> "Advisory: {client}"; the owner leads.
    expect((await invoiceByNumber('VA/2025-26/012')).matter_id).toBe(
      (await invoiceByNumber('VMA/2026-27/003')).matter_id,
    );
    expect((await invoiceByNumber('VMA/2026-27/002')).matter_title).toBe('Advisory: Acme Private Limited');
    const leads = (
      await pool.query(`SELECT count(*)::int AS n FROM matter_staff WHERE role = 'lead' AND user_id = $1`, [
        firm.users[OWNER]!.userId,
      ])
    ).rows[0].n;
    expect(leads).toBe((await pool.query(`SELECT count(*)::int AS n FROM matters`)).rows[0].n);

    // Receipts in paid_on order, per financial year.
    const receipts = (
      await pool.query(`SELECT receipt_number, payment_date::text AS d FROM payments ORDER BY payment_date`)
    ).rows;
    expect(receipts.map((r) => r.receipt_number)).toEqual([
      'RCPT/2025-26/000001',
      ...[1, 2, 3, 4, 5].map((n) => `RCPT/2026-27/00000${n}`),
    ]);

    // Ledger: receivable per client equals what is due.
    const ar = (
      await pool.query(
        `SELECT c.name, (SUM(CASE WHEN l.debit_account = 'accounts_receivable' THEN l.amount ELSE 0 END)
                       - SUM(CASE WHEN l.credit_account = 'accounts_receivable' THEN l.amount ELSE 0 END))::text AS ar
         FROM ledger_entries l JOIN clients c ON c.id = l.client_id GROUP BY c.name ORDER BY c.name`,
      )
    ).rows;
    expect(ar).toEqual([
      { name: 'Acme Private Limited', ar: '95000.00' },
      { name: 'Priya Nair', ar: '15000.00' },
      { name: 'Zenith Holdings', ar: '60000.00' },
    ]);

    // Signatories: member designation + signature copied; invoice snapshot points at the copied image; the rest reported.
    const alok = (
      await pool.query(
        `SELECT designation, signature_key, signature_type FROM organization_members WHERE user_id = $1`,
        [firm.users[OWNER]!.userId],
      )
    ).rows[0];
    expect(alok.designation).toBe('Managing Partner');
    expect(alok.signature_type).toBe('png');
    expect(storage.data.get(alok.signature_key)?.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    const inv1 = await invoiceByNumber('VMA/2026-27/001');
    expect(inv1).toMatchObject({
      status: 'issued',
      sign_with_image: true,
      signatory_signature_key: alok.signature_key,
      signatory_name: 'Alok Chauhan',
      revision: 1,
    });
    expect(inv1.sent_at).toBeTruthy();
    expect(report.unmatchedSignatories.sort()).toEqual([
      'prashast@vidhimeyaadvisory.com',
      'shane@vidhimeyaadvisory.com',
    ]);
    const signed = (
      await pool.query(
        `SELECT storage_key, revision, size_bytes::int AS size FROM invoice_signed_documents WHERE invoice_id = $1`,
        [inv1.id],
      )
    ).rows;
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({ revision: 1, size: 126 });
    expect(storage.data.get(signed[0].storage_key)?.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Email log -> matter timeline.
    const emails = (
      await pool.query(
        `SELECT title FROM timeline_events WHERE event_type = 'email.imported' ORDER BY created_at`,
      )
    ).rows.map((r) => r.title);
    expect(emails[0]).toBe(
      'Email sent (previous app): Invoice VMA/2026-27/001 from Vidhimeya to Accounts@Acme.test',
    );
    expect(emails).toHaveLength(3);

    // The next invoice continues the old series.
    const owner = await loginAs(app, OWNER);
    const matterId = (await invoiceByNumber('VMA/2026-27/007')).matter_id;
    const next = await post(owner, '/invoices', {
      matterId,
      items: [{ description: 'Retainer, November', unitPrice: '30000' }],
      issueDate: '2026-11-01',
      issue: true,
    });
    expect(next.status).toBe(201);
    expect(next.body.data.invoiceNumber).toBe('VMA/2026-27/008');
  });

  it('one-instalment invoice has no instalment rows; 3-instalment keeps 3', async () => {
    const { run } = await setup();
    await run();
    const single = await invoiceByNumber('VMA/2026-27/002');
    expect(single.due).toBe('2026-05-25');
    expect(
      (
        await pool.query(`SELECT count(*)::int AS n FROM invoice_instalments WHERE invoice_id = $1`, [
          single.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const multi = await invoiceByNumber('VMA/2026-27/001');
    const rows = (
      await pool.query(
        `SELECT seq, amount::text, due_date::text AS due, emailed_at IS NOT NULL AS emailed FROM invoice_instalments WHERE invoice_id = $1 ORDER BY seq`,
        [multi.id],
      )
    ).rows;
    expect(rows).toEqual([
      { seq: 1, amount: '40000.00', due: '2026-05-05', emailed: true },
      { seq: 2, amount: '40000.00', due: '2026-12-05', emailed: false },
      { seq: 3, amount: '40000.00', due: '2027-01-05', emailed: false },
    ]);
    expect(multi.due).toBe('2027-01-05');
  });

  it("cancelled → void; pre-numbered draft can't be deleted (409) and keeps its number on issue", async () => {
    const { run } = await setup();
    await run();
    for (const n of ['VMA/2026-27/003', 'VMA/2026-27/006']) {
      expect(await invoiceByNumber(n)).toMatchObject({
        status: 'void',
        void_reason: 'Cancelled in previous invoicing app',
      });
    }
    const draft = await invoiceByNumber('VMA/2026-27/005');
    expect(draft).toMatchObject({ status: 'draft', prenumbered: true, due: '2026-12-15' });

    const owner = await loginAs(app, OWNER);
    const del = await owner.agent.delete(`/api/v1/invoices/${draft.id}`).set('X-CSRF-Token', owner.csrf);
    expect(del.status).toBe(409);
    const issued = await post(owner, `/invoices/${draft.id}/issue`, { sendToClient: false });
    expect(issued.status).toBe(200);
    expect(issued.body.data.invoiceNumber).toBe('VMA/2026-27/005');
    // Issuing it drew nothing from the sequence: the next number is still 008.
    const next = await post(owner, '/invoices', {
      matterId: draft.matter_id,
      items: [{ description: 'Follow-up', unitPrice: '1000' }],
      issueDate: '2026-11-02',
      issue: true,
    });
    expect(next.body.data.invoiceNumber).toBe('VMA/2026-27/008');
  });

  it('a pre-numbered draft can be voided instead, without ledger entries, and refuses an issue date outside its FY', async () => {
    const { run } = await setup();
    await run();
    const draft = await invoiceByNumber('VMA/2026-27/005');
    const owner = await loginAs(app, OWNER);
    const wrongFy = await post(owner, `/invoices/${draft.id}/issue`, {
      issueDate: '2027-04-02',
      sendToClient: false,
    });
    expect(wrongFy.status).toBe(422);
    // A draft's dates may have been moved since the import; the voided row still belongs to its number's FY.
    await pool.query(`UPDATE invoices SET issue_date = '2027-05-01', due_date = '2027-05-10' WHERE id = $1`, [
      draft.id,
    ]);
    const voided = await post(owner, `/invoices/${draft.id}/void`, { reason: 'Not needed' });
    expect(voided.status).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'void', invoiceNumber: 'VMA/2026-27/005' });
    expect(
      (await pool.query(`SELECT fiscal_year FROM invoices WHERE id = $1`, [draft.id])).rows[0].fiscal_year,
    ).toBe('2026-27');
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE invoice_id = $1`, [draft.id]))
        .rows[0].n,
    ).toBe(0);
  });

  it('zoho payment has provider_payment_id; replaying the webhook for that link does not create a second payment', async () => {
    const { firm, run } = await setup();
    await run();
    const zoho = (
      await pool.query(
        `SELECT id, payment_method, provider, provider_payment_id FROM payments WHERE provider IS NOT NULL ORDER BY payment_date`,
      )
    ).rows;
    expect(zoho.map(({ id: _id, ...r }) => r)).toEqual([
      { payment_method: 'other', provider: 'zohopay', provider_payment_id: 'ZP-1001' },
      { payment_method: 'other', provider: 'zohopay', provider_payment_id: 'ZP-1006' },
    ]);
    const links = (
      await pool.query(
        `SELECT l.provider_link_id, l.status, l.amount::text, l.payment_id, ii.seq FROM payment_links l
         LEFT JOIN invoice_instalments ii ON ii.id = l.instalment_id ORDER BY l.provider_link_id`,
      )
    ).rows;
    expect(links).toEqual([
      { provider_link_id: 'ZL-1', status: 'paid', amount: '40000.00', payment_id: zoho[0].id, seq: 1 },
      { provider_link_id: 'ZL-2', status: 'active', amount: '40000.00', payment_id: null, seq: 2 },
      { provider_link_id: 'ZL-3', status: 'paid', amount: '10000.00', payment_id: zoho[1].id, seq: null },
      { provider_link_id: 'ZL-4', status: 'active', amount: '15000.00', payment_id: null, seq: null },
    ]);
    // A paid link is dated by the old payment's paid_on (firm-local midnight), not when the row was recorded.
    const paidAt = (
      await pool.query(
        `SELECT provider_link_id, (paid_at AT TIME ZONE 'Asia/Kolkata')::text AS at FROM payment_links WHERE status = 'paid' ORDER BY provider_link_id`,
      )
    ).rows;
    expect(paidAt).toEqual([
      { provider_link_id: 'ZL-1', at: '2026-05-03 00:00:00' },
      { provider_link_id: 'ZL-3', at: '2026-10-15 00:00:00' },
    ]);

    // Zoho re-delivers the old link's "paid" event to LexForgeX after cutover.
    const SIGNING_KEY = 'whsec-test-signing-key-0123456789abcdef';
    const { secret } = await createPlatformAdmin('ops@lfx.test');
    const ops = await platformLogin(app, 'ops@lfx.test', secret);
    const cfg = await ops.agent
      .patch(`/api/v1/platform/firms/${firm.orgId}/zohopay`)
      .set('X-CSRF-Token', ops.csrf)
      .send({
        environment: 'live',
        accountId: '105078477',
        clientId: '1000.CLIENTIDEXAMPLE',
        clientSecret: 'client-secret-value-123',
        refreshToken: '1000.refresh.token-value-456',
        signingKey: SIGNING_KEY,
        enabled: true,
      });
    expect(cfg.status).toBe(200);
    const body = JSON.stringify({
      event_id: 9001,
      event_type: 'payment_link.paid',
      account_id: 105078477,
      live_mode: true,
      event_object: {
        payment_links: {
          payment_link_id: 'ZL-1',
          amount_paid: '40000.00',
          payments: [{ payment_id: 'ZP-1001', type: 'upi', status: 'succeeded', date: 1777777777 }],
        },
      },
    });
    const res = await request(app)
      .post(`/api/v1/webhooks/zohopay/${firm.orgId}`)
      .set('Content-Type', 'application/json')
      .set('X-Zoho-Webhook-Signature', signZohoWebhook(body, SIGNING_KEY))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Link already paid');
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(6);
  });

  it('out-of-order payment listed in report.outOfOrderInvoices', async () => {
    const { run } = await setup();
    const report = await run(true);
    expect(report.outOfOrderInvoices).toEqual(['VMA/2026-27/004']);
  });

  it('old numbering counter above the highest imported number is reported as a gap', async () => {
    const { firm, ownerUserId } = await setup();
    const dir = mkdtempSync(join(tmpdir(), 'vidhimeya-'));
    const exportPath = join(dir, 'export.sql');
    writeFileSync(
      exportPath,
      `${readFileSync(EXPORT, 'utf8')}\nUPDATE settings SET value = '9' WHERE key = 'seq:VMA:2026-27';\n`,
    );
    try {
      const report = await importVidhimeya(deps, {
        exportPath,
        organizationId: firm.orgId,
        ownerUserId,
        dryRun: true,
      });
      expect(report.counterGaps).toEqual([
        { prefix: 'VMA', fiscalYear: '2026-27', counter: 9, maxImported: 7 },
      ]);
      expect(report.warnings.some((w) => w.includes('numbers 8–9 are missing'))).toBe(true);
      // Reported, not acted on: the series still continues from the highest imported number.
      expect(report.sequences).toEqual({ '2026-27': 8 });
      expect(report.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no emails queued by the import', async () => {
    const { run } = await setup();
    const before = (await pool.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n;
    await run();
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n).toBe(before);
    // The worker plans the open invoices' reminders: only future ones, and no immediate "invoice issued" email.
    // The test clock is fixed (the fixture's dates are), so the events are made available as of that clock.
    await pool.query(`UPDATE outbox_events SET available_at = $1`, [NOW]);
    await tick(deps, NOW);
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n).toBe(before);
    const planned = (await pool.query(`SELECT run_at FROM scheduled_actions`)).rows as { run_at: Date }[];
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((p) => p.run_at.getTime() > NOW.getTime())).toBe(true);
  });

  it('second run on the same org refuses and writes nothing', async () => {
    const { firm, run } = await setup();
    await run();
    const before = await snapshot(firm.orgId);
    await expect(run()).rejects.toThrow(/already has issued invoices or payments/);
    await expect(run(true)).rejects.toThrow(/already has issued invoices or payments/);
    expect(await snapshot(firm.orgId)).toEqual(before);
  });
});
