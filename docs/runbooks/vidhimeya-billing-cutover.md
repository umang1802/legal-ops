# Vidhimeya billing cutover: old invoicing app to LexForgeX

Spec: `docs/superpowers/specs/2026-11-06-billing-vidhimeya-parity-design.md` §10. Decisions: D-018 in `docs/decisions.md`.
Importer: `apps/api/src/scripts/import-vidhimeya.ts`, bundled into the app image as `apps/api/dist/import-vidhimeya.js`.
It runs on the production EC2 host inside the app image with plain `node`. `node:sqlite` is built into Node 22, so the
image needs nothing extra.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Imported, or the dry run passed |
| 1 | Verification failed. The run was rolled back and nothing was written |
| 2 | Refused or error. Nothing was written |

A second run on the same firm is refused.

## Before the day

- Deploy a build that contains the importer (`infra/scripts/deploy.sh`). Check that the image has it:
  `sudo /opt/lexforgex/repo/infra/scripts/compose.sh run --rm --no-deps --entrypoint ls api apps/api/dist/import-vidhimeya.js`.
- Have ready:
  - Vidhimeya's firm id (`<orgId>`).
  - The owner's sign-in email (`<owner email>`). This person must be an active member. They lead every imported matter and own the imported records.
- In the platform console, configure Vidhimeya's Zoho Payments: the same Zoho account the old app used, environment `live`, and the signing key. Leave the Zoho webhook URL pointing at the old app for now (see step f).
- Invite the partners who sign invoices, so the importer can match them by email.

## Steps

### a. Freeze

- Disable the old app's cron Worker. That stops its instalment emails, reminders and Zoho polling.
- Tell the firm to stop issuing or sending invoices from the old app.
- Until step g is done:
  - Nobody records invoices or payments in the old app.
  - No billing activity happens in LexForgeX for Vidhimeya: no invoices, payments or payment links. The importer refuses a firm that already has issued invoices or payments.

### b. Export D1

```
wrangler d1 export <database-name> --remote --output=vidhimeya-YYYYMMDD-HHMM.sql
```

Write down the export time (IST and UTC). Step g reconciles from this moment. Keep the file: it is the archive.

### c. Firm profile in LexForgeX

The importer does not copy the old firm profile. In Firm settings, enter:

- letterhead and registration (LLPIN)
- PAN
- bank details (account name and number, IFSC, bank, branch) and UPI ID

The importer copies the signatories' designation and scanned signature onto members whose email matches. For partners who are not members yet, invite them, then upload their designation and signature in Firm settings.

### d. Production dry run, and review now

Copy the export to the host, readable by the container user (`node`, uid 1000):

```
# from your machine
scp vidhimeya-YYYYMMDD-HHMM.sql ec2-user@<host>:/tmp/vidhimeya.sql
# on the host
sudo install -d -m 0755 /opt/lexforgex/import
sudo install -m 0644 /tmp/vidhimeya.sql /opt/lexforgex/import/vidhimeya.sql && rm /tmp/vidhimeya.sql
```

Run the dry run in a one-off app container with the directory mounted read-only. `compose.sh` adds the env file and the `localdb` profile. The working directory is `/repo`, and `app.env` supplies `DATABASE_URL` and `S3_*`.

```
sudo /opt/lexforgex/repo/infra/scripts/compose.sh run --rm --no-deps \
  -v /opt/lexforgex/import:/import:ro --entrypoint node \
  api apps/api/dist/import-vidhimeya.js \
  --export /import/vidhimeya.sql --org <orgId> --owner <owner email> --dry-run
```

Add `--json` for the full report as JSON (`> /opt/lexforgex/import/dry-run.json` on the host side).

If `compose.sh` isn't on the host, run the same command directly:

```
sudo docker compose -f /opt/lexforgex/repo/infra/docker-compose.prod.yml --env-file /etc/lexforgex/app.env \
  [--profile localdb] run --rm --no-deps -v /opt/lexforgex/import:/import:ro --entrypoint node api apps/api/dist/import-vidhimeya.js …
```

Add `--profile localdb` when `DB_MODE=local` in `/etc/lexforgex/app.env`.

**Review everything in the report now.** Reminders and instalment link emails are planned the moment the real run commits, so there is no later window. Check:

- **Client totals.** Every client row says `yes`, and the TOTAL row matches the old app's dashboard.
- **Numbering:**
  - the prefixes found, and the next number per financial year (new invoices continue the most recent prefix, with 3 digits);
  - **numbering gaps**: the old counter is higher than the highest exported number. Find out why before going on; usually the export is stale or incomplete.
- **Paid out of instalment order.** LexForgeX applies money to instalments in order, so on these invoices a different instalment shows as paid, and the next reminder may name a different instalment. Decide with the firm now. If a reminder would be wrong, plan to fix the schedule right after the import with a revision. Simple-tax invoices only.
- **Signatories who are not members.** Invite them (step c).
- **Titles not mapped to a salutation, and all warnings.**

### e. Real run

The same command without `--dry-run`. The report it prints should be identical to the dry run's.

Signature images and signed PDFs go to S3. If storage is not configured, the run fails and writes nothing.

### f. Point the Zoho webhook at LexForgeX, immediately

In Zoho Payments → Developer → Webhooks, change the URL to:

```
https://<APP_DOMAIN>/api/v1/webhooks/zohopay/<orgId>
```

For example, `https://app.lexforgex.com/api/v1/webhooks/zohopay/<orgId>`. Keep the same signing key that you entered in the platform console.

From now on, a paid old link is recorded in LexForgeX:

- The importer created the old links as `payment_links` rows with their Zoho link ids.
- A link the import already marked paid is ignored ("Link already paid").
- The payment id is unique, so a payment can't be recorded twice.

### g. Reconcile the gap

Between the export (b) and the webhook switch (f), Zoho may have taken payments that reached neither the export nor LexForgeX. LexForgeX answers an unknown or late event with 200, so Zoho will not retry it.

1. In Zoho Payments, list the payments made since the export time.
2. For each one, find its receipt in LexForgeX: Payments, reference = the Zoho payment id.
3. If a payment is missing, either:
   - **replay the webhook** from Zoho, if Zoho offers it for that event (the link is now known, so it is recorded normally); or
   - in LexForgeX, **Record payment** on the invoice, with:
     - method **Other**
     - reference = the **Zoho payment id**
     - the payment date and amount from Zoho
4. Repeat until every Zoho payment since the export has a LexForgeX receipt.

### h. Old unpaid Zoho links stay active

Do **not** cancel them. Clients may already have them. When a client pays one, Zoho's webhook records the payment in LexForgeX (step f).

- **Instalment links.** LexForgeX reuses an imported active link while its amount still equals the instalment's remaining amount. Otherwise it cancels the link at Zoho itself and creates a new one when it next sends.
- **Whole-invoice links** (invoices without instalments). The link shows on the invoice's Pay online card. To issue a new link for a different amount, cancel the old one there first; this also cancels it at Zoho.

### i. Spot-check, wind down

1. **Spot-check 5 invoices.** Choose:
   - one with instalments
   - one partly paid
   - one with a DSC-signed PDF
   - one void
   - the pre-numbered draft, if there is one

   Compare each with the old app: PDF (the signed copy where one was uploaded), balance, instalments with their status, payment links, and the receipt numbers.
2. **Check that no email went out.** The Automations page shows reminders as planned for the open invoices. No "invoice issued" email should be sent for the imported invoices.
3. **Unfreeze LexForgeX billing.** The firm now bills only in LexForgeX.
4. **Keep the old app read-only for 4 weeks.** Then take a final `wrangler d1 export` and archive it with the cutover export. Then delete the Pages project, the D1 database and the cron Worker.

## What the import does

- **Clients.** Matched by email, case-insensitive. A matched client keeps its LexForgeX data; only empty fields are filled.
  - The old honorific ("Mr.", "dr") becomes the salutation (Mr, Ms, Mrs, Dr, Adv, M/s).
  - The old greeting word ("Dear", "Respected") is dropped and counted in the report.
- **Matters.** One per client per invoice subject. With no subject, the matter is "Advisory: {client}". The owner leads every matter.
- **Invoices.** Numbers are kept and the series continues.
  - Sent becomes issued.
  - Cancelled becomes void, with the reason "Cancelled in previous invoicing app".
  - A draft stays a pre-numbered draft. It cannot be deleted. It can be issued with the same number (the issue date must stay in that number's FY), or voided.
  - An invoice with one instalment imports with no instalment rows.
- **Payments.**
  - They get LexForgeX receipt numbers (RCPT series), in payment-date order.
  - Zoho payments become method `other` with provider `zohopay` and the Zoho payment id.
  - Paid Zoho links are dated by the payment date.
- **Email.** No email is sent by the import. Open invoices get their future reminders and instalment link emails planned, and reminders already in the past are skipped. The old email log becomes "Email sent (previous app)" entries on the matter timeline.
