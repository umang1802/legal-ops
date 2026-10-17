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

-- Platform realm (LegalForgeX T2)
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

ROLLBACK;
