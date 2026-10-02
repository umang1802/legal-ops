-- LegalOps V1 PostgreSQL schema
-- SUPERSEDED by packages/db/migrations/0001_init.sql (see docs/gap-analysis.md, docs/decisions.md). Kept for reference only.
-- Extracted from legalops_v1_prd.md

CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  legal_name VARCHAR(255),
  email VARCHAR(320),
  phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) NOT NULL DEFAULT 'India',
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'LGL',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
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
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

CREATE TABLE clients (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_type VARCHAR(20) NOT NULL DEFAULT 'person',
  name VARCHAR(255) NOT NULL,
  email VARCHAR(320),
  phone VARCHAR(40),
  alternate_phone VARCHAR(40),
  address TEXT,
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120) DEFAULT 'India',
  notes TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  email_verified_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_org_name ON clients(organization_id, name);
CREATE INDEX idx_clients_org_email ON clients(organization_id, email);
CREATE INDEX idx_clients_org_phone ON clients(organization_id, phone);

CREATE TABLE matters (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  title VARCHAR(255) NOT NULL,
  reference_code VARCHAR(100),
  practice_area VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  responsible_lawyer_id UUID REFERENCES users(id),
  start_date DATE,
  close_date DATE,
  internal_notes TEXT,
  client_summary TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_matters_org_status ON matters(organization_id, status);
CREATE INDEX idx_matters_org_client ON matters(organization_id, client_id);
CREATE INDEX idx_matters_org_lawyer ON matters(organization_id, responsible_lawyer_id);

CREATE TABLE matter_staff (
  matter_id UUID NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  role VARCHAR(30) NOT NULL DEFAULT 'support',
  PRIMARY KEY (matter_id, user_id)
);

CREATE TABLE courts (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
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

CREATE TABLE cases (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  court_id UUID REFERENCES courts(id),
  title VARCHAR(255) NOT NULL,
  case_number VARCHAR(150),
  cnr VARCHAR(150),
  case_type VARCHAR(100),
  filing_date DATE,
  registration_date DATE,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  judge_bench VARCHAR(255),
  next_hearing_date DATE,
  external_provider VARCHAR(50),
  external_id VARCHAR(255),
  external_url TEXT,
  last_synced_at TIMESTAMPTZ,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cases_org_cnr ON cases(organization_id, cnr);
CREATE INDEX idx_cases_org_case_number ON cases(organization_id, case_number);
CREATE INDEX idx_cases_org_next_hearing ON cases(organization_id, next_hearing_date);
CREATE INDEX idx_cases_org_matter ON cases(organization_id, matter_id);

CREATE TABLE case_parties (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  party_type VARCHAR(100),
  side VARCHAR(50),
  is_client BOOLEAN NOT NULL DEFAULT false,
  email VARCHAR(320),
  phone VARCHAR(40),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_parties_case ON case_parties(case_id);

CREATE TABLE advocates (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  firm_name VARCHAR(255),
  phone VARCHAR(40),
  email VARCHAR(320),
  side VARCHAR(50),
  is_internal BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE case_advocates (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  advocate_id UUID NOT NULL REFERENCES advocates(id) ON DELETE CASCADE,
  PRIMARY KEY (case_id, advocate_id)
);

CREATE TABLE hearings (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  case_id UUID NOT NULL REFERENCES cases(id),
  scheduled_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  courtroom VARCHAR(100),
  bench_judge VARCHAR(255),
  hearing_type VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled',
  outcome TEXT,
  next_hearing_date DATE,
  notes TEXT,
  source_provider VARCHAR(50),
  external_id VARCHAR(255),
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hearings_org_date ON hearings(organization_id, scheduled_date);
CREATE INDEX idx_hearings_case_date ON hearings(case_id, scheduled_date);
CREATE INDEX idx_hearings_org_status ON hearings(organization_id, status);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assignee_id UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(30) NOT NULL DEFAULT 'todo',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_org_due ON tasks(organization_id, due_at);
CREATE INDEX idx_tasks_org_assignee_status ON tasks(organization_id, assignee_id, status);

CREATE TABLE documents (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  mime_type VARCHAR(100),
  size_bytes BIGINT,
  storage_provider VARCHAR(50) NOT NULL,
  storage_key TEXT NOT NULL,
  visibility VARCHAR(30) NOT NULL DEFAULT 'internal',
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_documents_org_matter ON documents(organization_id, matter_id);
CREATE INDEX idx_documents_org_case ON documents(organization_id, case_id);

CREATE TABLE fee_agreements (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  agreement_type VARCHAR(30) NOT NULL,
  description TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  agreed_amount NUMERIC(14,2),
  tax_included BOOLEAN NOT NULL DEFAULT false,
  effective_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fee_milestones (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  fee_agreement_id UUID NOT NULL REFERENCES fee_agreements(id),
  name VARCHAR(255) NOT NULL,
  sequence_no INT,
  amount NUMERIC(14,2) NOT NULL,
  due_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'planned',
  invoice_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  invoice_number VARCHAR(100) NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  subtotal NUMERIC(14,2) NOT NULL,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14,2) NOT NULL,
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(14,2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  notes TEXT,
  pdf_storage_key TEXT,
  created_by UUID REFERENCES users(id),
  issued_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, invoice_number)
);

CREATE INDEX idx_invoices_org_due ON invoices(organization_id, due_date);
CREATE INDEX idx_invoices_org_status ON invoices(organization_id, status);
CREATE INDEX idx_invoices_org_client ON invoices(organization_id, client_id);
CREATE INDEX idx_invoices_org_matter ON invoices(organization_id, matter_id);

CREATE TABLE invoice_items (
  id UUID PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(14,2) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  fee_milestone_id UUID REFERENCES fee_milestones(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  matter_id UUID NOT NULL REFERENCES matters(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  payment_date DATE NOT NULL,
  payment_method VARCHAR(30) NOT NULL,
  reference_number VARCHAR(255),
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'posted',
  recorded_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_org_date ON payments(organization_id, payment_date);
CREATE INDEX idx_payments_org_invoice ON payments(organization_id, invoice_id);
CREATE INDEX idx_payments_org_client ON payments(organization_id, client_id);

CREATE TABLE expenses (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  category VARCHAR(100),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  expense_date DATE NOT NULL,
  description TEXT,
  vendor_name VARCHAR(255),
  billable_to_client BOOLEAN NOT NULL DEFAULT false,
  reimbursable BOOLEAN NOT NULL DEFAULT true,
  document_id UUID REFERENCES documents(id),
  status VARCHAR(20) NOT NULL DEFAULT 'recorded',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  client_id UUID REFERENCES clients(id),
  invoice_id UUID REFERENCES invoices(id),
  payment_id UUID REFERENCES payments(id),
  entry_type VARCHAR(50) NOT NULL,
  debit_account VARCHAR(50),
  credit_account VARCHAR(50),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  reference_type VARCHAR(50),
  reference_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_org_matter ON ledger_entries(organization_id, matter_id);
CREATE INDEX idx_ledger_org_client ON ledger_entries(organization_id, client_id);
CREATE INDEX idx_ledger_org_created ON ledger_entries(organization_id, created_at);

CREATE TABLE timeline_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  matter_id UUID REFERENCES matters(id),
  case_id UUID REFERENCES cases(id),
  client_id UUID REFERENCES clients(id),
  event_type VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  actor_user_id UUID REFERENCES users(id),
  source_type VARCHAR(50),
  source_id UUID,
  visibility VARCHAR(20) NOT NULL DEFAULT 'internal',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_org_matter_date ON timeline_events(organization_id, matter_id, created_at DESC);
CREATE INDEX idx_timeline_org_case_date ON timeline_events(organization_id, case_id, created_at DESC);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  event_type VARCHAR(100) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox_events(status, available_at);

CREATE TABLE workflows (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(100) NOT NULL,
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_org_trigger ON workflows(organization_id, trigger_type, is_active);

CREATE TABLE scheduled_actions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  workflow_id UUID REFERENCES workflows(id),
  action_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id UUID,
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  attempts INT NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_actions_due ON scheduled_actions(status, run_at);

CREATE TABLE email_templates (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name VARCHAR(255) NOT NULL,
  event_type VARCHAR(100),
  subject_template TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  variables_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  channel VARCHAR(30) NOT NULL,
  notification_type VARCHAR(80) NOT NULL,
  recipient_user_id UUID REFERENCES users(id),
  client_id UUID REFERENCES clients(id),
  matter_id UUID REFERENCES matters(id),
  template_id UUID REFERENCES email_templates(id),
  subject TEXT,
  destination TEXT,
  provider_message_id TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  source_event_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_org_created ON notifications(organization_id, created_at DESC);
CREATE INDEX idx_notifications_org_status ON notifications(organization_id, status);
CREATE INDEX idx_notifications_matter_created ON notifications(matter_id, created_at DESC);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  before_json JSONB,
  after_json JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_org_date ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_org_entity ON audit_logs(organization_id, entity_type, entity_id);
