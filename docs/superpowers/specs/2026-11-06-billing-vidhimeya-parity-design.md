# Billing: Vidhimeya parity (instalments, signatories, DSC, PDF, revisions) and migration

Date: 2026-11-06 · Status: approved 2026-11-06

## Intent and the why

Vidhimeya uses a standalone invoicing app today: `Eduforgex/vidhimeya-invoice`, live at invoice.vidhimeyaadvisory.com. It runs on Cloudflare Pages + D1 and was built as a stopgap. The plan is to rebuild what makes that app useful inside LexForgeX billing, for every firm, not only for Vidhimeya. Then we test it, move Vidhimeya's data across, and retire the old app.

The order is: **build → test → migrate → retire**. The old app keeps working until the move is done and checked.

What Vidhimeya relies on, all of which LexForgeX must have:

1. One invoice split into an **instalment schedule**.
   - Only the instalment currently due is emailed, with its own payment link.
   - Each later instalment goes out automatically 3 days before it is due.
   - A "Send now" button sends any instalment early.
2. **Signatories.** A partner's name, designation and optional scanned signature are printed on the invoice.
3. **DSC-signed PDF.** A partner downloads the PDF, signs it with a DSC tool and uploads it back. From then on, that signed file is what goes out.
4. **A real PDF attached to invoice emails.**
5. **Letterhead and bank-transfer details** on the invoice.
6. **Editing a sent invoice**, with a printed revision number.
7. **Client salutation, title, contact person and CC emails**, used in email greetings.

## What exists today (do not rebuild)

These pieces are in `legal-ops` on `main`:

- **Billing core:**
  - Migration `0004`.
  - Services in `apps/api/src/modules/billing/`.
  - GST or simple tax mode per firm, with a tax snapshot on each invoice.
  - Gapless per-firm, per-FY numbering in `numbering.ts`, assigned **at issue**.
  - Payments with allocations across invoices, TDS and advances.
  - Credit notes, write-off, void.
  - An append-only ledger.
  - Balances from `v_invoice_balances`.
  - Fee agreements with milestones, where each milestone becomes a separate invoice. That model is unchanged; instalments are a different model.
- **DB guards** (`0001_init.sql`):
  - `guard_invoice_mutation` freezes the amounts, client, matter, number and issue date of non-draft invoices.
  - `guard_invoice_item_mutation` freezes the items of non-draft invoices.
- **Online payments** (Aakash, commit `348c25b`, migration `0016`):
  - Per-firm Zoho Payments config (`organization_payment_gateways`).
  - `payment_links` with **one active link per invoice** (`uq_payment_links_one_active`).
  - A webhook records a payment automatically.
  - `PayOnlineCard` in the web app.
- **Automations** (`modules/workflows`):
  - The default `invoice_issued` workflow emails the client immediately on `INVOICE_CREATED`.
  - Reminder workflows run at −3, 0, +3, +7 (with lead-lawyer escalation) and +15 (to partners) days around `invoice.due_date`. The executor skips paid or void invoices.
- **Email:**
  - Notifications are rendered from templates.
  - The firm layout and logo are applied at send time.
  - SES in production; SMTP to Mailpit in dev.
  - `EmailMessage` has **no attachments** yet.
- **Files:**
  - S3 storage (`integrations/storage`), used by documents and the firm logo.
  - The logo flow, a signed PUT to a staging key followed by a server-side check and copy, is the pattern to reuse for signature images.
- **Feature switches:** `billing` is one of the per-firm switches. Everything below lives under it.
- **Print pages:** invoice and receipt pages render in the browser only.

## Decisions made with the user

- **Instalments:** one invoice with an instalment schedule, the Vidhimeya way, not one invoice per instalment.
- **Editing sent invoices:** allowed **only for firms in simple-tax mode**. GST firms keep the current rule: no edits after issue, use a credit note.
- **Email:** sending from LexForgeX ("Firm via LexForgeX", SES) is fine. Firms do not need to send from their own mailbox. The Gmail-API sending of the old app is not carried over.
- **Migration numbering:** old invoices keep their numbers, and new LexForgeX invoices continue the same series.
- **Accepted guesses:**
  - Manual payments go to the earliest unpaid instalment first.
  - A fully paid instalment cannot be changed in an edit.
  - The logo plus firm details is enough as a letterhead, so no full-width letterhead image upload.
  - Editing an invoice that has a DSC-signed PDF sets that PDF aside; it must be signed and uploaded again.

## Goals

1. **Instalment schedule on any invoice**, in GST or simple mode.
2. **Signatories**, with name, designation and scanned signature frozen onto each invoice.
3. **DSC-signed PDF upload and verification.** Once uploaded, it replaces the generated PDF everywhere.
4. **Server-generated PDF** for invoices and receipts, attached to invoice, instalment, receipt and updated-invoice emails.
5. **Firm letterhead details and bank details** on PDFs and print pages.
6. **In-place revisions** of sent invoices for simple-tax firms.
7. **New client fields:** salutation, title, contact person, CC emails.
8. **Issue without sending**, so a DSC-signed PDF can be prepared before the client gets anything.
9. **Configurable invoice number width** (digits), so Vidhimeya's 3-digit series continues.
10. **One-off import** of Vidhimeya's data, a verification report, and a cutover procedure.

## Non-goals

- Sending from the firm's own Gmail or Google Workspace mailbox.
- Payment gateways other than Zoho Payments.
- Changing the fee-agreement/milestone model.
- Editing issued invoices for GST firms (the law requires a credit note).
- A full-width letterhead image.
- Moving Vidhimeya's Cloudflare/D1 infrastructure. The old app is only frozen and later retired.

## Anti-goals (failure even if it "works")

- **Any change to GST-mode invoice immutability.** The database must still refuse it.
- **A client is emailed twice for the same instalment, or emailed a link for an amount already paid.**
- **A Zoho payment made on an old app link at cutover is lost or double-counted.**
- **A gap or duplicate in Vidhimeya's invoice number series** after the move.
- **An emailed invoice whose content differs from what the firm signed.** Once a DSC PDF is uploaded, nothing else is sent.

## Design

### 1. Instalments

**Data:** new table `invoice_instalments`:
- `id`, `organization_id`, `invoice_id`
- `seq` (1..n, unique per invoice)
- `amount` (numeric(14,2) > 0)
- `due_date`
- `emailed_at`, `created_at`, `updated_at`
- Composite FKs on `(organization_id, invoice_id)`, like the other tenant tables.

**Rules:**
- An invoice with no instalment rows behaves exactly as today: one due date, one link.
- When there are instalments:
  - The amounts must sum to the invoice **total** (`total_amount`). That is the amount the client pays, net of RCM; the builder should confirm which column is the payable amount.
  - `invoices.due_date` = the last instalment's due date.
  - Due dates must be strictly increasing.
  - Between 2 and 24 instalments.
- Instalments are edited freely while the invoice is a draft. After issue, they can change only through a revision (section 6), so simple-tax firms only.

**Paid per instalment (derived, not stored):**
- Apply the invoice's allocated amount (from `payment_allocations`, active only, including TDS as today) to instalments in `seq` order.
- An instalment is *paid* when fully covered, *part-paid* when partly covered, and *overdue* when not fully covered after its due date.
- This makes "manual payments go to the earliest unpaid instalment" fall out naturally, with no new allocation table.
- Expose this as a view or a helper next to `v_invoice_balances`.

**Payment links:**
- Add a nullable `payment_links.instalment_id`.
- Replace `uq_payment_links_one_active` with:
  - one active link per instalment, when `instalment_id` is set;
  - one active link per invoice, when it is NULL.
- A link for an instalment is created for that instalment's **remaining** amount.
- When the remaining amount changes because of a manual payment or a revision, the active link is cancelled at Zoho and a new one is created at send time. Never send a stale amount.
- The webhook records the payment against the invoice as today. Because allocation is derived in `seq` order, nothing instalment-specific is needed there.

**Sending:**
- On issue (unless "issue without sending", see section 7):
  - The invoice email goes out with the PDF.
  - It shows the full schedule.
  - It carries a payment link for the **first unpaid instalment only**.
- **Send time** (*my call*): instalment link emails and per-instalment reminders go out at 10:00 firm time, the same as today's invoice reminders. `organizations.default_send_time` does not apply to them.
- New default workflow **"Instalment due in 3 days: send payment link"**:
  - Runs for every instalment except the first, 3 days before its due date at 10:00 firm time.
  - Skipped if that instalment is already paid.
- **"Send now"** on an instalment:
  - Sends it immediately with a fresh link.
  - Records `emailed_at`.
  - Idempotent per request.
- **Reminders:**
  - For invoices with instalments, the existing −3/0/+3/+7/+15 reminder workflows are anchored on **each instalment's** due date instead of `invoice.due_date`.
  - The existing −3 "due soon" reminder and the new "send payment link" workflow fall on the same day. For instalments they must be **one email**: the link email replaces the −3 reminder.
  - The builder decides how to express this in the engine, for example a new anchor `instalment.due_date` with target type `instalment`. Re-check guards at run time (instalment still unpaid, invoice still issued, due date unchanged).
- **Template:** new system template `instalment_payment_link`, plus variables:
  - `instalment.seq`, `instalment.count`, `instalment.amount`, `instalment.due_date`, `instalment.remaining`
  - `links.pay` (the payment link, when Zoho is configured)
  - `firm.bank_details_html`

**UI:**
- **Invoice editor:** a "Pay in instalments" toggle opens a schedule editor with presets "Split equally into N, monthly" and "Custom", and shows the running total vs the invoice total.
- **Invoice detail:**
  - An instalments card listing each instalment with its amount, due date, status, last emailed date, "Send now" and "Copy link".
  - The current `PayOnlineCard` covers invoices without instalments.

### 2. Signatories

**Data:**
- Add to `organization_members`: `designation` (default "Authorized Signatory") and `signature_key` / `signature_type`, pointing to a PNG or JPG in S3.
- Add to `invoices` a signatory snapshot, written at issue and on revision:
  - `signatory_user_id`, `signatory_name`, `signatory_designation`
  - `signatory_signature_key` (a copy or reference of the image as it was at issue, so later changes don't alter old invoices)
  - `sign_with_image` (boolean)

**Uploading a signature:**
- Same flow as the firm logo: a signed PUT to a staging key, then a server-side magic-byte check, then a size limit (≤ 500 KB), then a copy to the final key.
- A member manages their own designation and signature (Profile).
- Owners and admins can also do it for anyone (Team page).

**Choosing the signatory:**
- On issue or send, the default is the person issuing, if they have a designation; otherwise the matter lead.
- The issue dialog lets you pick any active member, and choose whether to print the scanned signature.

**Rendering:** in the bottom-right "For {firm}" block of the PDF and the print page.

### 3. DSC-signed PDF

**Data:** `invoice_signed_documents`:
- `organization_id`, `invoice_id`, `revision`
- `storage_key`, `size_bytes`, `uploaded_by`, `uploaded_at`
- `superseded_at` (set when a revision makes it stale)

**Upload and check:**
- PDF only, at most 10 MB, sent via a signed PUT to a staging key, then a server-side check.
- The check is a straight port of `vidhimeya-invoice/src/server/invoices.ts:354-356`: the file must start `%PDF`, contain `/ByteRange`, and contain `/adbe.pkcs7` or `/ETSI.CAdES` (a prefix match, as the old app does, so files from the DSC tools Vidhimeya already uses keep passing).
- This only checks that a digital signature is present. It does not validate the certificate chain; the builder can add that if cheap.

**Effect:**
- While an active (not superseded) signed document exists for the invoice's current revision, every email attachment and every "Download PDF" uses it instead of the generated PDF.
- The invoice detail shows a "Digitally signed" badge, with uploader and time.
- Who can upload, replace or remove it: `invoices.manage`.
- Every change is audited.

### 4. Server-generated PDF

- New module, for example `modules/billing/pdf/`. It generates the invoice and receipt PDFs on the server from the same data as the print pages. The layout should match `PrintPages.tsx` (logo, firm details, client block, items, tax lines, totals, schedule, bank box, signatory, "Powered by LexForgeX").
- **My call:** `pdf-lib` (pure JS, already proven in the Vidhimeya app), with an embedded Unicode TTF (for example Noto Sans) so **₹** prints correctly. The old app had to print "Rs." because it used standard fonts.
- PDFs are generated **on demand and not stored**, except DSC uploads. The invoice is immutable, or revision-numbered in simple mode, so regeneration is deterministic.
- **Endpoints:**
  - `GET /invoices/:id/pdf` returns the signed PDF if one exists, else the generated one.
  - `GET /payments/:id/receipt.pdf`
  - Both go through the existing billing visibility rules.
- **Email attachments:**
  - Extend `EmailMessage` with `attachments: {filename, contentType, content: Buffer}[]`.
  - SMTP: nodemailer supports this natively.
  - SES: the adapter must send attachments. Use SESv2 `SendEmail` with `Content.Simple.Attachments` if available in the installed SDK version; otherwise switch to `Content.Raw` with a MIME message built by nodemailer's MailComposer.
  - Attachments are built **at send time** from references stored on the notification. Use a new notification field, for example `attachments jsonb` = `[{kind:'invoice_pdf', invoiceId, revision}]`, so no PDF bytes are stored in `notifications`.
- **Templates that attach:**
  - `invoice_issued` and `invoice_updated` attach the invoice PDF.
  - `instalment_payment_link` and the invoice reminders attach the invoice PDF.
  - `payment_received` attaches the receipt PDF.

### 5. Letterhead details and bank details

- **Organization fields:**
  - Letterhead: `registration_label` and `registration_value`, for example "LLPIN" / "ADB-8169". GSTIN and PAN already exist.
  - Bank: `bank_account_name`, `bank_account_number`, `bank_ifsc`, `bank_name`, `bank_branch`, `upi_id`.
  - All are optional.
- **Firm settings:** a "Bank details for invoices" section, plus the registration line.
- **Rendering:**
  - The PDF and the print page show a "Pay by bank transfer" box whenever bank details are set.
  - Emails show it when the firm has no active Zoho config, or always as a secondary option. **My call:** always, as a secondary option.
- **Validation:** IFSC is 4 letters, then 0, then 6 alphanumerics. The account number is 6–18 digits.

### 6. In-place revisions (simple-tax firms only)

**Database:**
- Change `guard_invoice_mutation` and `guard_invoice_item_mutation` so that, for a non-draft invoice whose **snapshot `tax_mode = 'simple'`** and whose status is `issued`, these may change: subtotal, discount, `tax_amount` (simple mode can carry a flat tax), total and items, plus due date, notes and instalments.
- Add `invoices.revision` (int, default 0) and `revised_at`.
- **Still frozen:** the number, the issue date, client, matter and tax mode. GST-mode invoices stay fully frozen. Add `invariants.sql` checks for both.

**Service `reviseInvoice`:**
- Takes the same body as the draft edit, plus `notifyClient`.
- **Refused when:**
  - the firm's tax mode is GST, or the invoice snapshot is GST;
  - the status is not `issued`;
  - the new total is below the amount already allocated;
  - a fully paid instalment's amount or due date would change. Instalments are matched by `seq`.
- **Effects:**
  - `revision + 1` and `revised_at = now()`.
  - Post a ledger **adjustment** entry for the change in the receivable (append-only; never rewrite old entries). The builder should follow how credit notes post to the ledger.
  - Cancel active payment links whose amount is now wrong.
  - Reset `emailed_at` on instalments whose due date changed. Re-plan their scheduled actions; the existing cancel/replan pattern for `HEARING_CHANGED` is the model.
  - Mark any active DSC document as superseded.
  - Add a timeline entry and an audit entry with before and after.
  - Emit `INVOICE_REVISED`.
  - If `notifyClient`, queue the new `invoice_updated` email with the PDF.

**Print and PDF:** show "Revision N · {date}" under the invoice number when `revision > 0`.

**UI:** an "Edit invoice" button on issued invoices, for simple-tax firms only. It opens the editor with a "Notify client" checkbox.

### 7. Issue without sending

- The issue action gets an option **"Issue now, send later"**:
  - The invoice is numbered and issued.
  - No client email is queued. The `invoice_issued` workflow checks a flag on the event payload, for example `sendToClient: false`.
  - Instalment link and reminder scheduling start only when the invoice is sent.
- **"Send invoice" button:**
  - Queues the invoice email (with the signed PDF, if uploaded) and starts instalment scheduling.
  - Records `invoices.sent_at`.
  - It is not idempotent by design: a second press asks "Send again?".
- **Default:** issue and send together, as today.

### 8. Client fields

- **`clients`:**
  - `salutation`: Mr, Ms, Mrs, Dr, Adv, M/s, or none.
  - `title`: free text, for example "Director".
  - `contact_person`
  - `cc_emails`: up to 5 valid emails.
- **Greeting:**
  - A new template variable `client.greeting` = "Dear {salutation} {contact_person or name}", falling back to "Dear {name}".
  - The client-facing system templates use it; this needs a migration that updates the system template rows, like `0009`.
- **CC emails:** go on every client email that carries an invoice, receipt or instalment. The notification stores the CC list at creation.

### 9. Number width

- `organizations.invoice_number_digits` (int, 3–8, default 6).
- `nextDocumentNumber` uses it for invoices. Receipts and credit notes can use the same setting or keep 6. **My call:** invoices only.
- Set by the platform console or Firm settings (owner). Changing it never renumbers existing invoices.

### 10. Migration from vidhimeya-invoice

**Source:** the D1 database `babaadf7-…` in Vidhimeya's Cloudflare account, exported with `wrangler d1 export` to SQL. Signature images and signed PDFs are BLOBs in `users` and `invoice_documents`.

**Script:** `apps/api/src/scripts/import-vidhimeya.ts`.
- Reads the export, loaded into SQLite with `better-sqlite3`, or parsed JSON.
- Writes to a target firm id inside **one transaction**.
- Supports `--dry-run`, which produces the verification report without writing.

**Mapping:**
- **Clients:**
  - Name, email, phone and address map directly.
  - `cc_emails`, `contact_person`, `salutation` and `title` go to the new fields.
  - `notes` maps directly.
  - Match existing LexForgeX clients by email (case-insensitive) before creating new ones.
- **Matters:**
  - LexForgeX invoices need a matter.
  - **My call:** one matter per client per distinct invoice `subject`, titled with the subject.
  - Invoices without a subject go to a matter titled "Advisory: {client name}".
  - The matter lead is the firm owner.
- **Invoices:**
  - `number` is kept verbatim. `issue_date` maps directly. Tax mode is simple. Items map to `invoice_items`, with the amount as `unit_price`, quantity 1.
  - Signatory snapshot fields (name, designation, `sign_with_image`) map directly. Old invoices store no image, only the flag. Where the flag is set, the snapshot points at that signatory's **current** image from the old `users` table, copied to S3. *My call.*
  - `revision` and `revised_at` map directly.
  - `sent` becomes `issued`, with `sent_at` kept.
  - `cancelled` becomes `void`, with the reason "Cancelled in previous invoicing app".
  - Drafts are imported as drafts with their numbers kept (*my call*, to keep the series gapless):
    - A pre-numbered draft cannot be deleted, only voided.
    - Issuing it later keeps its number and does not draw a new one.
    - Its issue date must fall in the FY of its number.
    - Only the importer can create pre-numbered drafts.
- **Instalments:**
  - The old app gives every invoice at least one instalment.
  - An invoice with **one** instalment imports with **no** instalment rows; its `due_date` = that instalment's due date.
  - Invoices with 2 or more instalments map `seq`, amount, due date and `emailed_at` directly.
- **Payments:**
  - Each old payment becomes a LexForgeX payment with one allocation to its invoice.
  - Method: `bank_transfer`, `upi`, `cheque`, `cash` and `other` map directly. The old `zoho` becomes `other`, with `provider = 'zohopay'` and `provider_payment_id` = the Zoho payment id, the same columns a webhook-recorded payment uses.
  - The reference is kept. TDS is 0.
  - Receipt numbers come from the LexForgeX receipt series for the payment's FY, in `paid_on` order.
  - **Old Zoho links become `payment_links` rows** (*my call*), so the existing webhook matches them by `provider_link_id`:
    - Paid links import as `paid`, tied to their imported payment.
    - Unpaid links import as `active`, tied to their instalment. They are cancelled at Zoho during cutover; any link paid in the gap is then recorded by the normal webhook, not lost.
    - The unique `(provider, provider_payment_id)` stops double-recording.
  - **Payments the client made out of order:** the old app tied each payment to an instalment, but LexForgeX derives instalment status in `seq` order.
    - Totals stay correct either way.
    - The importer **reports** each invoice where a later instalment was paid before an earlier one (*my call*), so someone can check it before the auto-sends start.
- **Signed PDFs:** go to S3 and `invoice_signed_documents`.
- **Email log:** a read-only history. **My call:** as timeline entries on the matter, "Email sent (previous app): {subject} to {address}", rather than fake notification rows.
- **Signatories:** old `users` map to LexForgeX members by email. Their designation and signature are copied to the member. Partners who aren't members yet are reported, not created.
- **Numbering continuation:**
  - Set `organizations.invoice_prefix` to the old prefix and `invoice_number_digits = 3`.
  - Set the `document_sequences` row for each FY to `max(imported number) + 1`.
  - The old app lets the prefix be edited and keeps a counter per prefix. If more than one prefix was used, all numbers are kept verbatim; the continuation uses the prefix of the most recent invoice, and the dry run lists every prefix found. *My call.*
  - **Refusal:** the importer refuses to run if the target firm already has issued invoices or receipts in LexForgeX. Vidhimeya has not billed in LexForgeX (confirmed by the user 2026-11-06), so this is only a safety check.
- **Ledger:** post the opening entries the way normal issue and payment do, so balances and aging are correct.

**Verification report** (dry run and real run): per client and in total, the number of invoices, total invoiced, total paid and total due, from the old data vs LexForgeX (`v_invoice_balances`). The run fails if anything differs by more than ₹0.

**Cutover runbook** (written by the builder in `docs/`):
1. Freeze the old app (stop the cron Worker, enable a read-only banner).
2. Export D1.
3. In Zoho, list the old app's active links. Cancel the unpaid ones. Record any paid but unrecorded ones.
4. Do a dry run against a staging copy, check the report, then do the real run.
5. Configure Vidhimeya's Zoho in LexForgeX (the same Zoho account) and point the Zoho webhook at LexForgeX.
6. Spot-check 5 invoices: PDFs and balances.
7. Keep the old app read-only for 4 weeks, then retire it (delete the Pages project, D1 and the cron Worker after a final export is archived).

## Constraints

- Postgres 16, the existing tenancy (composite FKs, `matterVisible`), and the append-only ledger and audit.
- Every new route sits behind the `billing` feature switch, plus the existing permissions: `billing.view`, `invoices.manage`, `payments.record`.
- Production runs on a t3.micro EC2. PDF generation must be light; no headless Chrome.
- The production SES setup has open promises (bounce/complaint handling). Attachments increase email size; stay well under SES's 40 MB limit (invoice PDFs should be under 1 MB).
- No auto-commit: the user commits.

## Left to the builder

- Exact PDF layout details, within "match the print page".
- How instalment targets plug into the workflow engine (new target type vs payload).
- The SES attachment approach (Simple vs Raw).
- Whether to validate the DSC certificate chain.
- Test design. At minimum:
  - schedule sum rules
  - derived instalment status after partial and manual payments
  - one active link per instalment
  - an auto-send skipped when paid
  - "Send now" idempotency
  - revision refused for GST, and DB trigger refusal
  - a ledger adjustment on revision
  - DSC check accepts a signed PDF and rejects an unsigned one
  - number width
  - an importer dry run on a fixture export, with report equality
