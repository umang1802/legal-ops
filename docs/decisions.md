# LegalOps — Decision Log

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
  - The baseline to beat is "manual calls/messages", so manual hearing entry in LegalOps is already an improvement, not a regression. Court sync stays out of V1.
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
