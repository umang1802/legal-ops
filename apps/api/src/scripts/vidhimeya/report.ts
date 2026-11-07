/** The verification report: old totals per client vs LexForgeX's derived balances (v_invoice_balances). */
import { fromPaise, toPaise } from '@legalops/validation';
import { query, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { OldData } from './read-export.js';

export type ClientCheck = {
  name: string;
  invoices: number;
  oldInvoices: number;
  invoiced: string;
  paid: string;
  due: string;
  oldInvoiced: string;
  oldPaid: string;
  oldDue: string;
  ok: boolean;
};

export type ImportReport = {
  dryRun: boolean;
  /** False when the run was rolled back (dry run, or a failed check on a real run). */
  committed: boolean;
  /** Every prefix found in the old numbers; the continuation uses `continuationPrefix` (the most recent invoice's). */
  prefixes: string[];
  continuationPrefix: string | null;
  /** FY -> next number the continuation prefix will draw. */
  sequences: Record<string, number>;
  clients: { created: number; matched: number };
  matters: number;
  invoices: { issued: number; void: number; draft: number };
  payments: number;
  paymentLinks: { paid: number; active: number; canceled: number };
  signedDocuments: number;
  timelineEmails: number;
  perClient: ClientCheck[];
  totals: {
    invoiced: string;
    paid: string;
    due: string;
    oldInvoiced: string;
    oldPaid: string;
    oldDue: string;
    ok: boolean;
  };
  outOfOrderInvoices: string[];
  unmatchedSignatories: string[];
  /** Old honorifics that are not one of Mr/Ms/Mrs/Dr/Adv/M/s (imported as no salutation). */
  unmappedTitles: string[];
  /** Old greeting words ("Dear", "Respected") that LexForgeX doesn't store, with how many clients used each. */
  droppedGreetingWords: Record<string, number>;
  /** Old numbering counters above the highest imported number for that prefix and FY (numbers missing from the export). */
  counterGaps: { prefix: string; fiscalYear: string; counter: number; maxImported: number }[];
  warnings: string[];
  ok: boolean;
};

/**
 * Old side: sent invoices only (cancelled and draft ones carry nothing due), paid = payments recorded against them.
 * New side: issued invoices of the same clients, from the derived balances view.
 */
export async function verify(
  db: Db,
  organizationId: string,
  old: OldData,
  clientIdByOld: Map<number, string>,
): Promise<{ perClient: ClientCheck[]; totals: ImportReport['totals'] }> {
  const sent = old.invoices.filter((i) => i.status === 'sent');
  const sentIds = new Set(sent.map((i) => i.id));
  const newIds = [...new Set(clientIdByOld.values())];
  const rows = await query<{
    id: string;
    name: string;
    n: number;
    invoiced: string;
    paid: string;
    due: string;
  }>(
    db,
    sql`SELECT c.id, c.name, count(b.invoice_id)::int AS n,
               COALESCE(SUM(b.total_amount), 0)::text AS invoiced, COALESCE(SUM(b.amount_paid), 0)::text AS paid,
               COALESCE(SUM(b.amount_due), 0)::text AS due
        FROM clients c
        LEFT JOIN v_invoice_balances b ON b.organization_id = c.organization_id AND b.status = 'issued'
          AND b.invoice_id IN (SELECT id FROM invoices WHERE client_id = c.id)
        WHERE c.organization_id = ${organizationId} AND c.id = ANY(${newIds}::uuid[])
        GROUP BY c.id, c.name ORDER BY c.name`,
  );
  const sum = { invoiced: 0, paid: 0, due: 0, oldInvoiced: 0, oldPaid: 0, oldDue: 0 };
  const perClient = rows.map((r) => {
    const olds = old.clients.filter((c) => clientIdByOld.get(c.id) === r.id).map((c) => c.id);
    const inv = sent.filter((i) => olds.includes(i.client_id));
    const oldInvoiced = inv.reduce((s, i) => s + i.total_paise, 0);
    const invIds = new Set(inv.map((i) => i.id));
    const oldPaid = old.payments
      .filter((p) => invIds.has(p.invoice_id) && sentIds.has(p.invoice_id))
      .reduce((s, p) => s + p.amount_paise, 0);
    const oldDue = oldInvoiced - oldPaid;
    const [invoiced, paid, due] = [toPaise(r.invoiced), toPaise(r.paid), toPaise(r.due)];
    sum.invoiced += invoiced;
    sum.paid += paid;
    sum.due += due;
    sum.oldInvoiced += oldInvoiced;
    sum.oldPaid += oldPaid;
    sum.oldDue += oldDue;
    return {
      name: r.name,
      invoices: r.n,
      oldInvoices: inv.length,
      invoiced: fromPaise(invoiced),
      paid: fromPaise(paid),
      due: fromPaise(due),
      oldInvoiced: fromPaise(oldInvoiced),
      oldPaid: fromPaise(oldPaid),
      oldDue: fromPaise(oldDue),
      ok: r.n === inv.length && invoiced === oldInvoiced && paid === oldPaid && due === oldDue,
    };
  });
  const totals = {
    invoiced: fromPaise(sum.invoiced),
    paid: fromPaise(sum.paid),
    due: fromPaise(sum.due),
    oldInvoiced: fromPaise(sum.oldInvoiced),
    oldPaid: fromPaise(sum.oldPaid),
    oldDue: fromPaise(sum.oldDue),
    ok: sum.invoiced === sum.oldInvoiced && sum.paid === sum.oldPaid && sum.due === sum.oldDue,
  };
  return { perClient, totals };
}

/** Human-readable summary for the CLI. */
export function formatReport(r: ImportReport): string {
  const lines = [
    `${r.dryRun ? 'DRY RUN' : 'IMPORT'}: ${r.ok ? 'OK' : 'FAILED'}${r.committed ? ' (committed)' : ' (rolled back, nothing written)'}`,
    `Prefixes found: ${r.prefixes.join(', ') || '(none)'}; continuing with ${r.continuationPrefix ?? '(none)'} (3 digits)`,
    `Next numbers: ${
      Object.entries(r.sequences)
        .map(([fy, n]) => `${fy} -> ${n}`)
        .join(', ') || '(none)'
    }`,
    `Clients: ${r.clients.created} created, ${r.clients.matched} matched by email; matters: ${r.matters}`,
    `Invoices: ${r.invoices.issued} issued, ${r.invoices.void} void, ${r.invoices.draft} draft; payments: ${r.payments}`,
    `Payment links: ${r.paymentLinks.paid} paid, ${r.paymentLinks.active} active, ${r.paymentLinks.canceled} canceled`,
    `Signed PDFs: ${r.signedDocuments}; email history entries: ${r.timelineEmails}`,
    '',
    'Client | invoices old/new | invoiced old/new | paid old/new | due old/new | ok',
    ...r.perClient.map(
      (c) =>
        `${c.name} | ${c.oldInvoices}/${c.invoices} | ${c.oldInvoiced}/${c.invoiced} | ${c.oldPaid}/${c.paid} | ${c.oldDue}/${c.due} | ${c.ok ? 'yes' : 'NO'}`,
    ),
    `TOTAL | | ${r.totals.oldInvoiced}/${r.totals.invoiced} | ${r.totals.oldPaid}/${r.totals.paid} | ${r.totals.oldDue}/${r.totals.due} | ${r.totals.ok ? 'yes' : 'NO'}`,
    '',
    `Paid out of instalment order (check before reminders start): ${r.outOfOrderInvoices.join(', ') || 'none'}`,
    `Signatories who are not members (not created): ${r.unmatchedSignatories.join(', ') || 'none'}`,
    `Numbering gaps (old counter above the highest imported number): ${r.counterGaps.map((g) => `${g.prefix}/${g.fiscalYear} counter ${g.counter}, highest ${g.maxImported}`).join('; ') || 'none'}`,
    `Titles not mapped to a salutation: ${r.unmappedTitles.join(', ') || 'none'}`,
    `Greeting words dropped: ${
      Object.entries(r.droppedGreetingWords)
        .map(([w, n]) => `${w} x${n}`)
        .join(', ') || 'none'
    }`,
    ...r.warnings.map((w) => `WARNING: ${w}`),
  ];
  return lines.join('\n');
}
