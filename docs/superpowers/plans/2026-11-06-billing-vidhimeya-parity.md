# Billing: Vidhimeya parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the following to LexForgeX billing, for every firm, then import Vidhimeya's data from the old app:
- instalment schedules with auto-sent per-instalment payment links
- signatories
- DSC-signed PDFs
- server-generated PDFs attached to emails
- bank and letterhead details
- simple-mode revisions
- client salutation and CC
- issue-without-sending
- configurable number width

**Architecture:** Everything extends the existing billing, online-payments, workflows and notifications modules in `apps/api`.
- One migration (`0017`) adds every table and column, and relaxes the invoice guards for simple-mode invoices only.
- Instalment paid status is **derived** from active allocations in `seq` order. There is no new allocation table.
- PDFs are generated on demand with `pdf-lib` and attached at send time from references stored on the notification.

**Tech Stack:** Express 5 + TypeScript, Postgres 16 (raw `pg` + `sql` tag), zod v4, vitest + supertest, React 19 + TanStack Query, `pdf-lib` + `@pdf-lib/fontkit`, nodemailer, `@aws-sdk/client-sesv2`.

**Spec:** `docs/superpowers/specs/2026-11-06-billing-vidhimeya-parity-design.md`. Read it first. Section numbers below (§1–§10) refer to it.

## Global Constraints

- **Never `git commit`.** The user commits. Each task ends with a checkpoint: run the tests, then stop for review.
- **Branch:** `feature/billing-parity`, created from `main` (`ba758f7` or later) inside `legal-ops/`.
- **Migration:** a single new file, `packages/db/migrations/0017_billing_parity.sql`. Every new tenant table uses composite FKs on `(organization_id, …)` and is added to the `updated_at` trigger loop where it has `updated_at`.
- **Permissions and switches:** every new route sits behind the `billing` feature switch (existing middleware) and the existing permissions:
  - reads: `billing.view`
  - invoice changes, DSC, send: `invoices.manage`
  - payments: `payments.record`
  - own signature: any member
  - other members' signatures: `users.manage`
- **GST-mode invoices stay fully immutable after issue.** The DB trigger must refuse any change to them.
- **Instalments:** 2–24 per invoice, amounts sum exactly to `total_amount`, due dates strictly increasing, last due date = `invoices.due_date`.
- **Times:** instalment link emails and per-instalment reminders run at **10:00** firm time.
- **Instalment link workflow:** "send payment link" runs 3 days before each instalment's due date, except instalment 1, which goes with the invoice email.
- **Size limits:**
  - signature image: PNG/JPG, ≤ 500 KB
  - DSC PDF: ≤ 10 MB
  - CC emails: ≤ 5 per client
  - invoice number digits: 3–8, default 6
- **DSC check:** port of `vidhimeya-invoice/src/server/invoices.ts:354-356`. The file must start `%PDF`, contain `/ByteRange`, and contain `/adbe.pkcs7` or `/ETSI.CAdES` (prefix match).
- **Money:** integer paise in code, via the `toPaise`/`fromPaise` helpers in `@legalops/validation`.
- **Production box is a t3.micro:** no headless Chrome. `pdf-lib` only.
- **₹ must render:** embed Noto Sans Regular and Bold TTFs, committed under `apps/api/assets/fonts/` (OFL licence file alongside).

## Review Focus

1. **Payment between scheduling and sending.** A manual payment that covers an instalment after its link email was planned but before it runs: the executor must skip, not email a stale link. Test in Task 6.
2. **Revision against a paid instalment.** A revision that changes the amount or due date of a fully paid instalment must be refused (409), even when the total stays the same. Test in Task 11.
3. **Two people press "Send now" together.** Two concurrent "Send now" calls on one instalment must give one active Zoho link, never two. The unique index plus cancel-on-conflict, as in `createInvoicePaymentLink`. Test in Task 5.
4. **Odd DSC files.** A DSC upload that is a valid PDF without a signature, or a signed PDF over 10 MB, must be refused with a clear 422, with nothing stored. Test in Task 8.
5. **Re-running the importer** on a firm that already has issued invoices must refuse and write nothing. Test in Task 14.

---

### Task 1: Migration 0017 and DB invariants

**Files:**
- Create: `packages/db/migrations/0017_billing_parity.sql`
- Modify: `packages/db/tests/invariants.sql` (append checks)

**Interfaces:**
- Produces the schema every later task relies on.
- **New table `invoice_instalments`:**
  - `id uuid pk`, `organization_id`, `invoice_id`
  - `seq int`, `amount numeric(14,2) > 0`, `due_date date`
  - `emailed_at timestamptz`, `created_at`, `updated_at`
  - `UNIQUE(invoice_id, seq)`
  - FK `(organization_id, invoice_id)` → invoices, `ON DELETE CASCADE` (drafts only)
- **`payment_links`:**
  - Add `+ instalment_id uuid NULL`, with FK to `invoice_instalments(organization_id, id)`.
  - Drop `uq_payment_links_one_active`.
  - Add `uq_payment_links_active_instalment ON (instalment_id) WHERE status='active' AND instalment_id IS NOT NULL`.
  - Add `uq_payment_links_active_invoice ON (invoice_id) WHERE status='active' AND instalment_id IS NULL`.
- **`organization_members`:**
  - `+ designation varchar(120) NOT NULL DEFAULT 'Authorized Signatory'`
  - `+ signature_key text`, `+ signature_type varchar(20)`
- **`invoices`:**
  - Signatory snapshot: `signatory_user_id uuid`, `signatory_name`, `signatory_designation`, `signatory_signature_key`, `sign_with_image boolean NOT NULL DEFAULT false`
  - Revisions: `revision int NOT NULL DEFAULT 0`, `revised_at timestamptz`
  - Sending: `sent_at timestamptz`
  - Import: `prenumbered boolean NOT NULL DEFAULT false`
- **New table `invoice_signed_documents`:**
  - `id`, `organization_id`, `invoice_id`, `revision int`
  - `storage_key`, `size_bytes`, `uploaded_by`, `uploaded_at`, `superseded_at`
  - Partial unique index: one active row per invoice where `superseded_at IS NULL`.
- **`organizations`:**
  - `+ registration_label varchar(30)`, `+ registration_value varchar(60)`
  - `+ bank_account_name`, `bank_account_number`, `bank_ifsc`, `bank_name`, `bank_branch`, `upi_id` (all nullable)
  - `+ invoice_number_digits int NOT NULL DEFAULT 6 CHECK (3..8)`
- **`clients`:**
  - `+ salutation varchar(10) CHECK IN ('Mr','Ms','Mrs','Dr','Adv','M/s')`
  - `+ title varchar(120)`, `+ contact_person varchar(255)`
  - `+ cc_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality ≤ 5)`
- **`notifications`:**
  - `+ attachments jsonb NOT NULL DEFAULT '[]'`
  - `+ cc text[] NOT NULL DEFAULT '{}'`
- **`ledger_entries.entry_type` CHECK:** add `'invoice_revised'`.
- **`guard_invoice_mutation` / `guard_invoice_item_mutation`:**
  - Allow changes when `OLD.status = 'issued' AND OLD.tax_mode = 'simple'` to: subtotal, discount_amount, tax_amount, total_amount, items, due_date, notes, revision, revised_at.
  - Everything else stays as today; GST rows are unchanged.
  - Allow `DELETE` of a draft only when `prenumbered = false`.
  - Allow a pre-numbered draft to keep its `invoice_number` when it moves to issued.
- **System email templates** (`organization_id NULL`):
  - Insert `instalment_payment_link` (client) and `invoice_updated` (client).
  - Update the client-facing system templates to open with `{{client.greeting}},`, following the pattern of migration `0009`.
- **Default workflows:** seeded in code (Task 6), not here.

- [ ] **Step 1: Append invariant checks to `invariants.sql`.** Each check expects the error:
  - `gst_issued_invoice_total_frozen`: updating `total_amount` of an issued GST invoice raises `restrict_violation`.
  - `simple_issued_invoice_total_editable`: the same update on a simple invoice succeeds.
  - `simple_issued_invoice_number_frozen`: changing `invoice_number` of an issued simple invoice raises.
  - `prenumbered_draft_not_deletable`: deleting a draft with `prenumbered = true` raises.
  - `one_active_link_per_instalment`: a second active `payment_links` row for the same `instalment_id` raises `unique_violation`.
  - `one_active_signed_doc`: a second unsuperseded `invoice_signed_documents` row for the same invoice raises.
- [ ] **Step 2: Run them; expect failures** (missing tables/columns). Command: `pnpm --filter @legalops/db reset && pnpm --filter @legalops/db test`.
- [ ] **Step 3: Write `0017_billing_parity.sql`** per the Interfaces block. The template HTML follows the existing system templates' style. Use variables only from the Task 7 list: `client.greeting`, `instalment.*`, `links.pay`, `firm.bank_details_html`.
- [ ] **Step 4: Run the DB tests; expect a pass.** Same command, all invariant checks green, including the original ones.
- [ ] **Step 5: Run `pnpm --filter @legalops/api test`; expect the existing suites to still pass.** This proves the trigger changes don't break current billing.
- [ ] **Step 6: Checkpoint.** Stop for review; no commit.

### Task 2: Shared types and validation

**Files:**
- Modify: `packages/types/src/dtos.ts`, `packages/types/src/workflows.ts`, `packages/validation/src/billing.ts`, `packages/validation/src/clients.ts` (or wherever `createClientSchema` lives), `packages/validation/src/organization.ts` (or wherever the firm-settings schema lives)
- Test: `packages/validation/src/billing.test.ts` (create if absent)

**Interfaces (produces):**
- `instalmentInputSchema = z.object({ amount: positiveMoneySchema, dueDate: isoDate }).strict()`
- `createInvoiceSchema` and `updateInvoiceSchema`:
  - add `instalments: z.array(instalmentInputSchema).min(2).max(24).optional()`
  - a refine: due dates strictly increasing
  - The sum = total check is server-side, because the total is computed there.
- `issueInvoiceSchema`: add `sendToClient: z.boolean().default(true)`, `signatoryUserId: uuidSchema.optional()`, `signWithImage: z.boolean().default(false)`.
- `reviseInvoiceSchema = updateInvoiceSchema.and(z.object({ notifyClient: z.boolean().default(false) }))`
- Client schema: `salutation` (enum or null), `title`, `contactPerson`, `ccEmails: z.array(emailSchema).max(5).default([])`.
- Firm settings schema:
  - `registrationLabel`, `registrationValue`
  - `bankAccountName`, `bankAccountNumber` (`/^\d{6,18}$/`), `bankIfsc` (`/^[A-Z]{4}0[A-Z0-9]{6}$/`, uppercased before the check), `bankName`, `bankBranch`, `upiId`
  - `invoiceNumberDigits` (int 3–8)
- DTOs:
  - `InstalmentDto = { id, seq, amount, dueDate, paid, remaining, status: 'paid'|'part_paid'|'due'|'overdue', emailedAt, activeLink: PaymentLinkDto | null }`
  - `InvoiceDetailDto` adds:
    - `instalments: InstalmentDto[]`
    - `signatory: { userId, name, designation, withImage } | null`
    - `revision`, `revisedAt`, `sentAt`
    - `signedDocument: { uploadedAt, uploadedBy, sizeBytes } | null`
    - `canRevise: boolean`
  - `ClientDto` and `OrganizationDto` add the new fields.
  - `MemberDto` adds `designation` and `hasSignature`.
- `WorkflowAnchor` adds `'instalment.due_date'`.

- [ ] **Step 1: Write the failing tests:**
  - `instalments must have increasing due dates` (`['2026-12-01','2026-11-01']` → error at `instalments.1.dueDate`)
  - `rejects 1 instalment` and `rejects 25 instalments`
  - `IFSC lowercase is normalised and accepted` (`'hdfc0001234'` → `'HDFC0001234'`)
  - `IFSC with wrong 5th char rejected` (`'HDFC1001234'`)
  - `ccEmails max 5`
  - `invoiceNumberDigits 2 and 9 rejected`
- [ ] **Step 2: Run `pnpm --filter @legalops/validation test`; expect a fail.**
- [ ] **Step 3: Implement the schemas and DTO types above.**
- [ ] **Step 4: Run `pnpm --filter @legalops/validation test && pnpm -r typecheck`.** Validation passes. Typecheck errors are allowed only in `apps/api` and `apps/web` where DTOs are now incomplete; later tasks fix those. Do not stub around them.
- [ ] **Step 5: Checkpoint.**

### Task 3: Firm settings, client fields, number width

**Files:**
- Modify:
  - `apps/api/src/modules/organizations/organizations.service.ts`
  - `apps/api/src/modules/clients/clients.service.ts`
  - `apps/api/src/modules/billing/numbering.ts`
  - `apps/api/src/modules/billing/invoices.service.ts` (the `nextDocumentNumber` call in `issueInTx`)
  - `apps/api/src/modules/notifications/context.ts`
- Test: `apps/api/test/billing-parity-settings.test.ts`

**Interfaces:**
- `nextDocumentNumber(db, orgId, kind, date, prefix, digits = 6)`. The invoice call site passes `org.invoice_number_digits`; receipts and credit notes keep 6.
- Context vars:
  - `client.greeting` = `Dear {salutation} {contact_person ?? name}`, or `Dear {contact_person ?? name}` when there is no salutation.
  - `firm.bank_details_html`: an escaped HTML block, or `''` when no bank details are set.
  - `firm.registration_line`: e.g. `LLPIN: ADB-8169`.

- [ ] **Step 1: Write the failing tests:**
  - `PATCH /organization stores bank details and returns them` (IFSC normalised).
  - `invoice numbers use the firm's digit width`: set 3, issue two invoices, expect `LGL/2026-27/001` and `/002` (use `fiscalYear(today)`).
  - `client salutation/contact/cc round-trip`.
  - `client.greeting renders "Dear Mr Raj Sharma"`: call `buildContext` directly.
- [ ] **Step 2: Run `pnpm --filter @legalops/api vitest run test/billing-parity-settings.test.ts`; expect a fail.**
- [ ] **Step 3: Implement** the service, routes and context changes above.
- [ ] **Step 4: Run the file plus `test/billing.test.ts`; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 4: Instalments on draft, issue and read

**Files:**
- Create: `apps/api/src/modules/billing/instalments.ts`
- Modify: `apps/api/src/modules/billing/invoices.service.ts` (`createInvoice`, `updateDraft`, `getInvoice`, `issueInTx`)
- Test: `apps/api/test/instalments.test.ts`

**Interfaces (produces):**
- `writeInstalments(db, orgId, invoiceId, instalments: {amount: string; dueDate: string}[] | undefined, totalPaise: number): Promise<void>`
  - Replaces the rows.
  - `undefined` or `[]` deletes them.
  - Throws `validationError('Instalments must add up to the invoice total', [{path:'instalments', …}])` when the sum ≠ total.
  - Sets `invoices.due_date` to the last instalment's date.
- `instalmentStatus(db, invoiceId, today: string): Promise<InstalmentDto[]>`. The derived algorithm:
  ```
  covered = sum(active allocations to the invoice, including TDS)
  for each instalment in seq order:
    paid = min(amount, covered); covered -= paid
    remaining = amount - paid
    status = remaining == 0 ? 'paid' : paid > 0 ? 'part_paid' : dueDate < today ? 'overdue' : 'due'
    if status == 'part_paid' and dueDate < today: status = 'overdue'
  ```
- `getInvoice` fills `instalments` (with `activeLink` from `payment_links` where `instalment_id` matches and the status is active).
- `issueInTx` re-validates sum = total against the totals recomputed at issue.

- [ ] **Step 1: Write the failing tests:**
  - `draft with 3 instalments summing to total saves; due_date = last`
  - `instalments not summing to total → 422 at instalments`
  - `partial payment of 1.5 instalments → [paid, part_paid, due]` (record payment via `/payments`)
  - `instalment past due and unpaid → overdue`
  - `invoice without instalments → instalments: []` (unchanged behaviour)
  - `issue re-checks the sum`: edit the items so the total changes without changing the instalments, then issue → 422
- [ ] **Step 2: Run the file; expect a fail.**
- [ ] **Step 3: Implement** `instalments.ts` and wire it into the service.
- [ ] **Step 4: Run the file and `test/billing.test.ts`; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 5: Per-instalment payment links and "Send now"

**Files:**
- Modify:
  - `apps/api/src/modules/online-payments/payment-links.service.ts`
  - `apps/api/src/modules/billing/billing.routes.ts`
- Test: extend `apps/api/test/online-payments.test.ts` (reuse its `fakeZoho`)

**Interfaces (produces):**
- `ensureInstalmentLink(deps, orgId, instalmentId, actorUserId, fetchImpl = fetch): Promise<PaymentLinkDto | null>`
  - Returns `null` when Zoho is not enabled, or the instalment has nothing remaining.
  - Reuses an active link whose `amount` equals the remaining amount.
  - Otherwise cancels the active link (at Zoho, then marks it `canceled`) and creates a new one for the remaining amount.
  - On unique violation, cancels the Zoho link it just created and returns the existing one.
- `sendInstalmentNow(deps, ctx, invoiceId, seq, meta): Promise<{ notificationId: string }>`
  - Requires the invoice `issued` with `sent_at` set, and the instalment not paid.
  - Creates the notification for template `instalment_payment_link` (Task 7 attaches the PDF).
  - Idempotency key `send-now:${requestId}`.
  - Sets `emailed_at` when queued.
- Route: `POST /invoices/:invoiceId/instalments/:seq/send` (`invoices.manage`).
- `createInvoicePaymentLink` (existing route): refuse with 409 for invoices that have instalments: "Use the instalment's link".

- [ ] **Step 1: Write the failing tests:**
  - `ensureInstalmentLink creates a link for the remaining amount` (after a part payment: remaining, not the full amount)
  - `reuses an active link with the same amount`, so Zoho is called once
  - `amount changed → old link cancelled at Zoho, new link created`, which shows in `zoho.calls`
  - `two concurrent ensureInstalmentLink calls → one active row` (`Promise.all`)
  - `send now on a paid instalment → 409`
  - `webhook payment on an instalment link records the payment and the instalment shows paid`
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the file; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 6: Issue options, Send, and per-instalment scheduling

**Files:**
- Modify:
  - `apps/api/src/modules/billing/invoices.service.ts` (`issueInTx` options; new `sendInvoice`)
  - `apps/api/src/modules/billing/billing.routes.ts`
  - `apps/api/src/modules/workflows/engine.ts` (`targetOf`, `anchorDate`, `stillValid`, `planForEvent`)
  - `apps/api/src/modules/workflows/defaults.ts`
  - `apps/api/src/modules/notifications/context.ts` (`instalment.*` refs)
  - `packages/types/src/workflows.ts` (`TRIGGER_ANCHORS`: `INVOICE_CREATED` also allows `instalment.due_date`)
- Test: `apps/api/test/instalment-automation.test.ts` (copy the `CaptureEmail` + `tick` pattern from `test/automation.test.ts`)

**Interfaces:**
- `issueInTx(…, opts: { sendToClient: boolean; signatoryUserId?: string; signWithImage: boolean })`:
  - Accepts all three options now, but only `sendToClient` is acted on here. Task 9 adds the signatory snapshot inside `issueInTx`.
  - Sets `sent_at = now()` when `sendToClient` is true.
  - Emits `INVOICE_CREATED` with `sendToClient` in the payload.
- `sendInvoice(deps, ctx, id, meta)`:
  - Requires `issued`.
  - Sets `sent_at`.
  - Emits `INVOICE_CREATED` again with `sendToClient: true` and a `dedupeKey` of `INVOICE_SENT:${id}:${Date.now()}`.
  - Route: `POST /invoices/:id/send`.
- **Engine:**
  - For `INVOICE_CREATED` with `payload.sendToClient === false`: plan nothing.
  - For invoice events where the invoice has instalments, workflows anchored on `invoice.due_date` or `instalment.due_date` are planned **once per instalment**:
    - target type `instalment`, target id = instalment id
    - anchor = the instalment's due date
    - refs include `invoiceId` and `instalmentId`
  - Idempotency keys stay `${wf}:${i}:${targetType}:${targetId}:${anchor}`, so a re-send doesn't duplicate reminders.
  - `stillValid` for target `instalment`: the invoice is `issued`, the instalment still exists with an unchanged due date, and its remaining amount > 0.
- **Defaults:**
  - New `instalment_link_3d`: trigger `INVOICE_CREATED`, `rel('instalment.due_date', -3, '10:00')`, notify client `instalment_payment_link`, condition `instalment.seq > 1`.
  - `invoice_due_3d` gets the condition `instalment.count` `is_empty`, so it is skipped for instalment invoices; the link email replaces it.
  - Add both to `ensureDefaultWorkflows` / `ensureDefaultsOnce` so existing firms get them. For existing firms, also patch the `invoice_due_3d` condition via `system_key`.
- The executor's notify step, for template `instalment_payment_link` or `invoice_issued` on an instalment invoice, calls `ensureInstalmentLink` before rendering, so `links.pay` is fresh.

- [ ] **Step 1: Write the failing tests:**
  - `issue with sendToClient=false sends nothing and plans nothing; POST /send then emails the invoice with instalment 1's link`
  - `3 instalments → link emails for #2 and #3 at due-3 10:00 IST; none for #1`, using the `ist()` helper and `tick` at each time
  - `instalment #2 fully paid by a manual payment before its run time → skipped, no email`
  - `instalment overdue reminders are per instalment`: +3 days after #1's due date → one reminder about #1
  - `invoice without instalments behaves exactly as before`: re-run one key assertion from `automation.test.ts`
  - `pressing Send twice re-sends the invoice email but does not duplicate scheduled reminders`
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run this file and `test/automation.test.ts`; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 7: Server PDF generation

**Files:**
- Create:
  - `apps/api/src/modules/billing/pdf/invoice-pdf.ts`
  - `apps/api/src/modules/billing/pdf/receipt-pdf.ts`
  - `apps/api/src/modules/billing/pdf/layout.ts` (shared drawing helpers)
  - `apps/api/assets/fonts/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `OFL.txt`
- Modify: `apps/api/src/modules/billing/billing.routes.ts`; `apps/api/tsup.config.ts` (copy `assets/` into `dist`)
- Test: `apps/api/test/billing-pdf.test.ts`

**Interfaces (produces):**
- `renderInvoicePdf(deps, ctx, invoiceId): Promise<Buffer>`
- `renderReceiptPdf(deps, ctx, paymentId): Promise<Buffer>`
- `invoicePdfForSending(deps, orgId, invoiceId): Promise<{ filename: string; content: Buffer }>`
  - Returns the generated PDF. Task 8 changes it to prefer the active DSC document.
  - Filename: `Invoice-${number.replaceAll('/','-')}.pdf`.
- **Routes:**
  - `GET /invoices/:id/pdf` (`billing.view`): `Content-Type: application/pdf`, `Content-Disposition` via the existing `contentDisposition()`.
  - `GET /payments/:id/receipt.pdf`.
- **Content:** mirror `apps/web/src/features/billing/PrintPages.tsx`:
  - logo (via `storage.readObject`) and firm name, address and registration line
  - client block, using salutation and contact person
  - items and tax lines
  - totals
  - instalment schedule table, when there are instalments
  - bank box, when set
  - signatory block (name, designation, image if `sign_with_image`)
  - "Revision N · date" when `revision > 0`
  - "Powered by LexForgeX"
  - Use the `fontkit`-embedded Noto Sans.

- [ ] **Step 1: Write the failing tests.** Parse the output with `pdf-lib`'s `PDFDocument.load`; assert on the text with a tiny extractor, or `pdfjs-dist` if needed, as a dev dependency:
  - `invoice pdf contains the number, "₹50,000.00" and the client name`
  - `pdf includes the instalment schedule rows`
  - `pdf includes the bank IFSC when set`
  - `receipt pdf contains the receipt number`
  - `a lawyer not on the matter gets 404` (visibility)
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect a pass. Then run `pnpm --filter @legalops/api build` and confirm `dist/assets/fonts/*.ttf` exist.**
- [ ] **Step 5: Checkpoint.**

### Task 8: DSC-signed PDF upload

**Files:**
- Create:
  - `apps/api/src/modules/billing/signed-documents.service.ts`
  - `apps/api/src/modules/billing/dsc-check.ts`
- Modify: `billing.routes.ts`
- Test:
  - `apps/api/test/signed-documents.test.ts` (use `FakeDocumentStorage`)
  - `apps/api/src/modules/billing/dsc-check.test.ts`
- Fixtures:
  - `apps/api/test/fixtures/signed.pdf` (a small PDF with `/ByteRange` and `/SubFilter /adbe.pkcs7.detached`)
  - `apps/api/test/fixtures/unsigned.pdf`

**Interfaces (produces):**
- `looksDigitallySigned(buf: Buffer): boolean`
- `startSignedUpload(deps, ctx, invoiceId) → { uploadId, url }`
  - A signed PUT to `incoming/signed/<org>/<uuid>`.
  - Same pattern as `logo.service.ts`'s `startLogoUpload`.
- `completeSignedUpload(deps, ctx, invoiceId, uploadId, meta)`:
  - `readObject(key, 10 MB)`; an oversize file or a failed check → 422.
  - Copies to `signed/<org>/<invoiceId>/<revision>-<uuid>.pdf`.
  - Supersedes the previous active row.
  - Audits `invoice.signed_document_uploaded`.
- `removeSignedDocument(deps, ctx, invoiceId, meta)` sets `superseded_at`.
- `activeSignedDocument(db, invoiceId)`. This task changes Task 7's `invoicePdfForSending` and `GET /invoices/:id/pdf` to return the signed bytes when one exists.
- **Routes:**
  - `POST /invoices/:id/signed-document/uploads`
  - `POST /invoices/:id/signed-document/uploads/:uploadId/complete`
  - `DELETE /invoices/:id/signed-document`
  - all `invoices.manage`

- [ ] **Step 1: Write the failing tests:**
  - `signed fixture accepted; GET /pdf now returns the signed bytes`
  - `unsigned PDF → 422 "This PDF has no digital signature", nothing stored`
  - `non-PDF bytes → 422`
  - `>10 MB → 422`
  - `uploading again supersedes the first`
  - `draft invoice → 409` (only issued invoices)
  - `dsc-check unit: true for signed.pdf, false for unsigned.pdf, false for "hello"`
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 9: Signatories

**Files:**
- Create: `apps/api/src/modules/organizations/signature.service.ts`
- Modify:
  - `organizations.routes.ts` (member routes)
  - `invoices.service.ts` (`snapshotSignatory`)
- Test: `apps/api/test/signatories.test.ts`

**Interfaces (produces):**
- Signature upload: `startSignatureUpload(deps, ctx, userId, contentType)` / `completeSignatureUpload(deps, ctx, userId, uploadId, meta)` / `removeSignature`.
  - Same staging-then-check flow as the logo.
  - PNG/JPG by magic bytes, ≤ 500 KB.
  - Final key `signatures/<org>/<userId>/<uuid>.<ext>`.
  - A member may act on themselves; acting on others needs `users.manage`.
- `PATCH /organization/members/:memberId` accepts `designation` (self or `users.manage`).
- `snapshotSignatory(db, orgId, userId | undefined, issuerId, withImage): Promise<SnapshotColumns>`, called from `issueInTx` (Task 6 already passes `signatoryUserId` and `signWithImage` through).
  - Default signatory: the issuer if they have a designation, else the matter lead.
  - Copies the current `signature_key` value (the object is never deleted while referenced, so removing a signature only clears the member's pointer).
  - If `withImage` is true and there is no signature → 422.
- `GET /organization/members/:memberId/signature` streams the image for the web preview (members of the firm only).

- [ ] **Step 1: Write the failing tests:**
  - `member uploads own signature; GET returns it`
  - `lawyer cannot upload for another member → 403; owner can`
  - `500 KB+1 → 422; GIF → 422`
  - `issue with signatory and image snapshots name/designation/key; changing the designation later doesn't change the invoice`
  - `withImage when the signatory has no signature → 422`
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 10: Email attachments and CC

**Files:**
- Modify:
  - `apps/api/src/modules/notifications/providers.ts` (`EmailMessage`, SMTP, SES)
  - `channels.ts`
  - `notifications.service.ts` (`createNotification` stores `attachments` + `cc`; `sendNotification` builds them at send time)
- Test: extend `apps/api/test/instalment-automation.test.ts`; add `providers.test.ts` for SES message building

**Interfaces:**
- `EmailMessage` adds `cc?: string[]` and `attachments?: { filename: string; contentType: string; content: Buffer }[]`.
- `CreateNotificationInput` adds `attachments?: NotificationAttachmentRef[]`, where `NotificationAttachmentRef = { kind: 'invoice_pdf'; invoiceId: string } | { kind: 'receipt_pdf'; paymentId: string }`.
  - Client recipients automatically get `cc = clients.cc_emails`.
- **Attachment refs are set automatically** in `createNotification` when the template key is one of `invoice_issued`, `invoice_updated`, `instalment_payment_link`, `invoice_reminder` (`invoice_pdf`) or `payment_received` (`receipt_pdf`), and the ref ids are present. No caller changes are needed.
- `sendNotification` resolves the refs through `invoicePdfForSending` and `renderReceiptPdf` (`ctx` = system owner context, as in the workflow executor's `systemActor`).
- **SES:** if the installed `@aws-sdk/client-sesv2` `SendEmailCommand` accepts `Content.Simple.Attachments`, use it; otherwise build MIME with `nodemailer/lib/mail-composer` and send `Content.Raw.Data`. Add CC via `Destination.CcAddresses`.
- **SMTP:** nodemailer `attachments` + `cc`.

- [ ] **Step 1: Write the failing tests:**
  - `invoice email carries Invoice-LGL-…pdf attachment and the client's CC addresses` (`CaptureEmail` records `attachments`/`cc`)
  - `with a DSC upload, the attachment is the signed bytes`
  - `receipt email attaches receipt pdf`
  - `notifications row stores refs, not bytes`: `attachments` jsonb has no `content` key
  - SES unit: `SES message includes CC and one attachment`, by mocking the client's `send` and inspecting the command input
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run this test file, `test/automation.test.ts` and `test/online-payments.test.ts`; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 11: Simple-mode revisions

**Files:**
- Create: `apps/api/src/modules/billing/revisions.service.ts`
- Modify:
  - `billing.routes.ts`
  - `apps/api/src/modules/billing/ledger.ts` (add the `'invoice_revised'` entry type)
  - `apps/api/src/modules/workflows/engine.ts` (`INVOICE_REVISED`: cancel pending instalment/invoice actions whose anchor changed, then replan, like `HEARING_CHANGED`)
- Test: `apps/api/test/revisions.test.ts`

**Interfaces (produces):**
- `reviseInvoice(deps, ctx, id, input: z.output<typeof reviseInvoiceSchema>, meta): Promise<InvoiceDetailDto>`
  - Route: `PATCH /invoices/:id/revision` (`invoices.manage`).
- **Refusals (409 unless noted):**
  - the firm or the snapshot `tax_mode` is `gst`: "GST invoices can't be edited; issue a credit note"
  - the status isn't `issued`
  - new total < allocated: 422
  - a fully paid instalment's amount or due date changes (matched by `seq`)
- **Effects, in one transaction:**
  - Recompute totals with the existing `prepareDraft` / `computeInvoiceTotals`.
  - Rewrite the items and instalments.
  - `revision + 1`, `revised_at`.
  - Ledger delta: `postLedger` with `invoice_revised`, debit AR/credit fee revenue for an increase, the reverse for a decrease. Tax delta likewise to `gst_output` (simple-mode tax).
  - Cancel active links whose amount ≠ the new remaining amount (at Zoho and in the DB).
  - Reset `emailed_at` on instalments whose due date changed.
  - Supersede the active DSC document.
  - Timeline, audit (before/after), and emit `INVOICE_REVISED` with `{ invoiceId, notifyClient }`.
  - If `notifyClient`: create an `invoice_updated` notification.
- `getInvoice` sets `canRevise = (tax_mode === 'simple' && status === 'issued' && can(invoices.manage))`.

- [ ] **Step 1: Write the failing tests:**
  - `GST firm → 409 and the DB is unchanged`
  - `simple firm: total 50,000 → 60,000; revision=1; AR balance and v_invoice_balances show 60,000 minus paid`
  - `decrease below the paid amount → 422`
  - `changing a paid instalment → 409; changing an unpaid one → ok`
  - `instalment due date moved → old link-email action cancelled, new one planned at new due-3 10:00`
  - `notifyClient sends invoice_updated with the PDF showing "Revision 1"`
  - `active DSC document superseded after revision`
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run this file plus `billing.test.ts` and `instalment-automation.test.ts`; expect a pass.**
- [ ] **Step 5: Checkpoint.**

### Task 12: Web — settings, clients, members

**Files:**
- Modify:
  - `apps/web/src/features/settings/FirmSettingsPage.tsx` (a "Letterhead & bank details" card; invoice number digits, shown to owners only)
  - `apps/web/src/features/clients/ClientFormSheet.tsx` (salutation select, title, contact person, CC emails as a chip input, max 5)
  - `apps/web/src/features/settings/MembersPage.tsx` (designation, signature upload/remove per member; "My signature" for self)
- Create: `apps/web/src/features/settings/SignatureCard.tsx` (pattern: `LogoCard.tsx`)

**Interfaces:** consumes the Task 3 and Task 9 routes.

- [ ] **Step 1: Implement the three screens** following the existing card and sheet patterns. Every grid gets `grid-cols-1` at mobile width.
- [ ] **Step 2: Run `pnpm --filter @legalops/web typecheck && pnpm lint`; expect a pass.**
- [ ] **Step 3: Browser check** (`preview_start` `legalops-web` + `legalops-api`, mobile 375×812 and desktop):
  - Save bank details: an invalid IFSC shows a field error, a valid one saves.
  - Add a client with salutation and 2 CCs.
  - Upload a signature PNG and see the preview.
  - Take a screenshot of each.
- [ ] **Step 4: Checkpoint.**

### Task 13: Web — invoice editor, issue, detail, print

**Files:**
- Modify:
  - `apps/web/src/features/billing/InvoiceEditorPage.tsx` (a "Pay in instalments" toggle; schedule editor with "Split equally into N, monthly" and "Custom"; running sum vs total; revision mode when opened from "Edit invoice", with a "Notify client" checkbox)
  - `InvoiceDetailPage.tsx`:
    - issue sheet with signatory picker, a "Print scanned signature" toggle, and "Issue now, send later"
    - "Send invoice" button when `sentAt` is null; "Send again?" confirm otherwise
    - instalments card: amount, due, status badge, emailed, "Send now", "Copy link"
    - DSC card: download PDF, upload signed PDF, "Digitally signed" badge, remove
    - "Edit invoice" when `canRevise`
  - `PayOnlineCard.tsx`: hidden when `instalments.length > 0`
  - `PrintPages.tsx`: the same additions as the PDF (schedule, bank box, signatory, revision line, registration line)
- Create: `apps/web/src/features/billing/InstalmentsCard.tsx`, `SignedDocumentCard.tsx`, `IssueSheet.tsx`

**Interfaces:** consumes the routes from Tasks 4–11.

- [ ] **Step 1: Implement.** The equal split puts the remainder paise on the **last** instalment.
- [ ] **Step 2: Run the typecheck and lint; expect a pass.**
- [ ] **Step 3: Browser check end to end, with Mailpit running:**
  1. Create an invoice for ₹90,000 with 3 monthly instalments.
  2. Issue it with "send later". Confirm no email arrives.
  3. Upload `test/fixtures/signed.pdf`.
  4. Press Send. Mailpit shows one email with the signed PDF attached and the CC.
  5. Use the dev tick `POST /api/v1/dev/worker/tick` at instalment #2 due−3 10:00 IST. Mailpit shows the #2 link email.
  6. In a simple-mode firm, edit the invoice. The print page shows "Revision 1".
  7. Take screenshots.
- [ ] **Step 4: Checkpoint.**

### Task 14: Vidhimeya importer

**Files:**
- Create:
  - `apps/api/src/scripts/import-vidhimeya.ts`
  - `apps/api/src/scripts/vidhimeya/{read-export.ts,map.ts,report.ts}`
  - `apps/api/test/fixtures/vidhimeya-export.sql`: a small D1 export built from `vidhimeya-invoice/migrations/*.sql` plus inserts, covering:
    - 3 clients (one matching an existing LexForgeX client by email, case-insensitive)
    - invoices: sent, cancelled, draft, a one-instalment invoice, a 3-instalment invoice, and an invoice with no subject
    - payments: Zoho, bank, and one paid out of order
    - a signed PDF BLOB and a user with a signature BLOB
- Modify: `apps/api/package.json` (script `import:vidhimeya`), devDependency `better-sqlite3`
- Test: `apps/api/test/import-vidhimeya.test.ts`

**Interfaces (produces):**
- CLI: `pnpm --filter @legalops/api import:vidhimeya --export <file.sql> --org <orgId> --owner <userEmail> [--dry-run]`.
  - Loads the SQL into an in-memory SQLite DB via `better-sqlite3`.
- `importVidhimeya(deps, { exportPath, organizationId, ownerUserId, dryRun }): Promise<ImportReport>`
  - `ImportReport = { prefixes: string[]; clients: {created, matched}; invoices: {issued, void, draft}; perClient: {name, invoiced, paid, due, oldInvoiced, oldPaid, oldDue, ok}[]; outOfOrderInvoices: string[]; unmatchedSignatories: string[]; ok: boolean }`
- **Mapping and rules:** exactly as in spec §10, including:
  - one-instalment → no instalment rows
  - `zoho` → `payment_method 'other'` with `provider 'zohopay'` + `provider_payment_id`
  - old links → `payment_links` (paid / active)
  - receipt numbers via `nextDocumentNumber('receipt')` in `paid_on` order
  - the signatory image from the old `users` table
  - email log → timeline entries
  - `prenumbered = true` on drafts
  - `invoice_prefix` + `invoice_number_digits = 3`
  - `document_sequences` = max + 1 per FY
  - ledger entries via `postLedger`, as issue and payment do
- **Write path:** issued invoices are written with `status 'issued'` directly (not via `issueInTx`, which would draw new numbers); the ledger is posted explicitly. `INVOICE_CREATED` is **not** emitted, so no emails go out. Instalment scheduling for still-open invoices is planned by a final step that emits `INVOICE_CREATED` with `sendToClient: true` **only for future-dated actions**. The executor's stale-grace rule already skips past times. *Builder: if this would send an immediate "invoice issued" email, suppress that by passing `payload.imported = true` and having the engine skip `immediate`-timing workflows for imported events.*
- **Safety:**
  - Refuse (throw, write nothing) if the org has any issued invoice or any payment.
  - Everything happens in one transaction.
  - `dryRun` rolls back and returns the report.
  - The report fails (`ok=false`, exit code 1) on any per-client difference > ₹0.

- [ ] **Step 1: Write the failing tests:**
  - `dry run returns ok=true and writes nothing`
  - `real run: per-client invoiced/paid/due equal old; old numbers kept; next issued invoice continues e.g. VMA/2026-27/008`
  - `one-instalment invoice has no instalment rows; 3-instalment keeps 3`
  - `cancelled → void; pre-numbered draft can't be deleted (409) and keeps its number on issue`
  - `zoho payment has provider_payment_id; replaying the webhook for that link does not create a second payment`
  - `out-of-order payment listed in report.outOfOrderInvoices`
  - `no emails queued by the import` (the `notifications` count is unchanged)
  - `second run on the same org refuses and writes nothing` (Review Focus 5)
- [ ] **Step 2: Run; expect a fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the file and the full API suite: `pnpm --filter @legalops/api test`; expect all green.**
- [ ] **Step 5: Checkpoint.**

### Task 15: Cutover runbook and decisions

**Files:**
- Create: `docs/runbooks/vidhimeya-billing-cutover.md`
- Modify: `docs/decisions.md` (add D-0xx entries: instalments model, simple-only revisions, derived instalment status, attachment refs, importer rules)

- [ ] **Step 1: Write the runbook.** These are the spec §10 cutover steps 1–7 made concrete:
  - Exact commands: `wrangler d1 export vidhimeya-invoice --remote --output=…`, the import dry run, and the real run on the EC2 via `infra/scripts/compose.sh` run-tool.
  - The Zoho dashboard steps: list the active links, cancel the unpaid ones, change the webhook URL to `https://app.lexforgex.com/api/v1/webhooks/zohopay/<org>` (take the exact path from `webhooks.routes.ts`).
  - The spot-check list.
  - The 4-week read-only window, then deleting the Pages project, D1 and the cron Worker after archiving a final export.
- [ ] **Step 2: Run a final check:**
  - `pnpm -r typecheck && pnpm lint && pnpm --filter @legalops/db test && pnpm --filter @legalops/api test`
  - Expect: all green. Report the test counts.
- [ ] **Step 3: Checkpoint.** Hand back to the user to commit and open the PR.
