/**
 * One-off import of the Vidhimeya firm's data from the old invoicing app (Cloudflare D1 export) into LexForgeX.
 * Spec: docs/superpowers/specs/2026-11-06-billing-vidhimeya-parity-design.md §10.
 *
 * Everything is written in ONE transaction. A dry run, or a real run whose verification fails, rolls back; files
 * (signature images, signed PDFs) are only uploaded once the checks pass, right before COMMIT.
 * Imported invoices are written as issued/void/draft directly (issuing would draw new numbers) and the ledger is
 * posted explicitly, the same entries issue and payment post. No INVOICE_CREATED/PAYMENT_RECEIVED events are emitted
 * for history, so no email goes out; the last step emits one INVOICE_CREATED (`imported: true`) per open invoice so the
 * engine plans its future reminders and instalment links only (immediate workflows are skipped for imported events).
 */
import { LOGO_TYPES, MAX_SIGNATURE_BYTES } from '@legalops/types';
import { fiscalYear, fromPaise } from '@legalops/validation';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { postLedger } from '../../modules/billing/ledger.js';
import { nextDocumentNumber, RECEIPT_PREFIX } from '../../modules/billing/numbering.js';
import { signedKey } from '../../modules/billing/signed-documents.service.js';
import { detectType } from '../../modules/organizations/logo.service.js';
import { signatureKey } from '../../modules/organizations/signature.service.js';
import { emitEvent } from '../../modules/outbox/outbox.service.js';
import { mapHonorific, mapMethod, matterTitle, paidOutOfOrder, parseNumber, splitCc } from './map.js';
import { readExport, type OldData, type OldInvoice } from './read-export.js';
import { verify, type ImportReport } from './report.js';

export type { ImportReport } from './report.js';

export type ImportOptions = {
  exportPath: string;
  organizationId: string;
  ownerUserId: string;
  dryRun: boolean;
  /** Zoho environment the old links live in. Vidhimeya ran live. */
  linkEnvironment?: 'live' | 'sandbox';
};

export const VOID_REASON = 'Cancelled in previous invoicing app';
const IMPORT_NOTE = 'Imported from the previous invoicing app';

type Upload = { key: string; bytes: Buffer; contentType: string };
type NewInvoice = {
  id: string;
  clientId: string;
  matterId: string;
  status: 'issued' | 'void' | 'draft';
  number: string | null;
  dueDate: string;
  totalPaise: number;
  sent: boolean;
};

export class ImportRefused extends Error {}

export async function importVidhimeya(
  deps: Pick<Deps, 'pool' | 'storage'>,
  opts: ImportOptions,
): Promise<ImportReport> {
  const old = readExport(opts.exportPath);
  const tx = await deps.pool.connect();
  try {
    await tx.query('BEGIN');
    const { report, uploads } = await run(tx, old, opts);
    if (opts.dryRun || !report.ok) {
      await tx.query('ROLLBACK');
      return { ...report, committed: false };
    }
    for (const u of uploads) await deps.storage.putObject(u.key, u.bytes, u.contentType);
    await tx.query('COMMIT');
    return { ...report, committed: true };
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

async function run(
  tx: PoolClient,
  old: OldData,
  opts: ImportOptions,
): Promise<{ report: ImportReport; uploads: Uploads }> {
  const org = opts.organizationId;
  const owner = opts.ownerUserId;
  const warnings: string[] = [];
  const uploads: Upload[] = [];

  // ---- Safety: one firm, locked; an owner who is an active member; nothing billed yet ----
  const firm = await queryOne<{ id: string }>(
    tx,
    sql`SELECT id FROM organizations WHERE id = ${org} FOR UPDATE`,
  );
  if (!firm) throw new ImportRefused(`No firm with id ${org}`);
  const ownerOk = await queryOne(
    tx,
    sql`SELECT 1 FROM organization_members WHERE organization_id = ${org} AND user_id = ${owner} AND status = 'active'`,
  );
  if (!ownerOk) throw new ImportRefused('The owner must be an active member of the firm');
  const billed = await queryOne<{ n: number }>(
    tx,
    sql`SELECT ((SELECT count(*) FROM invoices WHERE organization_id = ${org} AND (status <> 'draft' OR prenumbered))
              + (SELECT count(*) FROM payments WHERE organization_id = ${org}))::int AS n`,
  );
  if (billed!.n > 0)
    throw new ImportRefused(
      'This firm already has issued invoices or payments in LexForgeX (or was imported before); refusing to import',
    );

  const members = await query<{ user_id: string; email: string; id: string }>(
    tx,
    sql`SELECT m.user_id, lower(u.email::text) AS email, m.id FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${org} AND m.status = 'active'`,
  );
  const memberByEmail = new Map(members.map((m) => [m.email, m]));
  const userOf = (email: string | null | undefined) =>
    email ? (memberByEmail.get(email.trim().toLowerCase())?.user_id ?? null) : null;

  // ---- Signatories: designation and scanned signature onto the member; non-members are reported ----
  const flaggedSigners = new Set(
    old.invoices.filter((i) => i.sign_with_image).map((i) => i.signatory_email?.toLowerCase()),
  );
  const signatureKeyByEmail = new Map<string, string>();
  const unmatchedSignatories: string[] = [];
  for (const u of old.users) {
    const email = u.email.toLowerCase();
    const member = memberByEmail.get(email);
    let key: string | null = null;
    let ext: string | null = null;
    if (u.signature && (member || flaggedSigners.has(email))) {
      const type = detectType(u.signature);
      if (!type || u.signature.length > MAX_SIGNATURE_BYTES)
        warnings.push(`Signature of ${u.email} is not a PNG/JPG up to 500 KB; not copied`);
      else {
        ext = LOGO_TYPES[type];
        key = member
          ? signatureKey(org, member.user_id, randomUUID(), ext)
          : `signatures/${org}/imported/${randomUUID()}.${ext}`;
        uploads.push({ key, bytes: u.signature, contentType: type });
        signatureKeyByEmail.set(email, key);
      }
    }
    if (member) {
      await query(
        tx,
        sql`UPDATE organization_members SET designation = ${u.designation.slice(0, 120)}
              ${key ? sql`, signature_key = ${key}, signature_type = ${ext}` : sql.empty}
            WHERE id = ${member.id}`,
      );
    } else unmatchedSignatories.push(u.email);
  }

  // ---- Clients: match by email (case-insensitive), else create ----
  const clientIdByOld = new Map<number, string>();
  const clientName = new Map<string, string>();
  const unmappedTitles: string[] = [];
  const droppedGreetingWords: Record<string, number> = {};
  let created = 0;
  let matched = 0;
  for (const c of old.clients) {
    const { salutation, unmapped } = mapHonorific(c.title);
    if (unmapped && !unmappedTitles.includes(unmapped)) unmappedTitles.push(unmapped);
    const greeting = c.salutation?.trim();
    if (greeting) droppedGreetingWords[greeting] = (droppedGreetingWords[greeting] ?? 0) + 1;
    const cc = splitCc(c.cc_emails);
    if (cc.dropped.length)
      warnings.push(`${c.name}: only 5 CC emails are kept; dropped ${cc.dropped.join(', ')}`);
    const contact = c.contact_person?.trim().slice(0, 255) || null;
    const existing = await query<{ id: string; name: string }>(
      tx,
      sql`SELECT id, name FROM clients WHERE organization_id = ${org} AND email = ${c.email.trim()} AND status <> 'archived' ORDER BY created_at`,
    );
    if (existing.length > 1)
      warnings.push(
        `${c.email} matches ${existing.length} LexForgeX clients; used the oldest (${existing[0]!.name})`,
      );
    if (existing[0]) {
      // Fill what the LexForgeX client doesn't have yet; never overwrite.
      await query(
        tx,
        sql`UPDATE clients SET salutation = COALESCE(salutation, ${salutation}), contact_person = COALESCE(contact_person, ${contact}),
              cc_emails = CASE WHEN cardinality(cc_emails) = 0 THEN ${cc.emails}::text[] ELSE cc_emails END,
              phone = COALESCE(phone, ${c.phone}), address = COALESCE(address, ${c.address}), notes = COALESCE(notes, ${c.notes})
            WHERE id = ${existing[0].id}`,
      );
      clientIdByOld.set(c.id, existing[0].id);
      clientName.set(existing[0].id, existing[0].name);
      matched++;
    } else {
      const row = await queryOne<{ id: string }>(
        tx,
        sql`INSERT INTO clients (organization_id, client_type, name, email, phone, address, notes, salutation, contact_person, cc_emails, created_by)
            VALUES (${org}, ${contact || salutation === 'M/s' ? 'company' : 'person'}, ${c.name.trim().slice(0, 255)}, ${c.email.trim()},
                    ${c.phone}, ${c.address}, ${c.notes}, ${salutation}, ${contact}, ${cc.emails}::text[], ${owner})
            RETURNING id`,
      );
      clientIdByOld.set(c.id, row!.id);
      clientName.set(row!.id, c.name.trim());
      created++;
    }
  }

  // ---- Matters: one per client per subject; the owner leads ----
  const matterIdByKey = new Map<string, string>();
  const matterFor = async (inv: OldInvoice): Promise<string> => {
    const clientId = clientIdByOld.get(inv.client_id)!;
    const title = matterTitle(inv.subject, clientName.get(clientId)!);
    const key = `${clientId}|${title.toLowerCase()}`;
    const hit = matterIdByKey.get(key);
    if (hit) return hit;
    const m = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO matters (organization_id, client_id, title, status, start_date, created_by)
          VALUES (${org}, ${clientId}, ${title}, 'active', ${inv.issue_date}, ${owner}) RETURNING id`,
    );
    await query(
      tx,
      sql`INSERT INTO matter_staff (organization_id, matter_id, user_id, role, added_by) VALUES (${org}, ${m!.id}, ${owner}, 'lead', ${owner})`,
    );
    matterIdByKey.set(key, m!.id);
    return m!.id;
  };

  // ---- Invoices ----
  const invoiceByOld = new Map<number, NewInvoice>();
  const instalmentByOld = new Map<number, string>();
  const counts = { issued: 0, void: 0, draft: 0 };
  const ordered = [...old.invoices].sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id - b.id);
  for (const inv of ordered) {
    if (!clientIdByOld.has(inv.client_id))
      throw new Error(`Invoice ${inv.number ?? inv.id} has an unknown client ${inv.client_id}`);
    if (!inv.number && inv.status !== 'draft') {
      warnings.push(`Old invoice #${inv.id} is ${inv.status} without a number; skipped`);
      continue;
    }
    const status = inv.status === 'sent' ? 'issued' : inv.status === 'cancelled' ? 'void' : 'draft';
    const clientId = clientIdByOld.get(inv.client_id)!;
    const matterId = await matterFor(inv);
    const label = inv.number ?? `draft #${inv.id}`;
    const instalments = old.instalments.filter((s) => s.invoice_id === inv.id).sort((a, b) => a.seq - b.seq);
    const schedSum = instalments.reduce((s, x) => s + x.amount_paise, 0);
    if (instalments.length > 1 && schedSum !== inv.total_paise)
      throw new Error(
        `Invoice ${label}: instalments add up to ${fromPaise(schedSum)}, not the total ${fromPaise(inv.total_paise)}`,
      );
    if (instalments.length > 24)
      warnings.push(
        `Invoice ${label} has ${instalments.length} instalments (LexForgeX allows up to 24 when editing)`,
      );
    let dueDate = instalments.at(-1)?.due_date ?? inv.issue_date;
    if (dueDate < inv.issue_date) {
      warnings.push(`Invoice ${label}: due date ${dueDate} is before the issue date; using the issue date`);
      dueDate = inv.issue_date;
    }
    const signerEmail = inv.signatory_email?.toLowerCase() ?? null;
    const sigKey = inv.sign_with_image && signerEmail ? (signatureKeyByEmail.get(signerEmail) ?? null) : null;
    if (inv.sign_with_image && !sigKey)
      warnings.push(
        `Invoice ${label}: signed with an image, but ${inv.signatory_email} has none; imported without it`,
      );
    const issuedAt = inv.sent_at ?? inv.cancelled_at ?? inv.created_at;
    const actor = userOf(inv.created_by) ?? owner;
    const fy = inv.number ? (parseNumber(inv.number)?.fiscalYear ?? fiscalYear(inv.issue_date)) : null;

    // Written as a draft first so its items and schedule can be added, then moved to its final status.
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO invoices (organization_id, client_id, matter_id, invoice_number, fiscal_year, issue_date, due_date, status, tax_mode,
                                subtotal, total_amount, notes, created_by, created_at, issued_at, issued_by, sent_at,
                                voided_at, voided_by, void_reason,
                                signatory_user_id, signatory_name, signatory_designation, signatory_signature_key, sign_with_image,
                                revision, revised_at, prenumbered)
          VALUES (${org}, ${clientId}, ${matterId}, ${inv.number}, ${status === 'draft' ? null : fy}, ${inv.issue_date}, ${dueDate}, 'draft', 'simple',
                  ${fromPaise(inv.total_paise)}, ${fromPaise(inv.total_paise)}, ${inv.notes}, ${actor}, ${inv.created_at},
                  ${status === 'draft' ? null : issuedAt}, ${status === 'draft' ? null : actor}, ${status === 'draft' ? null : inv.sent_at},
                  ${status === 'void' ? (inv.cancelled_at ?? issuedAt) : null}, ${status === 'void' ? owner : null}, ${status === 'void' ? VOID_REASON : null},
                  ${userOf(signerEmail)}, ${inv.signatory_name?.slice(0, 255) ?? null}, ${inv.signatory_designation?.slice(0, 120) ?? null},
                  ${sigKey}, ${sigKey !== null}, ${inv.revision}, ${inv.revised_at}, ${status === 'draft' && inv.number !== null})
          RETURNING id`,
    );
    const id = row!.id;
    let items = old.items.filter((it) => it.invoice_id === inv.id);
    if (items.length === 0) {
      warnings.push(`Invoice ${label} has no items; imported as one line for the total`);
      items = [
        {
          invoice_id: inv.id,
          position: 1,
          description: inv.subject ?? 'Professional fees',
          amount_paise: inv.total_paise,
        },
      ];
    }
    const itemSum = items.reduce((s, it) => s + it.amount_paise, 0);
    if (itemSum !== inv.total_paise)
      warnings.push(
        `Invoice ${label}: items add up to ${fromPaise(itemSum)}, total is ${fromPaise(inv.total_paise)}`,
      );
    for (const [i, it] of items.entries()) {
      await query(
        tx,
        sql`INSERT INTO invoice_items (organization_id, invoice_id, position, description, quantity, unit_price, amount)
            VALUES (${org}, ${id}, ${i}, ${it.description.slice(0, 500)}, 1, ${fromPaise(it.amount_paise)}, ${fromPaise(it.amount_paise)})`,
      );
    }
    // One old instalment = an ordinary invoice (no rows); 2 or more map one to one.
    if (instalments.length > 1) {
      for (const s of instalments) {
        const ii = await queryOne<{ id: string }>(
          tx,
          sql`INSERT INTO invoice_instalments (organization_id, invoice_id, seq, amount, due_date, emailed_at)
              VALUES (${org}, ${id}, ${s.seq}, ${fromPaise(s.amount_paise)}, ${s.due_date}, ${s.emailed_at}) RETURNING id`,
        );
        instalmentByOld.set(s.id, ii!.id);
      }
    }
    if (status !== 'draft') await query(tx, sql`UPDATE invoices SET status = ${status} WHERE id = ${id}`);

    const base = { matterId, clientId, invoiceId: id };
    if (status !== 'draft')
      await postLedger(tx, org, owner, [
        {
          ...base,
          entryType: 'invoice_issued',
          debit: 'accounts_receivable',
          credit: 'fee_revenue',
          amountPaise: inv.total_paise,
          metadata: { imported: true },
        },
      ]);
    if (status === 'void')
      await postLedger(tx, org, owner, [
        {
          ...base,
          entryType: 'invoice_voided',
          debit: 'fee_revenue',
          credit: 'accounts_receivable',
          amountPaise: inv.total_paise,
          metadata: { imported: true },
        },
      ]);
    counts[status]++;
    invoiceByOld.set(inv.id, {
      id,
      clientId,
      matterId,
      status,
      number: inv.number,
      dueDate,
      totalPaise: inv.total_paise,
      sent: inv.sent_at !== null,
    });
  }

  // ---- Payments: receipts from the LexForgeX series, in paid_on order; one allocation each ----
  const dueLeft = new Map([...invoiceByOld.values()].map((i) => [i.id, i.totalPaise]));
  const paymentByOld = new Map<number, string>();
  const payments = [...old.payments].sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.id - b.id);
  for (const p of payments) {
    const inv = invoiceByOld.get(p.invoice_id);
    if (!inv) {
      warnings.push(`Payment #${p.id} is on a skipped invoice; not imported`);
      continue;
    }
    const { method, provider } = mapMethod(p.method);
    const { number } = await nextDocumentNumber(tx, org, 'receipt', p.paid_on, RECEIPT_PREFIX);
    const recorder = userOf(p.recorded_by) ?? owner;
    const pay = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO payments (organization_id, client_id, matter_id, receipt_number, amount, tds_amount, payment_date, payment_method,
                                reference_number, notes, recorded_by, provider, provider_payment_id, created_at)
          VALUES (${org}, ${inv.clientId}, ${inv.matterId}, ${number}, ${fromPaise(p.amount_paise)}, 0, ${p.paid_on}, ${method},
                  ${p.reference?.slice(0, 255) ?? (provider ? p.zoho_payment_id : null)}, ${IMPORT_NOTE}, ${recorder},
                  ${provider}, ${provider ? p.zoho_payment_id : null}, ${p.created_at})
          RETURNING id`,
    );
    const paymentId = pay!.id;
    paymentByOld.set(p.id, paymentId);
    await postLedger(tx, org, owner, [
      {
        entryType: 'payment_received',
        debit: 'cash_bank',
        credit: 'client_advance',
        amountPaise: p.amount_paise,
        clientId: inv.clientId,
        matterId: inv.matterId,
        paymentId,
        metadata: { imported: true },
      },
    ]);
    const left = dueLeft.get(inv.id)!;
    const applied = inv.status === 'issued' ? Math.min(left, p.amount_paise) : 0;
    if (applied < p.amount_paise)
      warnings.push(
        `Receipt ${number} (${inv.number ?? 'draft'}): ${fromPaise(p.amount_paise - applied)} could not be applied to the ${inv.status} invoice; kept as an advance`,
      );
    if (applied > 0) {
      dueLeft.set(inv.id, left - applied);
      await query(
        tx,
        sql`INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount, allocated_by)
            VALUES (${org}, ${paymentId}, ${inv.id}, ${fromPaise(applied)}, ${recorder})`,
      );
      await postLedger(tx, org, owner, [
        {
          entryType: 'payment_allocated',
          debit: 'client_advance',
          credit: 'accounts_receivable',
          amountPaise: applied,
          clientId: inv.clientId,
          matterId: inv.matterId,
          invoiceId: inv.id,
          paymentId,
          metadata: { imported: true },
        },
      ]);
    }
  }

  // ---- Zoho links: paid ones tied to their payment, open ones to their instalment (the webhook matches provider_link_id) ----
  const env = opts.linkEnvironment ?? 'live';
  const links = { paid: 0, active: 0, canceled: 0 };
  const paidLinkIds = new Set<string>();
  const instalmentOfOld = new Map(old.instalments.map((s) => [s.id, s]));
  for (const p of payments) {
    if (!p.zoho_link_id || !paymentByOld.has(p.id)) continue;
    const inv = invoiceByOld.get(p.invoice_id)!;
    const s = instalmentOfOld.get(p.instalment_id);
    const same = s?.zoho_link_id === p.zoho_link_id;
    await query(
      tx,
      sql`INSERT INTO payment_links (organization_id, invoice_id, instalment_id, client_id, provider, environment, provider_link_id, url, amount,
                                     status, expires_at, paid_at, provider_payment_id, payment_id, created_by, created_at)
          VALUES (${org}, ${inv.id}, ${instalmentByOld.get(p.instalment_id) ?? null}, ${inv.clientId}, 'zohopay', ${env}, ${p.zoho_link_id},
                  ${same ? (s?.zoho_link_url ?? '') : ''}, ${fromPaise(same && s?.zoho_link_paise ? s.zoho_link_paise : p.amount_paise)},
                  'paid', ${same ? (s?.zoho_link_expires?.slice(0, 10) ?? null) : null},
                  (${p.paid_on}::date)::timestamp AT TIME ZONE (SELECT timezone FROM organizations WHERE id = ${org}), ${p.zoho_payment_id},
                  ${paymentByOld.get(p.id)!}, ${owner}, ${p.created_at})`,
    );
    paidLinkIds.add(p.zoho_link_id);
    links.paid++;
  }
  for (const s of old.instalments) {
    if (!s.zoho_link_id || paidLinkIds.has(s.zoho_link_id)) continue;
    const inv = invoiceByOld.get(s.invoice_id);
    if (!inv) continue;
    const paidOnIt = old.payments
      .filter((p) => p.instalment_id === s.id)
      .reduce((t, p) => t + p.amount_paise, 0);
    const open = inv.status === 'issued' && paidOnIt < s.amount_paise;
    await query(
      tx,
      sql`INSERT INTO payment_links (organization_id, invoice_id, instalment_id, client_id, provider, environment, provider_link_id, url, amount,
                                     status, expires_at, created_by)
          VALUES (${org}, ${inv.id}, ${instalmentByOld.get(s.id) ?? null}, ${inv.clientId}, 'zohopay', ${env}, ${s.zoho_link_id},
                  ${s.zoho_link_url ?? ''}, ${fromPaise(s.zoho_link_paise ?? s.amount_paise - paidOnIt)},
                  ${open ? 'active' : 'canceled'}, ${s.zoho_link_expires?.slice(0, 10) ?? null}, ${owner})`,
    );
    links[open ? 'active' : 'canceled']++;
  }

  // ---- DSC-signed PDFs ----
  let signedDocuments = 0;
  for (const d of old.documents) {
    const inv = invoiceByOld.get(d.invoice_id);
    if (!inv) continue;
    const rev = old.invoices.find((i) => i.id === d.invoice_id)!.revision;
    const key = signedKey(org, inv.id, rev, randomUUID());
    uploads.push({ key, bytes: d.pdf, contentType: 'application/pdf' });
    await query(
      tx,
      sql`INSERT INTO invoice_signed_documents (organization_id, invoice_id, revision, storage_key, size_bytes, uploaded_by, uploaded_at)
          VALUES (${org}, ${inv.id}, ${rev}, ${key}, ${d.pdf.length}, ${userOf(d.uploaded_by)}, ${d.uploaded_at})`,
    );
    signedDocuments++;
  }

  // ---- Email log -> matter timeline (history only; no notification rows) ----
  let timelineEmails = 0;
  for (const e of old.emails) {
    const inv = e.invoice_id !== null ? invoiceByOld.get(e.invoice_id) : undefined;
    if (!inv) continue;
    const verb = e.status === 'sent' ? 'sent' : e.status === 'failed' ? 'failed' : 'logged';
    await query(
      tx,
      sql`INSERT INTO timeline_events (organization_id, matter_id, client_id, event_type, title, actor_user_id, actor_type,
                                       source_type, source_id, metadata, created_at)
          VALUES (${org}, ${inv.matterId}, ${inv.clientId}, 'email.imported',
                  ${`Email ${verb} (previous app): ${e.subject} to ${e.to_addr}`.slice(0, 255)}, NULL, 'system', 'invoice', ${inv.id},
                  ${JSON.stringify({ kind: e.kind, status: e.status, triggeredBy: e.triggered_by, providerId: e.provider_id })}, ${e.created_at})`,
    );
    timelineEmails++;
  }
  const skippedEmails = old.emails.length - timelineEmails;
  if (skippedEmails)
    warnings.push(`${skippedEmails} email log row(s) without an imported invoice were not kept`);

  // ---- Numbering: continue the most recent invoice's prefix, 3 digits, next = max + 1 per FY ----
  const parsed = old.invoices
    .filter((i) => i.number && invoiceByOld.has(i.id))
    .map((i) => ({ inv: i, n: parseNumber(i.number!) }));
  for (const p of parsed.filter((x) => !x.n))
    warnings.push(`Invoice number ${p.inv.number} doesn't follow PREFIX/FY/NNN; kept verbatim, not counted`);
  const numbered = parsed.filter((x): x is { inv: OldInvoice; n: NonNullable<typeof x.n> } => x.n !== null);
  const prefixes = [...new Set(numbered.map((x) => x.n.prefix))].sort();
  const latest = [...numbered].sort(
    (a, b) => b.inv.issue_date.localeCompare(a.inv.issue_date) || b.inv.id - a.inv.id,
  )[0];
  const continuationPrefix = latest?.n.prefix ?? null;
  const sequences: Record<string, number> = {};
  if (continuationPrefix) {
    if (continuationPrefix.length > 20)
      throw new Error(`Prefix ${continuationPrefix} is longer than 20 characters`);
    for (const x of numbered.filter((y) => y.n.prefix === continuationPrefix))
      sequences[x.n.fiscalYear] = Math.max(sequences[x.n.fiscalYear] ?? 1, x.n.value + 1);
    await query(
      tx,
      sql`UPDATE organizations SET invoice_prefix = ${continuationPrefix}, invoice_number_digits = 3 WHERE id = ${org}`,
    );
    for (const [fy, next] of Object.entries(sequences)) {
      await query(
        tx,
        sql`INSERT INTO document_sequences (organization_id, kind, fiscal_year, next_value) VALUES (${org}, 'invoice', ${fy}, ${next})
            ON CONFLICT (organization_id, kind, fiscal_year) DO UPDATE SET next_value = GREATEST(document_sequences.next_value, EXCLUDED.next_value)`,
      );
    }
  }
  // The old app's counter is the last number it handed out. Above the highest imported number means numbers were drawn
  // that the export doesn't contain (a gap in the series): reported for someone to explain before go-live.
  const counterGaps: ImportReport['counterGaps'] = [];
  for (const c of old.counters) {
    const maxImported = Math.max(
      0,
      ...numbered
        .filter((x) => x.n.prefix === c.prefix && x.n.fiscalYear === c.fiscalYear)
        .map((x) => x.n.value),
    );
    if (c.value > maxImported) {
      counterGaps.push({ prefix: c.prefix, fiscalYear: c.fiscalYear, counter: c.value, maxImported });
      warnings.push(
        `The old app's counter for ${c.prefix}/${c.fiscalYear} is at ${c.value}, but the highest imported number is ${maxImported}: numbers ${maxImported + 1}–${c.value} are missing from the export`,
      );
    }
  }
  if (prefixes.length > 1)
    warnings.push(
      `More than one prefix was used (${prefixes.join(', ')}); all numbers are kept, new invoices continue ${continuationPrefix}`,
    );

  // ---- Out-of-order instalment payments: reported, not changed ----
  const outOfOrderInvoices = old.invoices
    .filter((i) => i.number && invoiceByOld.get(i.id)?.status === 'issued')
    .filter((i) =>
      paidOutOfOrder(
        old.instalments.filter((s) => s.invoice_id === i.id),
        old.payments.filter((p) => p.invoice_id === i.id),
      ),
    )
    .map((i) => i.number!);

  // ---- Plan future reminders/links for open invoices (imported: immediate workflows are skipped) ----
  for (const inv of invoiceByOld.values()) {
    if (inv.status !== 'issued' || !inv.sent || (dueLeft.get(inv.id) ?? 0) <= 0) continue;
    await emitEvent(tx, {
      organizationId: org,
      eventType: 'INVOICE_CREATED',
      aggregateType: 'invoice',
      aggregateId: inv.id,
      payload: {
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        matterId: inv.matterId,
        clientId: inv.clientId,
        total: fromPaise(inv.totalPaise),
        dueDate: inv.dueDate,
        sendToClient: true,
        imported: true,
      },
      actorUserId: owner,
    });
  }

  const { perClient, totals } = await verify(tx, org, old, clientIdByOld);
  const report: ImportReport = {
    dryRun: opts.dryRun,
    committed: false,
    prefixes,
    continuationPrefix,
    sequences,
    clients: { created, matched },
    matters: matterIdByKey.size,
    invoices: counts,
    payments: paymentByOld.size,
    paymentLinks: links,
    signedDocuments,
    timelineEmails,
    perClient,
    totals,
    outOfOrderInvoices,
    counterGaps,
    unmatchedSignatories,
    unmappedTitles,
    droppedGreetingWords,
    warnings,
    ok: totals.ok && perClient.every((c) => c.ok),
  };
  await recordAudit(tx, {
    organizationId: org,
    actorUserId: owner,
    action: 'billing.imported',
    entityType: 'organization',
    entityId: org,
    after: {
      source: 'vidhimeya-invoice',
      clients: report.clients,
      invoices: report.invoices,
      payments: report.payments,
      prefixes,
      continuationPrefix,
      sequences,
    },
    meta: { requestId: `import-vidhimeya:${randomUUID()}`, ip: null, userAgent: 'import-vidhimeya' },
  });
  return { report, uploads };
}

type Uploads = Upload[];
