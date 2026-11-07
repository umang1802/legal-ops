# LexForgeX — Decision Log

Decisions that override or clarify `prd/`. When the PRD and this file disagree, this file wins.

## D-001 · Tax: two modes, chosen per organization (2026-10-02)

- `organizations.tax_mode` is `simple` or `gst`. Each invoice snapshots the mode at creation, so changing the org setting never rewrites history.
- **simple:** the user enters `tax_amount` directly. There is no GST breakdown.
- **gst:** the invoice snapshots supplier GSTIN/state and recipient GSTIN/state, plus `place_of_supply`. Lines carry `sac_code` and `gst_rate`.
  - Same state → CGST + SGST. Different state → IGST. Never both (enforced by a DB CHECK).
  - **Reverse charge (`is_reverse_charge`):** GST is shown in `rcm_tax_amount` for disclosure only, and `tax_amount` = 0. The client pays the GST directly, not to the firm.
  - Which clients are RCM and the exact rates must be **confirmed with a CA before go-live**. The code exposes them as data, not hard-coded rules.
- **TDS works in both modes.** A payment records cash `amount` plus `tds_amount` (deducted by the client). Both settle invoices. TDS-certificate (Form 16A) receipt is tracked on the payment.

## D-002 · Payments: one payment can settle many invoices, and advances are allowed (2026-10-02)

- A payment belongs to a **client** (matter optional), not to an invoice.
- `payment_allocations` split the settlement (`amount + tds_amount`) across invoices. Any unallocated remainder is a **client advance**, which can be allocated later by appending allocation rows.
- Allocations are never edited. To un-apply one, mark it `reversed`. Reversing a payment reverses all of its allocations.
- Invoice balance is **derived** (view `v_invoice_balances`) from active allocations and credit notes, never from a cached column.
- Invoice lifecycle stored in the DB: `draft → issued → void | written_off`. Payment state (`unpaid/partial/paid`) and `is_overdue` are derived.

## D-003 · Client access is magic-link only (2026-10-02)

- Clients are **not** rows in `users` or `organization_members`. Roles are `owner, admin, lawyer, staff, finance, read_only`.
- Portal access works through `client_portal_tokens`: the token is hashed, expires, is single-use and can be revoked. A used token is exchanged for a short-lived `client_portal_sessions` row.

## D-004 · Matter visibility: assigned-only, with multiple assignees (2026-10-02)

- `matter_staff` is the single source of assignment. A matter can have many members, with at most one `lead` (the responsible lawyer).
- **Sees all matters:** owner, admin, finance (finance needs the billing view; case data is limited by field, not by row).
- **Sees only assigned matters:** lawyer, staff, read_only.
- Everything hanging off a matter follows the matter's visibility: cases, hearings, tasks, documents, invoices and notifications. A task assigned directly to a user is also visible to that user.
- Enforcement is server-side in one place (a `matterScope(ctx)` query helper), and it has its own tests.

## D-005 · Pilot firm: Vidhimeya (2026-10-02)

- They currently track hearings and client updates by **phone calls and messages**, with no tool.
- What this means:
  - The baseline to beat is "manual calls/messages", so manual hearing entry in LexForgeX is already an improvement, not a regression. Court sync stays out of V1.
  - Their clients are used to messaging. Email-only V1 is still the plan, but WhatsApp is the **first post-pilot channel**. `NotificationChannel` must be real, not a stub.
  - Baseline metrics to start collecting now: client update calls/messages per week, payment follow-ups per week, missed or late hearing prep.

## D-006 · Repository

- Standalone git repo at `Eduforgex/legal-ops/`, remote `git@github.com:umang1802/legal-ops.git`.

## D-007 · Client directory is firm-wide; matters stay assigned-only (2026-10-02)

- Every member with `clients.view` can see the client list and contact details. This lets anyone run a **conflict-of-interest check** and prevents duplicate clients being created by people who can't see the original.
- Everything under a client (matters, cases, hearings, documents, invoices) still follows D-004. A lawyer opening a client sees only matters they're assigned to.
- Duplicate detection (same email, same normalised phone, or similar name via `pg_trgm`) **warns but never merges**. Creating anyway requires an explicit `acknowledgeDuplicates`, which is audited as `client.created_despite_duplicate`.
- **Revisit if** a firm needs ethical walls (some clients hidden from some staff). That would be a client-level ACL, not a change to matter visibility.

## D-008 · Creating vs editing under a matter (2026-10-02)

- A lawyer or staff member who creates a matter is automatically assigned to it: as **lead** if a lawyer and no lead was chosen, otherwise as support. Without this, they would immediately lose access to what they created.
- Only owner, admin or lawyer can be a lead.
- **Adding** cases, parties and advocates to a visible matter needs `matters.create`, so staff/clerks can do the data entry. **Changing or removing** them needs `matters.edit` (lawyers and above). These map to the PRD's "Edit case details: staff configurable" cell, defaulting to off.
- Court refresh returns `501 NOT_CONFIGURED` from `NoopCourtProvider`, and `last_synced_at` stays null. The UI shows "Entered manually".

## D-009 · Hearing outcomes and the daily loop (2026-10-03)

- **No outcome before the hearing date.** Recording an outcome for a future hearing is rejected (`422`), because it would put a false entry on the timeline. If a hearing was entered on the wrong date, _edit_ it. If the listing was dropped, _cancel_ it with a reason.
- **Recording an outcome is one transaction, and it can't be replayed.** It saves the outcome, creates the next hearing (inheriting court room and bench), creates follow-up tasks (linked to the hearing and to the `HEARING_COMPLETED` event, with idempotency keys) and adds timeline entries. A second attempt returns `409`.
- **"Outcome needed"** = a hearing that is still `scheduled` after its date (firm timezone). It is surfaced on the dashboard and calendar so nothing silently goes stale.
- **Next hearing is always derived** from the `hearings` table (scheduled, on or after the firm's today). `cases.next_hearing_date` is kept in sync for sorting/imports, but is never trusted on reads.
- **Follow-up tasks default to the matter's lead lawyer,** else the person recording the outcome.
- **Tasks** are visible on assigned matters, plus any task assigned to or created by you. A task's assignee can complete or update it even without `tasks.manage`; creating and reassigning needs `tasks.manage`.
- **Due dates** are stored as instants. A date with no time means 23:59 in the firm's timezone, so a task is "due today" all day and "overdue" from the next day.
- **Dashboard scope:** owner/admin/finance see the firm; lawyer/staff/read-only see their assigned matters and their own tasks. Money figures stay `null` ("—") until billing exists.

## D-010 · GST defaults: reverse charge and place of supply (2026-10-03)

- **Reverse charge defaults to ON for clients that are companies with a GSTIN.** Legal services from an advocate/firm to a business entity are generally under RCM. It can be overridden per invoice. **A CA must confirm the rule for Vidhimeya's client mix before go-live.**
- **Place of supply** defaults to the client's GST state code, else the firm's. Same state as the firm → CGST+SGST; different → IGST. It can be overridden per invoice.
- **Pure-agent reimbursements** (court fees, stamp duty) are never taxed or discounted. Expense lines are flagged this way by default in GST mode.
- GST mode cannot be enabled without a firm GSTIN and state code. This is enforced by the API _and_ a DB CHECK.

## D-011 · Billing mechanics (2026-10-03)

- **Numbering:** one gapless sequence per firm, per document type (invoice/receipt/credit note), per Indian FY (Apr–Mar), e.g. `LGL/2026-27/000001`, `RCPT/…`, `CN/…`. A number is assigned only at issue, under a row lock. Drafts have no number and can be deleted.
- **Issued invoices are frozen** (API + DB trigger). Corrections use credit notes (numbered, with a proportional tax share) or void. Void is blocked while payments or credit notes apply.
- **Payments:**
  - A payment is recorded against the client and split across invoices. TDS counts towards settlement.
  - An unapplied remainder needs an explicit "keep as advance".
  - Allocations lock invoices in id order, so concurrent payments can't deadlock.
  - A mistake is fixed by un-applying an allocation or reversing the payment, never by editing it.
- **"Collected this month"** = cash + TDS (what was settled). Both are listed separately on each payment.
- **Ledger:** cash/TDS → client advance → accounts receivable, so advances and allocations are visible in the books. Tests assert that each invoice's AR movement equals its amount due.
- **PDFs:** V1 uses print-ready pages (browser "Save as PDF"). Server-side PDF generation and storage (`pdf_storage_key`) are deferred.
- **Expenses:**
  - Clerks can record them (`matters.create`); they're visible to anyone who can see the matter.
  - A billed expense is locked to its invoice.
  - Amounts change only by void + re-record. Expenses are never deleted (DB trigger).

## D-013 · Client-facing hearing text and once-per-key automation defaults (2026-10-17)

(D-012, the Postgres-polling worker, is still to be written up; LexForgeX Track 6.)

- `hearings.outcome` is the team's internal note. `hearings.client_summary` is the only hearing text a client may see; blank means a neutral line ("The hearing on {date} was adjourned/held.").
- Template variables flagged `internalOnly` in `@legalops/types` are stripped before any client-bound render (`varsForAudience`) and rejected when saving a client template. A client recipient is always rendered as client audience.
- Migration 0006 rewrote firm client-template overrides from `{{hearing.outcome}}` to `{{hearing.client_summary}}`; existing outcomes were not copied into `client_summary`.
- Default automations are offered once per key (`settings.seededWorkflowKeys`): new defaults reach existing firms; deleted ones never return. Replaces the one-shot `defaultWorkflowsSeeded` flag.
- When a firm receives new hearing recipes, they are planned against every upcoming scheduled hearing (`planUpcomingHearings`, run after the event's own planning so a reschedule's cancel-and-replan isn't undone).
- Deferred: editing a hearing's client summary after it is saved. A wrong summary is emailed at once and repeated in the next hearing's reminders; correcting it needs an edit path with an audit entry (later track).

## D-014 · Platform realm and firm suspension (2026-10-17)

- LexForgeX team members are `platform_admins`, a realm separate from firm users: own table, session table, cookie (`lf_psid`, path `/api/v1/platform`, SameSite=Strict), CSRF secret and router mounted before the firm router. Password + TOTP (RFC 6238, replay-guarded) on every sign-in; 30-minute idle and 12-hour absolute session limits; a session that hasn't passed the second factor lasts 10 minutes. Five wrong codes lock that admin's second factor for 15 minutes and end their password-only sessions (per admin, not per IP). Failed passwords, failed codes and lockouts are in `platform_audit_logs`. Admins are created or reset only by `pnpm --filter @legalops/api platform:create-admin`.
- Firms are created by a platform invite (`status = 'invited'`) and become `active` when the owner accepts. Payment is tracked manually in `platform_notes` (never exposed to firms; audit records only that notes changed).
- Suspended firms are read-only: one middleware on the firm router (before every sub-router, so new routes are covered by construction) returns `FIRM_SUSPENDED` for writes except logout/switch-organization; the worker records due actions as skipped ("Firm suspended") and never resends them; reactivation also skips anything that fell due during the suspension but was never claimed. Token-based account flows (password reset, email verification, invite acceptance) stay allowed. The web app hides non-read controls through `canAct(me, permission)` in `apps/web/src/lib/auth.ts` (use it instead of `can(me.role, …)` for any UI control) and shows a banner.
- TOTP enrolment shows the key and an `otpauth://` link; no QR image (deferred).

## D-015 · Instalments: one invoice, several dated parts (2026-11-06)

- An instalment plan is **one invoice** with **2–24 `invoice_instalments`** (`seq`, `amount`, `due_date`). It is never split into several invoices.
  - The amounts add up exactly to `total_amount`.
  - Due dates strictly increase.
  - `invoices.due_date` = the last instalment's date.
  - An invoice with no rows behaves exactly as before.
- **Paid per instalment is derived, never stored.** The invoice's active allocations (cash **and TDS**, as D-002) are applied to the instalments in `seq` order: FIFO. Each instalment is `paid`, `part_paid`, `due` or `overdue`. A manual payment therefore always goes to the earliest unpaid instalment. A client who paid a later instalment first is shown as having paid the earlier one.
- **Payment links.** There is at most one active link per instalment (or per invoice, when there are no instalments). A link is created for the instalment's **remaining** amount. A link whose amount no longer matches is cancelled at Zoho and replaced when the next one is sent. A stale amount is never emailed.
- **Emails.**
  - The invoice email carries the schedule and the first unpaid instalment's link.
  - Every later instalment's link goes 3 days before its due date, at 10:00 firm time. For instalments it replaces the "due in 3 days" reminder.
  - The other reminders are anchored on each instalment's due date.

## D-016 · In-place revisions for simple-tax invoices only (2026-11-06)

- A **simple-tax** issued invoice can be revised in place. Amounts, items, due date, notes and the instalment schedule can change. The number, issue date, client, matter and tax mode never change. `revision` counts up and `revised_at` is set.
- The ledger records a revision as an `invoice_revised` delta entry, never as an edit.
- **GST invoices stay frozen** (API + DB trigger). They are corrected only with a credit note or void (D-011).
- Paid instalments can't change. An instalment can't go below what was paid on it.
- After a revision:
  - payment links with a stale amount are cancelled at Zoho first;
  - a DSC-signed copy of an older revision is no longer used (the generated PDF goes out instead);
  - only date-relative reminders whose date moved are re-planned. A revision never re-sends the invoice email; the client gets "invoice updated" only when the firm chooses to send it.

## D-017 · Email attachments are references, resolved at send time (2026-11-06)

- A notification stores **references**, never bytes: `{kind: 'invoice_pdf', invoiceId}` or `{kind: 'receipt_pdf', paymentId}` in `notifications.attachments`.
  - Client-facing invoice, instalment, reminder and "invoice updated" emails reference the invoice PDF.
  - "Payment received" references the receipt.
- The PDF is produced **when the email is sent**. It is the invoice's active DSC-signed copy for its current revision, else the generated `pdf-lib` PDF. A reminder planned weeks ahead therefore carries the invoice as it is on the day it goes out, including any revision.
- If the PDF can't be produced, the send fails permanently and is visible in the notification log. The email never goes out without its attachment.
- CC addresses (up to 5 per client) are stored on the notification when it is created.

## D-018 · Vidhimeya import rules (2026-11-06)

One-off import from the old invoicing app (D1 export). Command: `import:vidhimeya` / `dist/import-vidhimeya.js`. Runbook: `docs/runbooks/vidhimeya-billing-cutover.md`.

- **The import is all or nothing.** It runs in one transaction.
  - It is refused if the firm already has issued invoices, payments or an earlier import.
  - `--dry-run` rolls back.
  - A real run whose per-client totals differ from the old app by more than ₹0 also rolls back.
  - Files (signatures, signed PDFs) are uploaded only after the checks pass.
- **Old numbers are kept verbatim and the series continues.**
  - `invoice_prefix` = the most recent invoice's prefix, `invoice_number_digits = 3`.
  - `document_sequences` = the highest imported number + 1 per FY.
  - Every prefix found is listed.
  - An old counter higher than the highest exported number is reported as a gap.
- **Drafts are imported with their numbers (`prenumbered`).**
  - They can't be deleted, only issued or voided.
  - On issue they keep their number and draw nothing; the issue date must stay in that number's FY.
  - On void they take the number's FY.
- **Salutation and greeting.** The old `title` (honorific) maps to the `salutation` enum Mr/Ms/Mrs/Dr/Adv/M/s, case-insensitive and without a trailing dot. Anything else maps to none and is reported. The old `salutation` (the greeting word "Dear"/"Respected") is dropped and counted in the report. Greetings are always "Dear {salutation} {name}" (spec §8).
- **Clients and matters.**
  - Clients are matched by email, case-insensitive. A matched client only has its empty fields filled.
  - One matter per client per subject; with no subject, the matter is "Advisory: {client}". The owner leads every matter.
- **Invoices and payments.**
  - Sent becomes issued; cancelled becomes void ("Cancelled in previous invoicing app").
  - One old instalment = no instalment rows.
  - Payments get RCPT receipts in `paid_on` order. Zoho payments become `other` with provider `zohopay` and the Zoho payment id.
  - The ledger is posted explicitly, with the same entries that issue and payment post.
  - Invoices where a later instalment was paid before an earlier one are reported, not changed (D-015 shows them FIFO).
- **Old Zoho links.** They become `payment_links` rows:
  - Paid links are tied to their payment and dated by `paid_on`.
  - Unpaid links stay **active** at Zoho and in LexForgeX. They are not cancelled at cutover, so the webhook keeps recording them.
- **No emails on import.** The history emits no invoice or payment events. Each open invoice gets one `INVOICE_CREATED` with `imported: true`. The engine then plans only future date-relative reminders and links: immediate workflows are skipped, and times already past are dropped. The old email log becomes "Email sent (previous app)" timeline entries.
