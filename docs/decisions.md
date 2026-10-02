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
