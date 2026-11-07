import type { InstalmentDto, InstalmentStatus, OrganizationStatus } from '@legalops/types';
import { toPaise } from '@legalops/validation';
import { escapeHtml } from '../templates/render.js';
import { queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import { instalmentStatus } from '../billing/instalments.js';

export type ContextRefs = {
  clientId?: string | null;
  matterId?: string | null;
  caseId?: string | null;
  hearingId?: string | null;
  invoiceId?: string | null;
  instalmentId?: string | null;
  paymentId?: string | null;
  taskId?: string | null;
};

export type ResolvedRefs = Required<{ [K in keyof ContextRefs]: string | null }>;

/** Raw values the engine needs beyond display strings (anchors, guards, condition inputs). */
export type ContextRaw = {
  today: string;
  hearing?: { status: string; scheduled_date: string };
  invoice?: { status: string; due_date: string | null; amount_due: string; total: string };
  /** Set when the refs name an instalment (per-instalment reminders and link emails). */
  instalment?: { seq: number; due_date: string; remaining: string };
  task?: { status: string; due_date: string | null; assignee_id: string | null; created_by: string | null };
  leadUserId: string | null;
  orgStatus: OrganizationStatus;
};

export type TemplateContext = { vars: Record<string, Record<string, unknown>>; refs: ResolvedRefs; raw: ContextRaw };

type OrgCtxRow = {
  name: string; email: string | null; phone: string | null; today: string; status: OrganizationStatus;
  registration_label: string | null; registration_value: string | null; bank_account_name: string | null; bank_account_number: string | null;
  bank_ifsc: string | null; bank_name: string | null; bank_branch: string | null; upi_id: string | null;
};

/** Escaped HTML block of the firm's payment details; '' when none are set. Rendered raw by `*_html` variables. */
function bankDetailsHtml(o: OrgCtxRow): string {
  const rows: [string, string | null][] = [
    ['Account name', o.bank_account_name],
    ['Account number', o.bank_account_number],
    ['IFSC', o.bank_ifsc],
    ['Bank', o.bank_name],
    ['Branch', o.bank_branch],
    ['UPI', o.upi_id],
  ];
  const lines = rows.filter(([, v]) => v).map(([k, v]) => `${k}: <strong>${escapeHtml(v!)}</strong>`);
  return lines.length ? `<p>${lines.join('<br>')}</p>` : '';
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const money = (s: string | null | undefined) => (s == null ? '' : inr.format(toPaise(s) / 100));
const dateText = (d: string | null | undefined, weekday = false) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...(weekday ? { weekday: 'short' } : {}), timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, m! - 1, day!)),
  );
};
const timeText = (t: string | null | undefined) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! >= 12 ? 'pm' : 'am'}`;
};
type HearingText = { scheduled_date: string; status: string; client_summary: string | null };
/** What a client may be told about a held hearing: the firm's summary, or a neutral line. */
const clientUpdateText = (h: HearingText) =>
  h.client_summary?.trim() ||
  (h.status === 'adjourned' ? `The hearing on ${dateText(h.scheduled_date)} was adjourned.` : `The hearing on ${dateText(h.scheduled_date)} was held.`);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** "Dear <contact person>" when there is one (no salutation: it belongs to the client, not the person), else "Dear <salutation> <name>". */
export function clientGreeting({ salutation, contactPerson, name }: { salutation: string | null; contactPerson: string | null; name: string }): string {
  const person = contactPerson?.trim();
  if (person) return `Dear ${person}`;
  return `Dear ${salutation ? `${salutation} ` : ''}${name}`;
}

const INSTALMENT_LABEL: Record<InstalmentStatus, string> = { paid: 'Paid', part_paid: 'Part paid', due: 'Due', overdue: 'Overdue' };
const TD = 'border:1px solid #ddd;padding:6px;text-align:left';

/**
 * What the client owes now and the full schedule, for invoice emails (`invoice.amount_now`, `due_now`, `payment_terms_html`).
 * The HTML is assembled only from escaped money, date and fixed-label text (the variable is on the raw-HTML allow-list).
 */
export function paymentTerms(all: InstalmentDto[], amountDue: string, dueDate: string) {
  const firstIdx = all.findIndex((x) => toPaise(x.remaining) > 0);
  if (all.length === 0 || firstIdx < 0) {
    // No due date: payable on receipt, and no empty "Due by" line.
    return {
      amount_now: amountDue,
      due_now: dueDate || 'on receipt',
      payment_terms_html: dueDate
        ? `<p>Amount due: <strong>${escapeHtml(amountDue)}</strong><br>Due by: <strong>${escapeHtml(dueDate)}</strong></p>`
        : `<p>Amount due: <strong>${escapeHtml(amountDue)}</strong>, payable on receipt</p>`,
    };
  }
  const first = all[firstIdx]!;
  const amountNow = money(first.remaining);
  const dueNow = dateText(first.dueDate);
  const cell = (s: string, bold = false) => `<td style="${TD}">${bold ? `<strong>${escapeHtml(s)}</strong>` : escapeHtml(s)}</td>`;
  const rows = all
    .map((x, idx) => `<tr>${cell(String(x.seq))}${cell(dateText(x.dueDate))}${cell(money(x.amount))}${idx === firstIdx ? cell('Due now', true) : cell(INSTALMENT_LABEL[x.status])}</tr>`)
    .join('');
  const head = ['#', 'Due date', 'Amount', 'Status'].map((h) => `<th style="${TD}">${h}</th>`).join('');
  return {
    amount_now: amountNow,
    due_now: dueNow,
    payment_terms_html:
      `<p>This invoice is payable in ${all.length} instalments. <strong>${escapeHtml(amountNow)}</strong> is due by <strong>${escapeHtml(dueNow)}</strong>.</p>` +
      `<table style="border-collapse:collapse;font-size:14px"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  };
}

/**
 * `links.pay` plus a ready-made paragraph (`links.pay_html`, '' when there is no link) for templates without conditionals.
 * Only a link for exactly what is still owed is exposed: a stale one (e.g. its cancel at Zoho failed) is never sent.
 */
function setPayLink(vars: TemplateContext['vars'], link: { url: string; amount: string } | null, seq: number, count: number, remaining: string) {
  if (!link || toPaise(link.amount) !== toPaise(remaining)) return;
  const url = link.url;
  vars.links!.pay = url;
  vars.links!.pay_html = `<p><a href="${escapeHtml(url)}">Pay online</a> (instalment ${seq} of ${count})</p>`;
}

/**
 * Builds template variables and engine inputs for whatever records an event or action refers to.
 * Links fill in the gaps (hearing → case → matter → client). `now` drives "today", so the dev test
 * clock produces the same phrases ("overdue by 7 days") as real time would.
 */
export async function buildContext(db: Db, organizationId: string, refs: ContextRefs, now: Date, appUrl: string): Promise<TemplateContext> {
  const r: ResolvedRefs = { clientId: null, matterId: null, caseId: null, hearingId: null, invoiceId: null, instalmentId: null, paymentId: null, taskId: null, ...refs };
  const org = (await queryOne<OrgCtxRow>(
    db,
    sql`SELECT name, email, phone, status, registration_label, registration_value, bank_account_name, bank_account_number,
               bank_ifsc, bank_name, bank_branch, upi_id, ((${now.toISOString()}::timestamptz AT TIME ZONE timezone)::date)::text AS today FROM organizations WHERE id = ${organizationId}`,
  ))!;
  const vars: TemplateContext['vars'] = {
    firm: {
      name: org.name,
      email: org.email ?? '',
      phone: org.phone ?? '',
      registration_line: org.registration_value ? `${org.registration_label ? `${org.registration_label}: ` : ''}${org.registration_value}` : '',
      bank_details_html: bankDetailsHtml(org),
    },
    links: {},
  };
  const raw: ContextRaw = { today: org.today, leadUserId: null, orgStatus: org.status };
  const link = (path: string) => `${appUrl.replace(/\/$/, '')}${path}`;

  if (r.taskId) {
    const t = await queryOne<{ title: string; status: string; priority: string; due_date: string | null; assignee_id: string | null; created_by: string | null; matter_id: string | null; case_id: string | null; hearing_id: string | null; matter_title: string | null }>(
      db,
      sql`SELECT t.title, t.status, t.priority, (t.due_at AT TIME ZONE o.timezone)::date::text AS due_date, t.assignee_id, t.created_by,
                 t.matter_id, t.case_id, t.hearing_id, m.title AS matter_title
          FROM tasks t JOIN organizations o ON o.id = t.organization_id LEFT JOIN matters m ON m.id = t.matter_id
          WHERE t.id = ${r.taskId} AND t.organization_id = ${organizationId}`,
    );
    if (t) {
      r.matterId ??= t.matter_id;
      r.caseId ??= t.case_id;
      vars.task = {
        title: t.title,
        priority: t.priority,
        due_date: dateText(t.due_date),
        due_phrase: t.due_date ? `, due ${dateText(t.due_date, true)}` : '',
        matter_phrase: t.matter_title ? ` on ${t.matter_title}` : '',
      };
      vars.links!.task = link(`/tasks/${r.taskId}`);
      raw.task = { status: t.status, due_date: t.due_date, assignee_id: t.assignee_id, created_by: t.created_by };
    }
  }
  if (r.paymentId) {
    const p = await queryOne<{ amount: string; tds_amount: string; receipt_number: string; payment_date: string; client_id: string; matter_id: string | null; inv_number: string | null; inv_due: string | null; inv_matter: string | null }>(
      db,
      sql`SELECT p.amount::text, p.tds_amount::text, p.receipt_number, p.payment_date::text, p.client_id, p.matter_id,
                 i.invoice_number AS inv_number, b.amount_due::text AS inv_due, i.matter_id AS inv_matter
          FROM payments p
          LEFT JOIN LATERAL (SELECT a.invoice_id FROM payment_allocations a WHERE a.payment_id = p.id AND a.status = 'active' ORDER BY a.created_at LIMIT 1) fa ON TRUE
          LEFT JOIN invoices i ON i.id = fa.invoice_id
          LEFT JOIN v_invoice_balances b ON b.invoice_id = i.id
          WHERE p.id = ${r.paymentId} AND p.organization_id = ${organizationId}`,
    );
    if (p) {
      r.clientId ??= p.client_id;
      r.matterId ??= p.matter_id ?? p.inv_matter;
      vars.payment = {
        amount: money(p.amount),
        amount_rupees: toPaise(p.amount) / 100,
        receipt_number: p.receipt_number,
        date: dateText(p.payment_date),
        balance_phrase: p.inv_number
          ? toPaise(p.inv_due ?? '0') > 0
            ? `Balance outstanding on invoice ${p.inv_number}: ${money(p.inv_due)}.`
            : `Invoice ${p.inv_number} is now fully paid.`
          : '',
      };
    }
  }
  // In an instalment's scope, the invoice's due date, balance and reminder wording are the instalment's.
  let scope: { dueDate: string; remaining: string } | null = null;
  let all: Awaited<ReturnType<typeof instalmentStatus>> = [];
  if (r.instalmentId) {
    const ii = await queryOne<{ invoice_id: string; seq: number; cnt: number }>(
      db,
      sql`SELECT ii.invoice_id, ii.seq, (SELECT count(*)::int FROM invoice_instalments x WHERE x.invoice_id = ii.invoice_id) AS cnt
          FROM invoice_instalments ii WHERE ii.id = ${r.instalmentId} AND ii.organization_id = ${organizationId}`,
    );
    if (ii) {
      r.invoiceId ??= ii.invoice_id;
      const st = (await instalmentStatus(db, ii.invoice_id, org.today)).find((x) => x.id === r.instalmentId);
      if (st) {
        vars.instalment = {
          number: st.seq,
          seq: st.seq,
          count: ii.cnt,
          amount: money(st.amount),
          remaining: money(st.remaining),
          due_date: dateText(st.dueDate),
        };
        setPayLink(vars, st.activeLink, st.seq, ii.cnt, st.remaining);
        raw.instalment = { seq: st.seq, due_date: st.dueDate, remaining: st.remaining };
        scope = { dueDate: st.dueDate, remaining: st.remaining };
      }
    }
  } else if (r.invoiceId) {
    // An instalment invoice's own emails carry the link for its first unpaid instalment.
    all = await instalmentStatus(db, r.invoiceId, org.today);
    const first = all.find((x) => toPaise(x.remaining) > 0);
    if (first) setPayLink(vars, first.activeLink, first.seq, all.length, first.remaining);
  }
  if (r.invoiceId) {
    const i = await queryOne<{ invoice_number: string | null; status: string; total: string; amount_due: string; due_date: string | null; client_id: string; matter_id: string }>(
      db,
      sql`SELECT i.invoice_number, i.status, i.total_amount::text AS total, b.amount_due::text, i.due_date::text, i.client_id, i.matter_id
          FROM invoices i JOIN v_invoice_balances b ON b.invoice_id = i.id WHERE i.id = ${r.invoiceId} AND i.organization_id = ${organizationId}`,
    );
    if (i) {
      r.clientId ??= i.client_id;
      r.matterId ??= i.matter_id;
      const dueDate = scope?.dueDate ?? i.due_date;
      const amountDue = scope?.remaining ?? i.amount_due;
      const delta = dueDate ? daysBetween(org.today, dueDate) : null;
      vars.invoice = {
        number: i.invoice_number ?? '',
        total: money(i.total),
        amount_due: money(amountDue),
        total_rupees: toPaise(i.total) / 100,
        amount_due_rupees: toPaise(amountDue) / 100,
        due_date: dateText(dueDate),
        days_overdue: delta !== null && delta < 0 ? -delta : 0,
        reminder_phrase:
          delta === null ? 'due' : delta > 1 ? `due in ${delta} days` : delta === 1 ? 'due tomorrow' : delta === 0 ? 'due today' : `overdue by ${-delta} day${delta === -1 ? '' : 's'}`,
      };
      if (!r.instalmentId) Object.assign(vars.invoice, paymentTerms(all, money(i.amount_due), dateText(i.due_date)));
      vars.links!.invoice = link(`/invoices/${r.invoiceId}`);
      raw.invoice = { status: i.status, due_date: i.due_date, amount_due: i.amount_due, total: i.total };
    }
  }
  if (r.hearingId) {
    const h = await queryOne<{ case_id: string; status: string; scheduled_date: string; start_time: string | null; courtroom: string | null; hearing_type: string | null; outcome: string | null; client_summary: string | null; next_hearing_date: string | null }>(
      db,
      sql`SELECT case_id, status, scheduled_date::text, to_char(start_time, 'HH24:MI') AS start_time, courtroom, hearing_type, outcome, client_summary, next_hearing_date::text
          FROM hearings WHERE id = ${r.hearingId} AND organization_id = ${organizationId}`,
    );
    if (h) {
      r.caseId ??= h.case_id;
      const delta = daysBetween(org.today, h.scheduled_date);
      vars.hearing = {
        date: dateText(h.scheduled_date, true),
        time: timeText(h.start_time),
        time_phrase: h.start_time ? ` at ${timeText(h.start_time)}` : '',
        courtroom: h.courtroom ?? '',
        courtroom_phrase: h.courtroom ? `, court room ${h.courtroom}` : '',
        hearing_type: h.hearing_type ?? '',
        outcome: h.outcome ?? '',
        client_summary: h.status === 'completed' || h.status === 'adjourned' ? clientUpdateText(h) : '',
        next_date: h.next_hearing_date ? dateText(h.next_hearing_date, true) : '',
        result: h.status,
        when: delta === 0 ? 'Today' : delta === 1 ? 'Tomorrow' : delta > 1 ? `In ${delta} days` : dateText(h.scheduled_date),
      };
      vars.links!.hearing = link(`/hearings/${r.hearingId}`);
      raw.hearing = { status: h.status, scheduled_date: h.scheduled_date };
      // The most recent held hearing on the same case, for "last update" lines in reminders.
      const prev = await queryOne<HearingText & { outcome: string | null }>(
        db,
        sql`SELECT scheduled_date::text, status, client_summary, outcome FROM hearings
            WHERE case_id = ${h.case_id} AND organization_id = ${organizationId}
              AND status IN ('completed', 'adjourned') AND scheduled_date < ${h.scheduled_date}
            ORDER BY scheduled_date DESC, completed_at DESC NULLS LAST LIMIT 1`,
      );
      vars.previous = prev
        ? {
            date: dateText(prev.scheduled_date),
            client_update: clientUpdateText(prev),
            client_update_phrase: `Update from the last hearing (${dateText(prev.scheduled_date)}): ${clientUpdateText(prev)}`,
            internal_note: prev.outcome ?? '',
            internal_note_phrase: prev.outcome ? `Internal note from the last hearing: ${prev.outcome}` : '',
          }
        : { date: '', client_update: '', client_update_phrase: '', internal_note: '', internal_note_phrase: '' };
    }
  }
  if (r.caseId) {
    const c = await queryOne<{ title: string; case_number: string | null; cnr: string | null; status: string; matter_id: string; court: string | null }>(
      db,
      sql`SELECT cs.title, cs.case_number, cs.cnr, cs.status, cs.matter_id, ct.name AS court
          FROM cases cs LEFT JOIN courts ct ON ct.id = cs.court_id WHERE cs.id = ${r.caseId} AND cs.organization_id = ${organizationId}`,
    );
    if (c) {
      r.matterId ??= c.matter_id;
      vars.case = { title: c.title, case_number: c.case_number ?? c.title, cnr: c.cnr ?? '', status: c.status, court: c.court ?? 'the court' };
    }
  }
  if (r.matterId) {
    const m = await queryOne<{ title: string; reference_code: string | null; status: string; priority: string; practice_area: string | null; client_id: string; lead: string | null }>(
      db,
      sql`SELECT m.title, m.reference_code, m.status, m.priority, m.practice_area, m.client_id,
                 (SELECT user_id FROM matter_staff WHERE matter_id = m.id AND role = 'lead') AS lead
          FROM matters m WHERE m.id = ${r.matterId} AND m.organization_id = ${organizationId}`,
    );
    if (m) {
      r.clientId ??= m.client_id;
      raw.leadUserId = m.lead;
      vars.matter = { title: m.title, reference: m.reference_code ?? '', status: m.status, priority: m.priority, practice_area: m.practice_area ?? '' };
      vars.links!.matter = link(`/matters/${r.matterId}`);
      // Cases are optional context for matter-level messages.
      if (!vars.case) {
        const c = await queryOne<{ title: string; case_number: string | null; cnr: string | null; status: string; court: string | null }>(
          db,
          sql`SELECT cs.title, cs.case_number, cs.cnr, cs.status, ct.name AS court FROM cases cs LEFT JOIN courts ct ON ct.id = cs.court_id
              WHERE cs.matter_id = ${r.matterId} ORDER BY cs.created_at LIMIT 1`,
        );
        if (c) vars.case = { title: c.title, case_number: c.case_number ?? c.title, cnr: c.cnr ?? '', status: c.status, court: c.court ?? 'the court' };
      }
    }
  }
  if (r.clientId) {
    const c = await queryOne<{ name: string; client_type: string; salutation: string | null; contact_person: string | null }>(
      db,
      sql`SELECT name, client_type, salutation, contact_person FROM clients WHERE id = ${r.clientId} AND organization_id = ${organizationId}`,
    );
    if (c) vars.client = {
      name: c.name,
      client_type: c.client_type,
      greeting: clientGreeting({ salutation: c.salutation, contactPerson: c.contact_person, name: c.name }),
    };
  }
  return { vars, refs: r, raw };
}

/** Flattened view for condition evaluation: { 'matter.status': 'active', ... }. */
export function flatten(vars: TemplateContext['vars']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [group, obj] of Object.entries(vars)) for (const [k, v] of Object.entries(obj)) out[`${group}.${k}`] = v;
  return out;
}

