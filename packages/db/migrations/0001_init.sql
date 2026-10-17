-- LegalOps V1 — initial schema
-- Supersedes docs/prd/legalops_v1_schema.sql. See docs/gap-analysis.md and docs/decisions.md.
--
-- Conventions
--   * UUID PKs (gen_random_uuid), timestamptz for instants, date for date-only values.
--   * Every tenant-owned table has organization_id NOT NULL and UNIQUE (organization_id, id).
--     Child FKs are composite (organization_id, x_id) so a row can never reference another tenant's row.
--   * Enum-like columns are lowercase snake_case with CHECK constraints.
--   * Money is NUMERIC(14,2). The app does arithmetic in integer paise.
--   * Financial and audit tables are append-only (enforced by triggers below).
-- Rollback strategy: forward-only. A failed deploy is fixed with a new migration, never an edit to this file.
-- The migration runner wraps each file in a transaction; files must not contain BEGIN/COMMIT.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- Organizations, users, membership, auth
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  legal_name VARCHAR(255),
  email CITEXT,
  phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  state_code CHAR(2),                       -- GST state code, e.g. '07' Delhi
  country VARCHAR(120) NOT NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'LGL',
  tax_mode VARCHAR(10) NOT NULL DEFAULT 'simple' CHECK (tax_mode IN ('simple', 'gst')),
  gstin VARCHAR(15),
  pan VARCHAR(10),
  default_sac_code VARCHAR(8) DEFAULT '998212',
  default_gst_rate NUMERIC(5,2) DEFAULT 18.00,
  default_send_time TIME NOT NULL DEFAULT '09:00',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tax_mode = 'simple' OR (gstin IS NOT NULL AND state_code IS NOT NULL))
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT,                        -- null until invitation accepted
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100),
  phone VARCHAR(40),
  is_active BOOLEAN NOT NULL DEFAULT true,
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL CHECK (role IN ('owner', 'admin', 'lawyer', 'staff', 'finance', 'read_only')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- SHA-256 of the cookie token; raw token never stored
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id UUID REFERENCES organizations(id),
  csrf_secret TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type VARCHAR(30) NOT NULL CHECK (token_type IN ('password_reset', 'email_verification')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, token_type);

CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email CITEXT NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('owner', 'admin', 'lawyer', 'staff', 'finance', 'read_only')),
  token_hash TEXT UNIQUE,                    -- generated when the invite email is sent
  invited_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_invitations_open ON invitations(organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE user_notification_prefs (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  email_reminders BOOLEAN,                   -- null = use org default from organizations.settings
  daily_digest BOOLEAN,
  task_assignment_emails BOOLEAN,
  hearing_reminders BOOLEAN,
  financial_alerts BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Clients, matters, cases
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_type VARCHAR(20) NOT NULL DEFAULT 'person' CHECK (client_type IN ('person', 'company')),
  name VARCHAR(255) NOT NULL,
  email CITEXT,
  phone VARCHAR(40),
  phone_e164 VARCHAR(20),                    -- normalised for search + duplicate warnings
  alternate_phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  state_code CHAR(2),
  country VARCHAR(120) DEFAULT 'India',
  gstin VARCHAR(15),
  pan VARCHAR(10),
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  email_notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  email_verified_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_clients_org_email ON clients(organization_id, email);
CREATE INDEX idx_clients_org_phone ON clients(organization_id, phone_e164);
CREATE INDEX idx_clients_name_trgm ON clients USING gin (name gin_trgm_ops);

CREATE TABLE matters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  reference_code VARCHAR(100),
  practice_area VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('lead', 'active', 'on_hold', 'closed', 'archived')),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  start_date DATE,
  close_date DATE,
  internal_notes TEXT,
  client_summary TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  CHECK (close_date IS NULL OR start_date IS NULL OR close_date >= start_date)
);
CREATE UNIQUE INDEX uq_matters_org_ref ON matters(organization_id, reference_code) WHERE reference_code IS NOT NULL;
CREATE INDEX idx_matters_org_status ON matters(organization_id, status);
CREATE INDEX idx_matters_org_client ON matters(organization_id, client_id);
CREATE INDEX idx_matters_title_trgm ON matters USING gin (title gin_trgm_ops);
CREATE INDEX idx_matters_ref_trgm ON matters USING gin (reference_code gin_trgm_ops);

-- D-004: matter_staff is the single source of assignment. 'lead' = responsible lawyer (max one).
CREATE TABLE matter_staff (
  organization_id UUID NOT NULL,
  matter_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'support' CHECK (role IN ('lead', 'associate', 'support')),
  added_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (matter_id, user_id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id)
);
CREATE UNIQUE INDEX uq_matter_staff_one_lead ON matter_staff(matter_id) WHERE role = 'lead';
CREATE INDEX idx_matter_staff_org_user ON matter_staff(organization_id, user_id);

CREATE TABLE courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),   -- null = global/system court
  name VARCHAR(255) NOT NULL,
  court_type VARCHAR(100),
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) DEFAULT 'India',
  external_provider VARCHAR(50),
  external_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_courts_org ON courts(organization_id);
CREATE INDEX idx_courts_name_trgm ON courts USING gin (name gin_trgm_ops);

CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL,
  court_id UUID REFERENCES courts(id),       -- may be global; service checks org IS NULL OR = current org
  title VARCHAR(255) NOT NULL,
  case_number VARCHAR(150),
  cnr VARCHAR(16),
  case_type VARCHAR(100),
  filing_date DATE,
  registration_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_filing', 'active', 'reserved', 'disposed', 'withdrawn', 'transferred', 'closed')),
  judge_bench VARCHAR(255),
  next_hearing_date DATE,                    -- maintained by hearing service in the same tx
  external_provider VARCHAR(50),
  external_id VARCHAR(255),
  external_url TEXT,
  last_synced_at TIMESTAMPTZ,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  CHECK (external_provider IS NULL OR external_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_cases_org_cnr ON cases(organization_id, cnr) WHERE cnr IS NOT NULL;
CREATE INDEX idx_cases_org_matter ON cases(organization_id, matter_id);
CREATE INDEX idx_cases_org_next_hearing ON cases(organization_id, next_hearing_date);
CREATE INDEX idx_cases_number_trgm ON cases USING gin (case_number gin_trgm_ops);
CREATE INDEX idx_cases_cnr_trgm ON cases USING gin (cnr gin_trgm_ops);

CREATE TABLE case_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  case_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  party_type VARCHAR(100),
  side VARCHAR(30) CHECK (side IN ('petitioner', 'plaintiff', 'appellant', 'respondent', 'defendant', 'other')),
  is_client BOOLEAN NOT NULL DEFAULT false,
  email CITEXT,
  phone VARCHAR(40),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_case_parties_case ON case_parties(organization_id, case_id);

CREATE TABLE advocates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  firm_name VARCHAR(255),
  enrollment_number VARCHAR(100),
  phone VARCHAR(40),
  email CITEXT,
  is_internal BOOLEAN NOT NULL DEFAULT false,
  user_id UUID REFERENCES users(id),         -- set when the advocate is a firm member
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE case_advocates (
  organization_id UUID NOT NULL,
  case_id UUID NOT NULL,
  advocate_id UUID NOT NULL,
  side VARCHAR(30) CHECK (side IN ('petitioner', 'plaintiff', 'appellant', 'respondent', 'defendant', 'other')),
  is_lead BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (case_id, advocate_id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, advocate_id) REFERENCES advocates(organization_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Hearings, tasks, documents
-- ---------------------------------------------------------------------------

CREATE TABLE hearings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  case_id UUID NOT NULL,
  scheduled_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  courtroom VARCHAR(100),
  bench_judge VARCHAR(255),
  hearing_type VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'adjourned', 'cancelled', 'unknown')),
  outcome TEXT,
  next_hearing_date DATE,
  previous_hearing_id UUID,
  notes TEXT,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id),
  source_provider VARCHAR(50),
  external_id VARCHAR(255),
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id),
  FOREIGN KEY (organization_id, previous_hearing_id) REFERENCES hearings(organization_id, id),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time),
  CHECK (next_hearing_date IS NULL OR next_hearing_date > scheduled_date),
  CHECK (status NOT IN ('completed', 'adjourned') OR completed_at IS NOT NULL)
);
CREATE INDEX idx_hearings_org_date ON hearings(organization_id, scheduled_date);
CREATE INDEX idx_hearings_case_date ON hearings(organization_id, case_id, scheduled_date);
CREATE INDEX idx_hearings_org_status ON hearings(organization_id, status);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID,
  case_id UUID,
  hearing_id UUID,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assignee_id UUID,
  created_by UUID REFERENCES users(id),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status VARCHAR(30) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users(id),
  source_event_id UUID,                      -- outbox event that caused creation (workflow tasks)
  idempotency_key TEXT UNIQUE,               -- workflow-created tasks: never created twice
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id),
  FOREIGN KEY (organization_id, hearing_id) REFERENCES hearings(organization_id, id),
  FOREIGN KEY (organization_id, assignee_id) REFERENCES organization_members(organization_id, user_id),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX idx_tasks_org_due ON tasks(organization_id, due_at) WHERE status NOT IN ('done', 'cancelled');
CREATE INDEX idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);
CREATE INDEX idx_tasks_org_matter ON tasks(organization_id, matter_id);

CREATE TABLE task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  task_id UUID NOT NULL,
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, task_id) REFERENCES tasks(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_task_comments_task ON task_comments(organization_id, task_id, created_at);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID,
  case_id UUID,
  hearing_id UUID,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 VARCHAR(64),
  storage_provider VARCHAR(50) NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'failed', 'deleted')),
  scan_status VARCHAR(20) NOT NULL DEFAULT 'not_scanned'
    CHECK (scan_status IN ('not_scanned', 'clean', 'infected', 'error')),
  visibility VARCHAR(20) NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'client')),
  is_signed BOOLEAN NOT NULL DEFAULT false,  -- metadata only; implies nothing about legal validity
  shared_at TIMESTAMPTZ,
  shared_by UUID REFERENCES users(id),
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id),
  FOREIGN KEY (organization_id, hearing_id) REFERENCES hearings(organization_id, id),
  CHECK (matter_id IS NOT NULL OR case_id IS NOT NULL),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX idx_documents_org_matter ON documents(organization_id, matter_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_org_case ON documents(organization_id, case_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_pending ON documents(created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Billing (D-001, D-002)
-- ---------------------------------------------------------------------------

-- Gapless, per-FY numbering for invoices, receipts and credit notes. Row is locked FOR UPDATE on use.
CREATE TABLE document_sequences (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('invoice', 'receipt', 'credit_note')),
  fiscal_year CHAR(7) NOT NULL,              -- Indian FY, e.g. '2026-27'
  next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id, kind, fiscal_year)
);

CREATE TABLE fee_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL,
  agreement_type VARCHAR(30) NOT NULL
    CHECK (agreement_type IN ('fixed', 'retainer', 'milestone', 'per_appearance', 'hybrid')),
  description TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  agreed_amount NUMERIC(14,2) CHECK (agreed_amount >= 0),
  per_appearance_amount NUMERIC(14,2) CHECK (per_appearance_amount >= 0),
  tax_included BOOLEAN NOT NULL DEFAULT false,
  effective_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id)
);
CREATE INDEX idx_fee_agreements_matter ON fee_agreements(organization_id, matter_id);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL,
  matter_id UUID NOT NULL,
  invoice_number VARCHAR(100),               -- assigned on issue from document_sequences
  fiscal_year CHAR(7),
  issue_date DATE,
  due_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void', 'written_off')),

  -- Tax snapshot (D-001). Frozen at issue; org setting changes never rewrite history.
  tax_mode VARCHAR(10) NOT NULL CHECK (tax_mode IN ('simple', 'gst')),
  supplier_gstin VARCHAR(15),
  supplier_state_code CHAR(2),
  recipient_gstin VARCHAR(15),
  recipient_state_code CHAR(2),
  place_of_supply CHAR(2),
  is_reverse_charge BOOLEAN NOT NULL DEFAULT false,

  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  rcm_tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (rcm_tax_amount >= 0), -- disclosed, payable by recipient
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),         -- tax actually charged
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),

  notes TEXT,
  pdf_storage_key TEXT,
  created_by UUID REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  issued_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  void_reason TEXT,
  written_off_at TIMESTAMPTZ,
  written_off_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),

  CHECK (total_amount = subtotal - discount_amount + tax_amount),
  CHECK (discount_amount <= subtotal),
  CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  CHECK (status = 'draft' OR (invoice_number IS NOT NULL AND issue_date IS NOT NULL
                              AND due_date IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (status <> 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  -- simple mode: no GST structure at all
  CHECK (tax_mode = 'gst' OR (cgst_amount = 0 AND sgst_amount = 0 AND igst_amount = 0
                              AND rcm_tax_amount = 0 AND NOT is_reverse_charge)),
  -- gst mode: intra-state (CGST+SGST) xor inter-state (IGST)
  CHECK (tax_mode = 'simple' OR igst_amount = 0 OR (cgst_amount = 0 AND sgst_amount = 0)),
  -- gst mode: forward charge => charged tax is the GST sum; reverse charge => nothing charged
  CHECK (tax_mode = 'simple' OR (
           (NOT is_reverse_charge AND tax_amount = cgst_amount + sgst_amount + igst_amount AND rcm_tax_amount = 0)
        OR (is_reverse_charge AND tax_amount = 0 AND cgst_amount = 0 AND sgst_amount = 0 AND igst_amount = 0))),
  CHECK (tax_mode = 'simple' OR status = 'draft'
         OR (supplier_gstin IS NOT NULL AND supplier_state_code IS NOT NULL AND place_of_supply IS NOT NULL))
);
CREATE UNIQUE INDEX uq_invoices_org_number ON invoices(organization_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX idx_invoices_org_due ON invoices(organization_id, due_date) WHERE status = 'issued';
CREATE INDEX idx_invoices_org_status ON invoices(organization_id, status);
CREATE INDEX idx_invoices_org_client ON invoices(organization_id, client_id);
CREATE INDEX idx_invoices_org_matter ON invoices(organization_id, matter_id);
CREATE INDEX idx_invoices_number_trgm ON invoices USING gin (invoice_number gin_trgm_ops);

CREATE TABLE fee_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  fee_agreement_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  sequence_no INT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  due_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'invoiced', 'waived', 'cancelled')),   -- payment state derives from invoice
  invoice_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, fee_agreement_id) REFERENCES fee_agreements(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  CHECK ((status = 'invoiced') = (invoice_id IS NOT NULL))
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID,
  case_id UUID,
  category VARCHAR(100),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  expense_date DATE NOT NULL,
  description TEXT,
  vendor_name VARCHAR(255),
  billable_to_client BOOLEAN NOT NULL DEFAULT false,
  reimbursable BOOLEAN NOT NULL DEFAULT true,
  document_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'billed', 'void')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id),
  FOREIGN KEY (organization_id, document_id) REFERENCES documents(organization_id, id)
);
CREATE INDEX idx_expenses_org_matter ON expenses(organization_id, matter_id);

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  position INT NOT NULL DEFAULT 0,
  description VARCHAR(500) NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),   -- round_half_up(quantity * unit_price), computed in app
  sac_code VARCHAR(8),
  gst_rate NUMERIC(5,2) CHECK (gst_rate IS NULL OR gst_rate BETWEEN 0 AND 28),
  is_pure_agent BOOLEAN NOT NULL DEFAULT false,         -- reimbursement outside taxable value
  fee_milestone_id UUID,
  expense_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, fee_milestone_id) REFERENCES fee_milestones(organization_id, id),
  FOREIGN KEY (organization_id, expense_id) REFERENCES expenses(organization_id, id)
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(organization_id, invoice_id, position);
CREATE UNIQUE INDEX uq_invoice_items_expense ON invoice_items(expense_id) WHERE expense_id IS NOT NULL;

-- D-002: a payment belongs to a client; allocations settle invoices; remainder = client advance.
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL,
  matter_id UUID,
  receipt_number VARCHAR(100) NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),          -- money actually received
  tds_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0), -- deducted at source by client
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(20) NOT NULL
    CHECK (payment_method IN ('upi', 'bank_transfer', 'cash', 'cheque', 'card', 'other')),
  reference_number VARCHAR(255),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  recorded_by UUID REFERENCES users(id),
  tds_certificate_number VARCHAR(100),
  tds_certificate_received_at DATE,
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id),
  reversal_reason TEXT,
  provider VARCHAR(50),                      -- future online payments
  provider_payment_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receipt_number),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  CHECK (amount + tds_amount > 0),
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX uq_payments_provider ON payments(provider, provider_payment_id) WHERE provider IS NOT NULL;
CREATE INDEX idx_payments_org_date ON payments(organization_id, payment_date);
CREATE INDEX idx_payments_org_client ON payments(organization_id, client_id);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  payment_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
  allocated_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversed_by UUID REFERENCES users(id),
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, payment_id) REFERENCES payments(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL))
);
CREATE INDEX idx_allocations_payment ON payment_allocations(organization_id, payment_id);
CREATE INDEX idx_allocations_invoice ON payment_allocations(organization_id, invoice_id) WHERE status = 'active';

CREATE TABLE credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL,
  credit_note_number VARCHAR(100) NOT NULL,
  issue_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),  -- portion of amount that is tax
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, credit_note_number),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  CHECK (tax_amount <= amount)
);
CREATE INDEX idx_credit_notes_invoice ON credit_notes(organization_id, invoice_id);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID,
  client_id UUID,
  invoice_id UUID,
  payment_id UUID,
  credit_note_id UUID REFERENCES credit_notes(id),
  entry_type VARCHAR(40) NOT NULL CHECK (entry_type IN (
    'invoice_issued', 'invoice_voided', 'invoice_written_off', 'credit_note_issued',
    'payment_received', 'payment_reversed', 'payment_allocated', 'allocation_reversed',
    'expense_recorded', 'expense_voided')),
  debit_account VARCHAR(40) NOT NULL,
  credit_account VARCHAR(40) NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  reverses_entry_id UUID REFERENCES ledger_entries(id),
  actor_user_id UUID REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  FOREIGN KEY (organization_id, payment_id) REFERENCES payments(organization_id, id),
  CHECK (debit_account <> credit_account),
  CHECK (debit_account IN ('accounts_receivable', 'fee_revenue', 'cash_bank', 'tds_receivable',
                           'client_advance', 'gst_output', 'discount', 'bad_debt', 'expense', 'expense_payable')),
  CHECK (credit_account IN ('accounts_receivable', 'fee_revenue', 'cash_bank', 'tds_receivable',
                            'client_advance', 'gst_output', 'discount', 'bad_debt', 'expense', 'expense_payable'))
);
CREATE INDEX idx_ledger_org_matter ON ledger_entries(organization_id, matter_id);
CREATE INDEX idx_ledger_org_client ON ledger_entries(organization_id, client_id);
CREATE INDEX idx_ledger_org_created ON ledger_entries(organization_id, created_at);

-- Derived balances (D-002). Never trust a cached paid/due column.
CREATE VIEW v_invoice_balances AS
SELECT
  i.organization_id,
  i.id AS invoice_id,
  i.status,
  i.total_amount,
  COALESCE(a.paid, 0)::NUMERIC(14,2) AS amount_paid,
  COALESCE(c.credited, 0)::NUMERIC(14,2) AS amount_credited,
  (i.total_amount - COALESCE(a.paid, 0) - COALESCE(c.credited, 0))::NUMERIC(14,2) AS amount_due,
  CASE
    WHEN i.status <> 'issued' THEN NULL
    WHEN i.total_amount - COALESCE(a.paid, 0) - COALESCE(c.credited, 0) <= 0 THEN 'paid'
    WHEN COALESCE(a.paid, 0) + COALESCE(c.credited, 0) > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS payment_state,
  i.due_date
FROM invoices i
LEFT JOIN (
  SELECT pa.invoice_id, SUM(pa.amount) AS paid
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id AND p.status = 'posted'
  WHERE pa.status = 'active'
  GROUP BY pa.invoice_id
) a ON a.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, SUM(amount) AS credited FROM credit_notes GROUP BY invoice_id
) c ON c.invoice_id = i.id;
-- is_overdue is computed in the service against the org's local "today" (timezone-aware),
-- not with CURRENT_DATE in the view.

CREATE VIEW v_payment_unallocated AS
SELECT
  p.organization_id,
  p.id AS payment_id,
  p.client_id,
  (p.amount + p.tds_amount - COALESCE(SUM(pa.amount) FILTER (WHERE pa.status = 'active'), 0))::NUMERIC(14,2)
    AS unallocated_amount
FROM payments p
LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
WHERE p.status = 'posted'
GROUP BY p.id;

-- ---------------------------------------------------------------------------
-- Events, workflows, notifications
-- ---------------------------------------------------------------------------

CREATE TABLE timeline_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID,
  case_id UUID,
  client_id UUID,
  event_type VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  actor_user_id UUID REFERENCES users(id),
  actor_type VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'workflow', 'provider')),
  source_type VARCHAR(50),
  source_id UUID,
  visibility VARCHAR(20) NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'client')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases(organization_id, id),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);
CREATE INDEX idx_timeline_org_matter_date ON timeline_events(organization_id, matter_id, created_at DESC);
CREATE INDEX idx_timeline_org_case_date ON timeline_events(organization_id, case_id, created_at DESC);
CREATE INDEX idx_timeline_org_client_date ON timeline_events(organization_id, client_id, created_at DESC);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,                    -- includes {before, after} for *_CHANGED events
  actor_user_id UUID REFERENCES users(id),
  dedupe_key TEXT UNIQUE,                    -- time-derived events, e.g. 'INVOICE_OVERDUE:<id>:due+7'
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_claimable ON outbox_events(available_at) WHERE status IN ('pending', 'processing');
CREATE INDEX idx_outbox_aggregate ON outbox_events(organization_id, aggregate_type, aggregate_id);

CREATE TABLE workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  system_key VARCHAR(100),                   -- set for seeded default recipes
  name VARCHAR(255) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(100) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"anchor":"hearing.date","offsetDays":-1,"at":"09:00"}
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  requires_approval BOOLEAN NOT NULL DEFAULT false,    -- client emails held as awaiting_approval
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INT NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX uq_workflows_system_key ON workflows(organization_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX idx_workflows_org_trigger ON workflows(organization_id, trigger_type) WHERE is_active;

-- Source of truth for all workflow actions (immediate ones use run_at = now()).
-- BullMQ only executes what a poller moves from here; it never holds future state.
CREATE TABLE scheduled_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  workflow_id UUID,
  workflow_version INT,
  action_index INT,
  action_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(50) NOT NULL,
  target_id UUID NOT NULL,
  source_event_id UUID REFERENCES outbox_events(id),
  idempotency_key TEXT NOT NULL UNIQUE,      -- workflow:action_index:target:run_key
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'queued', 'running', 'done', 'failed', 'cancelled', 'skipped')),
  attempts INT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, workflow_id) REFERENCES workflows(organization_id, id)
);
CREATE INDEX idx_scheduled_actions_due ON scheduled_actions(run_at) WHERE status = 'scheduled';
CREATE INDEX idx_scheduled_actions_target ON scheduled_actions(organization_id, target_type, target_id)
  WHERE status = 'scheduled';

CREATE TABLE email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),   -- null = system default
  template_key VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  event_type VARCHAR(100),
  audience VARCHAR(20) NOT NULL DEFAULT 'client' CHECK (audience IN ('client', 'internal')),
  subject_template TEXT NOT NULL,
  html_body TEXT NOT NULL,                   -- sanitised on save; rendered server-side with escaping
  text_body TEXT,
  variables_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_email_templates_key ON email_templates(COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), template_key);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'push')),
  notification_type VARCHAR(80) NOT NULL,
  recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('client', 'user')),
  recipient_user_id UUID REFERENCES users(id),
  client_id UUID,
  matter_id UUID,
  invoice_id UUID,
  hearing_id UUID,
  template_id UUID REFERENCES email_templates(id),
  scheduled_action_id UUID REFERENCES scheduled_actions(id),
  source_event_id UUID REFERENCES outbox_events(id),
  idempotency_key TEXT UNIQUE,
  destination TEXT,
  subject TEXT,                              -- rendered snapshot: what was (or will be) sent
  body_html TEXT,
  body_text TEXT,
  provider VARCHAR(50),
  provider_message_id TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'awaiting_approval', 'queued', 'sending', 'sent', 'delivered',
    'bounced', 'complained', 'failed', 'skipped', 'cancelled')),
  skip_reason VARCHAR(50),                   -- 'client_opted_out', 'no_destination', ...
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  is_permanent_failure BOOLEAN,
  attempts INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),      -- null for automated
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id),
  FOREIGN KEY (organization_id, matter_id) REFERENCES matters(organization_id, id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id),
  FOREIGN KEY (organization_id, hearing_id) REFERENCES hearings(organization_id, id),
  CHECK (recipient_type <> 'user' OR recipient_user_id IS NOT NULL),
  CHECK (recipient_type <> 'client' OR client_id IS NOT NULL),
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL),
  CHECK (status NOT IN ('sent', 'delivered', 'bounced', 'complained') OR provider_message_id IS NOT NULL)
);
CREATE INDEX idx_notifications_org_created ON notifications(organization_id, created_at DESC);
CREATE INDEX idx_notifications_org_status ON notifications(organization_id, status);
CREATE INDEX idx_notifications_org_matter ON notifications(organization_id, matter_id, created_at DESC);
CREATE INDEX idx_notifications_org_client ON notifications(organization_id, client_id, created_at DESC);
CREATE INDEX idx_notifications_provider_msg ON notifications(provider, provider_message_id);

-- Raw provider callbacks (SES delivery/bounce/complaint via SNS). Append-only.
CREATE TABLE notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id),
  provider VARCHAR(50) NOT NULL,
  provider_message_id TEXT,
  event_type VARCHAR(30) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_events_notification ON notification_events(notification_id);

-- ---------------------------------------------------------------------------
-- Client portal (D-003)
-- ---------------------------------------------------------------------------

CREATE TABLE client_portal_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  client_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  email CITEXT NOT NULL,                     -- address the link was sent to
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);
CREATE INDEX idx_portal_tokens_client ON client_portal_tokens(organization_id, client_id);

CREATE TABLE client_portal_sessions (
  id TEXT PRIMARY KEY,                       -- SHA-256 of cookie token
  organization_id UUID NOT NULL,
  client_id UUID NOT NULL,
  portal_token_id UUID NOT NULL REFERENCES client_portal_tokens(id),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (organization_id, client_id) REFERENCES clients(organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

CREATE TABLE import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('clients', 'matters', 'cases')),
  file_name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'validated'
    CHECK (status IN ('validated', 'committing', 'committed', 'failed', 'discarded')),
  total_rows INT NOT NULL DEFAULT 0,
  valid_rows INT NOT NULL DEFAULT 0,
  error_rows INT NOT NULL DEFAULT 0,
  committed_rows INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE import_job_rows (
  organization_id UUID NOT NULL,
  import_job_id UUID NOT NULL,
  row_number INT NOT NULL,
  raw JSONB NOT NULL,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_entity_id UUID,
  PRIMARY KEY (import_job_id, row_number),
  FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs(organization_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),   -- null for pre-auth security events (failed login)
  actor_user_id UUID REFERENCES users(id),
  actor_type VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'workflow', 'client')),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  before_json JSONB,
  after_json JSONB,
  request_id VARCHAR(64),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_date ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_org_entity ON audit_logs(organization_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Append-only tables
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_credit_notes_append_only BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_notification_events_append_only BEFORE UPDATE OR DELETE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Payments: never deleted; financial fields frozen; only posted -> reversed (and TDS cert tracking) allowed.
CREATE FUNCTION guard_payment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted; reverse instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.tds_amount <> OLD.tds_amount OR NEW.client_id <> OLD.client_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.payment_date <> OLD.payment_date
     OR NEW.payment_method <> OLD.payment_method OR NEW.receipt_number <> OLD.receipt_number
     OR NEW.currency <> OLD.currency
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id THEN
    RAISE EXCEPTION 'posted payment financial fields are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'a reversed payment cannot be reinstated' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_payment_mutation();

-- Allocations: never deleted; only active -> reversed.
CREATE FUNCTION guard_allocation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'allocations cannot be deleted; reverse instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.payment_id <> OLD.payment_id OR NEW.invoice_id <> OLD.invoice_id
     OR OLD.status = 'reversed' THEN
    RAISE EXCEPTION 'allocations are immutable except active -> reversed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_allocations_guard BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_allocation_mutation();

-- Invoices: never deleted once issued; issued financial/tax fields frozen; lifecycle only moves forward.
CREATE FUNCTION guard_invoice_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.subtotal <> OLD.subtotal OR NEW.discount_amount <> OLD.discount_amount
       OR NEW.tax_amount <> OLD.tax_amount OR NEW.total_amount <> OLD.total_amount
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
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION guard_invoice_mutation();

-- Invoice items are frozen once the parent invoice is issued.
CREATE FUNCTION guard_invoice_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT;
BEGIN
  SELECT status INTO parent_status FROM invoices
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'items of a non-draft invoice are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER trg_invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION guard_invoice_item_mutation();

-- updated_at maintenance
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'users', 'organization_members', 'clients', 'matters', 'courts', 'cases',
    'case_parties', 'advocates', 'hearings', 'tasks', 'documents', 'fee_agreements', 'fee_milestones',
    'invoices', 'expenses', 'payments', 'workflows', 'scheduled_actions', 'email_templates',
    'notifications', 'import_jobs', 'user_notification_prefs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

