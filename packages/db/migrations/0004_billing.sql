-- Phase 4: billing details not covered by 0001.

ALTER TABLE invoices ADD COLUMN write_off_reason TEXT;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_written_off_consistent
  CHECK (status <> 'written_off' OR (written_off_at IS NOT NULL AND write_off_reason IS NOT NULL));

ALTER TABLE expenses
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by UUID REFERENCES users(id),
  ADD COLUMN void_reason TEXT,
  ADD CONSTRAINT expenses_void_consistent CHECK ((status = 'void') = (voided_at IS NOT NULL));

-- Expenses are financial records: never physically deleted (void instead).
CREATE TRIGGER trg_expenses_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE credit_notes ADD COLUMN fiscal_year CHAR(7);

-- Reporting / list indexes.
CREATE INDEX idx_payments_org_matter ON payments (organization_id, matter_id);
CREATE INDEX idx_invoices_org_issue ON invoices (organization_id, issue_date) WHERE status <> 'draft';
CREATE INDEX idx_expenses_org_date ON expenses (organization_id, expense_date);
CREATE INDEX idx_fee_milestones_agreement ON fee_milestones (organization_id, fee_agreement_id, sequence_no);
