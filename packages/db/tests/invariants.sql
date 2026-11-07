-- DB-level invariant checks. Runs in a transaction and rolls back.
-- Usage: psql -v ON_ERROR_STOP=1 -f packages/db/tests/invariants.sql
BEGIN;

CREATE FUNCTION pg_temp.expect_fail(sql TEXT, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PASS (rejected): %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

INSERT INTO organizations (id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Org A'),
  ('b0000000-0000-0000-0000-000000000001', 'Org B');
INSERT INTO users (id, email, first_name) VALUES ('c0000000-0000-0000-0000-000000000001', 'Lawyer@X.com', 'L');
INSERT INTO organization_members (organization_id, user_id, role)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'lawyer');
INSERT INTO clients (id, organization_id, name) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Client A'),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'Client B');
INSERT INTO matters (id, organization_id, client_id, title) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Matter A');

-- Tenancy
SELECT pg_temp.expect_fail($$INSERT INTO matters (organization_id, client_id, title)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'x')$$,
  'matter in org A referencing client of org B');
SELECT pg_temp.expect_fail($$INSERT INTO matter_staff (organization_id, matter_id, user_id)
  VALUES ('b0000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001')$$,
  'matter_staff row with wrong org');
SELECT pg_temp.expect_fail($$INSERT INTO users (email, first_name) VALUES ('lawyer@x.com', 'dup')$$,
  'case-insensitive duplicate email');

-- Assignment: multiple members, one lead
INSERT INTO users (id, email, first_name) VALUES ('c0000000-0000-0000-0000-000000000002', 'l2@x.com', 'L2');
INSERT INTO organization_members (organization_id, user_id, role)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'lawyer');
INSERT INTO matter_staff (organization_id, matter_id, user_id, role) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'lead'),
  ('a0000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'associate');
SELECT pg_temp.expect_fail($$UPDATE matter_staff SET role = 'lead' WHERE user_id = 'c0000000-0000-0000-0000-000000000002'$$,
  'second lead on a matter');

-- Tax modes
SELECT pg_temp.expect_fail($$INSERT INTO invoices (organization_id, client_id, matter_id, tax_mode, subtotal, tax_amount, total_amount, cgst_amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'simple', 100, 18, 118, 9)$$,
  'simple-mode invoice carrying CGST');
SELECT pg_temp.expect_fail($$INSERT INTO invoices (organization_id, client_id, matter_id, tax_mode, subtotal, cgst_amount, sgst_amount, igst_amount, tax_amount, total_amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'gst', 100, 9, 9, 18, 36, 136)$$,
  'gst invoice with both CGST/SGST and IGST');
SELECT pg_temp.expect_fail($$INSERT INTO invoices (organization_id, client_id, matter_id, tax_mode, is_reverse_charge, subtotal, rcm_tax_amount, tax_amount, total_amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'gst', true, 100, 18, 18, 118)$$,
  'reverse-charge invoice charging tax');
SELECT pg_temp.expect_fail($$INSERT INTO invoices (organization_id, client_id, matter_id, tax_mode, subtotal, tax_amount, total_amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'simple', 100, 18, 100)$$,
  'total != subtotal - discount + tax');

-- Valid GST RCM draft -> items -> issue
INSERT INTO invoices (id, organization_id, client_id, matter_id, tax_mode, is_reverse_charge, subtotal, rcm_tax_amount, total_amount)
  VALUES ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001', 'gst', true, 50000, 9000, 50000);
INSERT INTO invoice_items (organization_id, invoice_id, description, unit_price, amount, sac_code, gst_rate)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'Professional fees', 50000, 50000, '998212', 18);
SELECT pg_temp.expect_fail($$UPDATE invoices SET status = 'issued' WHERE id = 'a3000000-0000-0000-0000-000000000001'$$,
  'issue without number/dates/GSTIN');
UPDATE invoices SET status = 'issued', invoice_number = 'LGL/2026-27/000001', fiscal_year = '2026-27',
  issue_date = '2026-10-02', due_date = '2026-10-15', issued_at = now(),
  supplier_gstin = '07AAAAA0000A1Z5', supplier_state_code = '07', place_of_supply = '07'
  WHERE id = 'a3000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect_fail($$UPDATE invoices SET subtotal = 1, total_amount = 1 WHERE id = 'a3000000-0000-0000-0000-000000000001'$$,
  'editing amounts of issued invoice');
SELECT pg_temp.expect_fail($$UPDATE invoice_items SET amount = 1 WHERE invoice_id = 'a3000000-0000-0000-0000-000000000001'$$,
  'editing items of issued invoice');
SELECT pg_temp.expect_fail($$DELETE FROM invoices WHERE id = 'a3000000-0000-0000-0000-000000000001'$$,
  'deleting issued invoice');

-- Payment with TDS settling the invoice: 45,000 cash + 5,000 TDS
INSERT INTO payments (id, organization_id, client_id, receipt_number, amount, tds_amount, payment_date, payment_method)
  VALUES ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'RCPT/2026-27/000001', 45000, 5000, '2026-10-05', 'bank_transfer');
INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 20000);
DO $$ DECLARE r RECORD; BEGIN
  SELECT * INTO r FROM v_invoice_balances WHERE invoice_id = 'a3000000-0000-0000-0000-000000000001';
  IF r.amount_due <> 30000 OR r.payment_state <> 'partial' THEN RAISE EXCEPTION 'FAIL partial balance: %', r; END IF;
  RAISE NOTICE 'PASS: partial allocation -> due 30000, partial';
  IF (SELECT unallocated_amount FROM v_payment_unallocated WHERE payment_id = 'a4000000-0000-0000-0000-000000000001') <> 30000
    THEN RAISE EXCEPTION 'FAIL advance remainder'; END IF;
  RAISE NOTICE 'PASS: unallocated remainder 30000 held as advance';
END $$;
INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 30000);
DO $$ BEGIN
  IF (SELECT payment_state FROM v_invoice_balances WHERE invoice_id = 'a3000000-0000-0000-0000-000000000001') <> 'paid'
    THEN RAISE EXCEPTION 'FAIL paid state'; END IF;
  RAISE NOTICE 'PASS: cash+TDS fully settles invoice -> paid';
END $$;

SELECT pg_temp.expect_fail($$UPDATE payments SET amount = 1 WHERE id = 'a4000000-0000-0000-0000-000000000001'$$,
  'editing payment amount');
SELECT pg_temp.expect_fail($$DELETE FROM payments WHERE id = 'a4000000-0000-0000-0000-000000000001'$$, 'deleting payment');
SELECT pg_temp.expect_fail($$DELETE FROM payment_allocations$$, 'deleting allocation');

-- Reversal restores receivable
UPDATE payments SET status = 'reversed', reversed_at = now(), reversal_reason = 'cheque bounced'
  WHERE id = 'a4000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF (SELECT amount_due FROM v_invoice_balances WHERE invoice_id = 'a3000000-0000-0000-0000-000000000001') <> 50000
    THEN RAISE EXCEPTION 'FAIL reversal'; END IF;
  RAISE NOTICE 'PASS: payment reversal restores due 50000';
END $$;
SELECT pg_temp.expect_fail($$UPDATE payments SET status = 'posted', reversed_at = NULL, reversal_reason = NULL
  WHERE id = 'a4000000-0000-0000-0000-000000000001'$$, 'reinstating reversed payment');

-- Ledger / audit append-only
INSERT INTO ledger_entries (organization_id, entry_type, debit_account, credit_account, amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'invoice_issued', 'accounts_receivable', 'fee_revenue', 50000);
SELECT pg_temp.expect_fail($$UPDATE ledger_entries SET amount = 1$$, 'updating ledger');
SELECT pg_temp.expect_fail($$DELETE FROM ledger_entries$$, 'deleting ledger');

-- Notifications cannot claim SENT without a provider message id
SELECT pg_temp.expect_fail($$INSERT INTO notifications (organization_id, channel, notification_type, recipient_type, client_id, status)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'email', 'x', 'client', 'a1000000-0000-0000-0000-000000000001', 'sent')$$,
  'notification SENT with no provider message id');

-- Platform realm (LexForgeX T2)
SELECT pg_temp.expect_fail($$UPDATE organizations SET status = 'deleted' WHERE id = 'a0000000-0000-0000-0000-000000000001'$$,
  'organization status outside invited/active/suspended');
INSERT INTO platform_admins (id, email, name, password_hash)
  VALUES ('d0000000-0000-0000-0000-000000000001', 'ops@legalforgex.test', 'Ops', 'x');
INSERT INTO platform_audit_logs (platform_admin_id, action, organization_id)
  VALUES ('d0000000-0000-0000-0000-000000000001', 'firm.invited', 'a0000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail($$UPDATE platform_audit_logs SET action = 'x'$$, 'updating platform audit');
SELECT pg_temp.expect_fail($$DELETE FROM platform_audit_logs$$, 'deleting platform audit');
SELECT pg_temp.expect_fail($$INSERT INTO invitations (organization_id, email, role, invited_by, invited_by_platform_admin_id, expires_at)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'x@y.test', 'owner', 'c0000000-0000-0000-0000-000000000001',
          'd0000000-0000-0000-0000-000000000001', now() + interval '7 days')$$,
  'invitation with both a firm inviter and a platform inviter');

-- Billing parity (migration 0017)
-- Expect a specific SQLSTATE so an unrelated error (e.g. a missing column) cannot pass as a rejection.
CREATE FUNCTION pg_temp.expect_state(sql TEXT, state TEXT, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got TEXT;
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    IF got = state THEN RAISE NOTICE 'PASS (rejected %): %', state, label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL (wrong error % , wanted %): % -- %', got, state, label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

-- GST issued invoice a3...01 (50000, RCM) stays frozen
SELECT pg_temp.expect_state($$UPDATE invoices SET total_amount = 60000, subtotal = 60000 WHERE id = 'a3000000-0000-0000-0000-000000000001'$$,
  '23001', 'gst_issued_invoice_total_frozen');

-- Simple-mode issued invoice: amounts/items/due date/notes editable, number frozen
INSERT INTO invoices (id, organization_id, client_id, matter_id, tax_mode, subtotal, total_amount)
  VALUES ('a3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001', 'simple', 1000, 1000);
INSERT INTO invoice_items (id, organization_id, invoice_id, description, unit_price, amount)
  VALUES ('a5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'Fees', 1000, 1000);
UPDATE invoices SET status = 'issued', invoice_number = 'LGL/2026-27/000002', fiscal_year = '2026-27',
  issue_date = '2026-10-02', due_date = '2026-10-15', issued_at = now()
  WHERE id = 'a3000000-0000-0000-0000-000000000002';
UPDATE invoices SET subtotal = 1200, total_amount = 1200, due_date = '2026-10-20', notes = 'revised', revision = 1, revised_at = now()
  WHERE id = 'a3000000-0000-0000-0000-000000000002';
UPDATE invoice_items SET unit_price = 1200, amount = 1200 WHERE id = 'a5000000-0000-0000-0000-000000000002';
DO $$ BEGIN
  IF (SELECT total_amount FROM invoices WHERE id = 'a3000000-0000-0000-0000-000000000002') <> 1200
     OR (SELECT amount FROM invoice_items WHERE id = 'a5000000-0000-0000-0000-000000000002') <> 1200
    THEN RAISE EXCEPTION 'FAIL simple revision'; END IF;
  RAISE NOTICE 'PASS: simple_issued_invoice_total_editable';
END $$;
SELECT pg_temp.expect_state($$UPDATE invoices SET invoice_number = 'X/1' WHERE id = 'a3000000-0000-0000-0000-000000000002'$$,
  '23001', 'simple_issued_invoice_number_frozen');
SELECT pg_temp.expect_state($$UPDATE invoices SET issue_date = '2026-10-03' WHERE id = 'a3000000-0000-0000-0000-000000000002'$$,
  '23001', 'simple issued invoice issue date frozen');
-- items of the GST invoice stay frozen too
SELECT pg_temp.expect_state($$INSERT INTO invoice_items (organization_id, invoice_id, description, unit_price, amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'x', 1, 1)$$,
  '23001', 'adding an item to an issued GST invoice');

-- Pre-numbered drafts cannot be deleted; they keep their number on issue
INSERT INTO invoices (id, organization_id, client_id, matter_id, tax_mode, subtotal, total_amount, invoice_number, prenumbered)
  VALUES ('a3000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001', 'simple', 500, 500, 'OLD/001', true);
SELECT pg_temp.expect_state($$DELETE FROM invoices WHERE id = 'a3000000-0000-0000-0000-000000000003'$$,
  '23001', 'prenumbered_draft_not_deletable');
UPDATE invoices SET status = 'issued', fiscal_year = '2026-27', issue_date = '2026-10-04', due_date = '2026-10-18', issued_at = now()
  WHERE id = 'a3000000-0000-0000-0000-000000000003';
DO $$ BEGIN
  IF (SELECT invoice_number FROM invoices WHERE id = 'a3000000-0000-0000-0000-000000000003') <> 'OLD/001'
    THEN RAISE EXCEPTION 'FAIL prenumbered issue'; END IF;
  RAISE NOTICE 'PASS: pre-numbered draft keeps its number when issued';
END $$;
-- an ordinary draft is still deletable
INSERT INTO invoices (id, organization_id, client_id, matter_id, tax_mode)
  VALUES ('a3000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'a2000000-0000-0000-0000-000000000001', 'simple');
DELETE FROM invoices WHERE id = 'a3000000-0000-0000-0000-000000000004';
DO $$ BEGIN RAISE NOTICE 'PASS: ordinary draft still deletable'; END $$;

-- Instalments and payment links: one active link per instalment (and one whole-invoice link)
INSERT INTO invoice_instalments (id, organization_id, invoice_id, seq, amount, due_date)
  VALUES ('a6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 1, 600, '2026-10-20'),
         ('a6000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 2, 600, '2026-11-20');
SELECT pg_temp.expect_state($$INSERT INTO invoice_instalments (organization_id, invoice_id, seq, amount, due_date)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 1, 10, '2026-12-01')$$,
  '23505', 'duplicate instalment seq');
INSERT INTO payment_links (organization_id, invoice_id, client_id, instalment_id, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          'a6000000-0000-0000-0000-000000000001', 'zohopay', 'sandbox', 'L1', 'https://pay.test/1', 600, 'c0000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_state($$INSERT INTO payment_links (organization_id, invoice_id, client_id, instalment_id, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          'a6000000-0000-0000-0000-000000000001', 'zohopay', 'sandbox', 'L2', 'https://pay.test/2', 600, 'c0000000-0000-0000-0000-000000000001')$$,
  '23505', 'one_active_link_per_instalment');
-- a different instalment, and a whole-invoice link, may coexist with it
INSERT INTO payment_links (organization_id, invoice_id, client_id, instalment_id, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          'a6000000-0000-0000-0000-000000000002', 'zohopay', 'sandbox', 'L3', 'https://pay.test/3', 600, 'c0000000-0000-0000-0000-000000000001'),
         ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          NULL, 'zohopay', 'sandbox', 'L4', 'https://pay.test/4', 1200, 'c0000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_state($$INSERT INTO payment_links (organization_id, invoice_id, client_id, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          'zohopay', 'sandbox', 'L5', 'https://pay.test/5', 1200, 'c0000000-0000-0000-0000-000000000001')$$,
  '23505', 'second active whole-invoice link');
SELECT pg_temp.expect_state($$INSERT INTO payment_links (organization_id, invoice_id, client_id, instalment_id, status, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('b0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001',
          'a6000000-0000-0000-0000-000000000002', 'canceled', 'zohopay', 'sandbox', 'L6', 'https://pay.test/6', 1, 'c0000000-0000-0000-0000-000000000001')$$,
  '23503', 'payment link instalment from another organization');
SELECT pg_temp.expect_state($$INSERT INTO payment_links (organization_id, invoice_id, client_id, instalment_id, status, provider, environment, provider_link_id, url, amount, created_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
          'a6000000-0000-0000-0000-000000000002', 'canceled', 'zohopay', 'sandbox', 'L7', 'https://pay.test/7', 1, 'c0000000-0000-0000-0000-000000000001')$$,
  '23503', 'payment link instalment from another invoice');

-- Signed documents: one active per invoice
INSERT INTO invoice_signed_documents (organization_id, invoice_id, revision, storage_key, size_bytes)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 0, 'k/1.pdf', 1000);
SELECT pg_temp.expect_state($$INSERT INTO invoice_signed_documents (organization_id, invoice_id, revision, storage_key, size_bytes)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 1, 'k/2.pdf', 1000)$$,
  '23505', 'one_active_signed_doc');
UPDATE invoice_signed_documents SET superseded_at = now() WHERE storage_key = 'k/1.pdf';
INSERT INTO invoice_signed_documents (organization_id, invoice_id, revision, storage_key, size_bytes)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', 1, 'k/2.pdf', 1000);
DO $$ BEGIN RAISE NOTICE 'PASS: superseding a signed document allows a new active one'; END $$;

-- Ledger accepts invoice_revised; client and org constraints
INSERT INTO ledger_entries (organization_id, entry_type, debit_account, credit_account, amount)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'invoice_revised', 'accounts_receivable', 'fee_revenue', 200);
DO $$ BEGIN RAISE NOTICE 'PASS: ledger accepts invoice_revised'; END $$;
SELECT pg_temp.expect_state($$UPDATE clients SET salutation = 'Sir' WHERE id = 'a1000000-0000-0000-0000-000000000001'$$,
  '23514', 'invalid client salutation');
SELECT pg_temp.expect_state($$UPDATE clients SET cc_emails = ARRAY['a@x.com','b@x.com','c@x.com','d@x.com','e@x.com','f@x.com'] WHERE id = 'a1000000-0000-0000-0000-000000000001'$$,
  '23514', 'more than 5 client CC emails');
SELECT pg_temp.expect_state($$UPDATE organizations SET invoice_number_digits = 9 WHERE id = 'a0000000-0000-0000-0000-000000000001'$$,
  '23514', 'invoice_number_digits out of range');

-- New system templates exist; client system templates use the greeting
DO $$ BEGIN
  IF (SELECT count(*) FROM email_templates WHERE organization_id IS NULL AND template_key IN ('instalment_payment_link', 'invoice_updated')) <> 2
    THEN RAISE EXCEPTION 'FAIL new system templates'; END IF;
  IF EXISTS (SELECT 1 FROM email_templates WHERE organization_id IS NULL AND audience = 'client' AND html_body LIKE '%Dear {{client.name}}%')
    THEN RAISE EXCEPTION 'FAIL client templates still use Dear {{client.name}}'; END IF;
  RAISE NOTICE 'PASS: system templates seeded and greeting applied';
END $$;

ROLLBACK;
