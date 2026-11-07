-- Billing parity with the Vidhimeya invoice app: instalments, signatories and signed PDFs, letterhead and bank
-- details, simple-mode revisions, client salutation and CC. Spec: 2026-11-06-billing-vidhimeya-parity-design.md

-- ---- Instalments: dated parts of one invoice, each payable through its own payment link ----
CREATE TABLE invoice_instalments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL,
  seq INT NOT NULL CHECK (seq > 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, invoice_id, id),   -- target of payment_links' composite instalment FK
  UNIQUE (invoice_id, seq),
  -- cascade is for drafts only: issued invoices cannot be deleted (guard_invoice_mutation)
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_invoice_instalments_invoice ON invoice_instalments(organization_id, invoice_id, seq);
CREATE TRIGGER trg_invoice_instalments_updated_at BEFORE UPDATE ON invoice_instalments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A payment link may now target one instalment, of the link's own invoice and firm (MATCH SIMPLE: a NULL
-- instalment_id is a whole-invoice link). One open link per instalment, and one open whole-invoice link.
ALTER TABLE payment_links
  ADD COLUMN instalment_id UUID,
  ADD CONSTRAINT payment_links_instalment_fk FOREIGN KEY (organization_id, invoice_id, instalment_id)
    REFERENCES invoice_instalments(organization_id, invoice_id, id);
DROP INDEX uq_payment_links_one_active;
CREATE UNIQUE INDEX uq_payment_links_active_instalment ON payment_links(instalment_id)
  WHERE status = 'active' AND instalment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_links_active_invoice ON payment_links(invoice_id)
  WHERE status = 'active' AND instalment_id IS NULL;

-- ---- Signatories ----
ALTER TABLE organization_members
  ADD COLUMN designation VARCHAR(120) NOT NULL DEFAULT 'Authorized Signatory',
  ADD COLUMN signature_key TEXT,
  ADD COLUMN signature_type VARCHAR(20);

ALTER TABLE invoices
  ADD COLUMN signatory_user_id UUID REFERENCES users(id),
  ADD COLUMN signatory_name VARCHAR(255),
  ADD COLUMN signatory_designation VARCHAR(120),
  ADD COLUMN signatory_signature_key TEXT,
  ADD COLUMN sign_with_image BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN revision INT NOT NULL DEFAULT 0,
  ADD COLUMN revised_at TIMESTAMPTZ,
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN prenumbered BOOLEAN NOT NULL DEFAULT false;   -- imported draft that already carries its legacy number

-- DSC-signed PDFs uploaded by the firm; one active row per invoice, older revisions are superseded.
CREATE TABLE invoice_signed_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id)
);
CREATE INDEX idx_invoice_signed_documents_invoice ON invoice_signed_documents(organization_id, invoice_id, uploaded_at DESC);
CREATE UNIQUE INDEX uq_invoice_signed_documents_active ON invoice_signed_documents(invoice_id) WHERE superseded_at IS NULL;

-- ---- Letterhead, bank details, numbering ----
ALTER TABLE organizations
  ADD COLUMN registration_label VARCHAR(30),
  ADD COLUMN registration_value VARCHAR(60),
  ADD COLUMN bank_account_name VARCHAR(255),
  ADD COLUMN bank_account_number VARCHAR(40),
  ADD COLUMN bank_ifsc VARCHAR(20),
  ADD COLUMN bank_name VARCHAR(120),
  ADD COLUMN bank_branch VARCHAR(120),
  ADD COLUMN upi_id VARCHAR(120),
  ADD COLUMN invoice_number_digits INT NOT NULL DEFAULT 6 CHECK (invoice_number_digits BETWEEN 3 AND 8);

-- ---- Client salutation and CC ----
ALTER TABLE clients
  ADD COLUMN salutation VARCHAR(10) CHECK (salutation IN ('Mr', 'Ms', 'Mrs', 'Dr', 'Adv', 'M/s')),
  ADD COLUMN title VARCHAR(120),
  ADD COLUMN contact_person VARCHAR(255),
  ADD COLUMN cc_emails TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(cc_emails) <= 5);

-- ---- Outgoing mail: attachments and CC ----
ALTER TABLE notifications
  ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cc TEXT[] NOT NULL DEFAULT '{}';

-- ---- Ledger: a simple-mode revision of an issued invoice is recorded as a delta entry ----
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check CHECK (entry_type IN (
  'invoice_issued', 'invoice_voided', 'invoice_written_off', 'credit_note_issued',
  'payment_received', 'payment_reversed', 'payment_allocated', 'allocation_reversed',
  'expense_recorded', 'expense_voided', 'invoice_revised'));

-- ---- Invoice guards ----
-- Issued GST invoices stay frozen (use a credit note). Issued simple-mode invoices may be revised: amounts, items,
-- due date, notes and the revision counter change; number, issue date, client, matter and tax mode never do.
-- A pre-numbered (imported) draft keeps its number when issued: the number check only applies to non-drafts.
CREATE OR REPLACE FUNCTION guard_invoice_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE simple_revisable BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.prenumbered THEN
      RAISE EXCEPTION 'a pre-numbered draft cannot be deleted; its number would be lost' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    simple_revisable := OLD.status = 'issued' AND OLD.tax_mode = 'simple';
    IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR (NOT simple_revisable AND (
            NEW.subtotal <> OLD.subtotal OR NEW.discount_amount <> OLD.discount_amount
            OR NEW.tax_amount <> OLD.tax_amount OR NEW.total_amount <> OLD.total_amount))
       OR NEW.cgst_amount <> OLD.cgst_amount OR NEW.sgst_amount <> OLD.sgst_amount
       OR NEW.igst_amount <> OLD.igst_amount OR NEW.rcm_tax_amount <> OLD.rcm_tax_amount
       OR NEW.tax_mode <> OLD.tax_mode OR NEW.is_reverse_charge <> OLD.is_reverse_charge
       OR NEW.client_id <> OLD.client_id OR NEW.matter_id <> OLD.matter_id THEN
      RAISE EXCEPTION 'issued invoice amounts are immutable; use a credit note' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status IN ('void', 'written_off') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'invoice % is final', OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'issued invoice cannot return to draft' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_invoice_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT; parent_mode TEXT;
BEGIN
  SELECT status, tax_mode INTO parent_status, parent_mode FROM invoices
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF parent_status IS NOT NULL AND parent_status <> 'draft'
     AND NOT (parent_status = 'issued' AND parent_mode = 'simple') THEN
    RAISE EXCEPTION 'items of a non-draft invoice are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- ---- System email templates ----
-- Client-facing system templates open with the salutation-aware greeting (a firm's own edited copies are untouched).
UPDATE email_templates SET
  html_body = replace(html_body, '<p>Dear {{client.name}},</p>', '<p>{{client.greeting}},</p>'),
  text_body = replace(text_body, 'Dear {{client.name}},', '{{client.greeting}},'),
  updated_at = now()
WHERE organization_id IS NULL AND audience = 'client'
  AND (html_body LIKE '%<p>Dear {{client.name}},</p>%' OR text_body LIKE '%Dear {{client.name}},%');

INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'instalment_payment_link', 'Instalment payment link (client)', 'INVOICE_CREATED', 'client',
 'Instalment {{instalment.number}} of {{instalment.count}} for invoice {{invoice.number}}: {{instalment.amount}} due {{instalment.due_date}}',
 '<p>{{client.greeting}},</p><p>Instalment <strong>{{instalment.number}} of {{instalment.count}}</strong> of invoice <strong>{{invoice.number}}</strong> for {{matter.title}} is <strong>{{instalment.amount}}</strong>, due by <strong>{{instalment.due_date}}</strong>.</p><p><a href="{{links.pay}}">Pay online</a></p><p>{{firm.bank_details_html}}</p><p>If you have already paid, please ignore this message or send us the payment reference.</p><p>Regards,<br>{{firm.name}}</p>',
 NULL),
(NULL, 'invoice_updated', 'Invoice updated (client)', 'INVOICE_CREATED', 'client',
 'Revised invoice {{invoice.number}} from {{firm.name}}: {{invoice.amount_now}} due {{invoice.due_now}}',
 '<p>{{client.greeting}},</p><p>We have revised invoice <strong>{{invoice.number}}</strong> for <strong>{{matter.title}}</strong>. The revised copy is attached and replaces the earlier one.</p>{{invoice.payment_terms_html}}<p>{{firm.bank_details_html}}</p><p>Regards,<br>{{firm.name}}</p>',
 NULL);

-- The invoice email states what is due now and, for instalment invoices, the whole schedule; it also carries the first
-- unpaid instalment's payment link ('' otherwise).
UPDATE email_templates SET
  subject_template = 'Invoice {{invoice.number}} from {{firm.name}}: {{invoice.amount_now}} due {{invoice.due_now}}',
  html_body = replace(
    replace(html_body, '<p>Amount: <strong>{{invoice.total}}</strong><br>Due by: <strong>{{invoice.due_date}}</strong></p>', '{{invoice.payment_terms_html}}'),
    '<p>Regards,<br>{{firm.name}}</p>', '{{links.pay_html}}<p>Regards,<br>{{firm.name}}</p>'),
  updated_at = now()
WHERE organization_id IS NULL AND template_key = 'invoice_issued' AND html_body NOT LIKE '%payment_terms_html%';
