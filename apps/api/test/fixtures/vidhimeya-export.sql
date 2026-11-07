-- A small Cloudflare D1 export of the old Vidhimeya invoice app, for the importer tests.
-- Schema: vidhimeya-invoice/migrations/0001..0004 verbatim; data below is fictional.
PRAGMA defer_foreign_keys=TRUE;
-- Money is always integer paise. Dates are 'YYYY-MM-DD' in IST; timestamps are ISO-8601 UTC.

CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  contact_person TEXT,
  email       TEXT NOT NULL,
  cc_emails   TEXT,               -- comma-separated, optional
  phone       TEXT,
  address     TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT UNIQUE,                       -- assigned when first sent; NULL while draft
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  issue_date   TEXT NOT NULL,
  subject      TEXT,                              -- e.g. matter / engagement reference
  notes        TEXT,                              -- printed on the invoice
  total_paise  INTEGER NOT NULL CHECK (total_paise > 0),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','cancelled')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at      TEXT,
  cancelled_at TEXT
);
CREATE INDEX idx_invoices_client ON invoices(client_id);

CREATE TABLE invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  description  TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0)
);
CREATE INDEX idx_items_invoice ON invoice_items(invoice_id);

-- Every invoice has >= 1 instalment; an unsplit invoice is one instalment for the full amount.
CREATE TABLE instalments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  amount_paise      INTEGER NOT NULL CHECK (amount_paise > 0),
  due_date          TEXT NOT NULL,
  zoho_link_id      TEXT,
  zoho_link_url     TEXT,
  zoho_link_paise   INTEGER,                      -- amount the current link was created for
  zoho_link_expires TEXT,
  emailed_at        TEXT,                         -- last time a payment email went out for it
  UNIQUE (invoice_id, seq)
);
CREATE INDEX idx_instalments_link ON instalments(zoho_link_id);

CREATE TABLE payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  instalment_id   INTEGER NOT NULL REFERENCES instalments(id) ON DELETE CASCADE,
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  method          TEXT NOT NULL CHECK (method IN ('zoho','bank_transfer','upi','cheque','cash','other')),
  reference       TEXT,
  zoho_payment_id TEXT UNIQUE,
  zoho_link_id    TEXT UNIQUE,                    -- a link is paid at most once: idempotency for webhook + polling
  paid_on         TEXT NOT NULL,
  recorded_by     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);

CREATE TABLE email_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  instalment_id INTEGER,
  kind          TEXT NOT NULL,                    -- invoice | instalment | receipt
  to_addr       TEXT NOT NULL,
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL,                    -- sent | failed | dev_logged
  error         TEXT,
  provider_id   TEXT,
  triggered_by  TEXT NOT NULL,                    -- user email or 'scheduler'
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_email_invoice ON email_log(invoice_id);

CREATE TABLE webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Firm profile, numbering counters, OAuth tokens.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Authorised signatories (the partners who can sign in) and DSC-signed invoice PDFs.

CREATE TABLE users (
  email          TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  designation    TEXT NOT NULL DEFAULT 'Authorized Signatory',
  signature      BLOB,               -- optional scanned signature image
  signature_type TEXT,               -- image/png | image/jpeg
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT OR IGNORE INTO users (email, name) VALUES
  ('alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan'),
  ('shweta@vidhimeyaadvisory.com', 'Shweta Srivastava'),
  ('prashast@vidhimeyaadvisory.com', 'Prashast'),
  ('shane@vidhimeyaadvisory.com', 'Shane');

-- Snapshot of the signatory at the time the invoice was saved, so later profile edits don't rewrite old invoices.
ALTER TABLE invoices ADD COLUMN signatory_email TEXT;
ALTER TABLE invoices ADD COLUMN signatory_name TEXT;
ALTER TABLE invoices ADD COLUMN signatory_designation TEXT;
ALTER TABLE invoices ADD COLUMN sign_with_image INTEGER NOT NULL DEFAULT 0;

-- A DSC-signed copy of the invoice uploaded by a partner; when present it is the PDF clients receive.
CREATE TABLE invoice_documents (
  invoice_id  INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  pdf         BLOB NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Sent invoices can be revised in place; the number stays, a revision counter and date are kept.
ALTER TABLE invoices ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN revised_at TEXT;

-- How the client is addressed in emails, e.g. "Respected" + "Mr." -> "Respected Mr. Rohan Mehta,". Both optional.
ALTER TABLE clients ADD COLUMN salutation TEXT;
ALTER TABLE clients ADD COLUMN title TEXT;

-- ---- Data ----
UPDATE users SET designation = 'Managing Partner',
  signature = X'89504E470D0A1A0A0000000D49484452000000010000000108000000003A7E9B550000000A49444154789C636000000002000148AFA4710000000049454E44AE426082',
  signature_type = 'image/png'
WHERE email = 'alokchauhan@vidhimeyaadvisory.com';
UPDATE users SET designation = 'Partner' WHERE email = 'shweta@vidhimeyaadvisory.com';

INSERT INTO settings (key, value) VALUES ('firm', '{"name":"Vidhimeya Corporate Advisory LLP","invoice_prefix":"VMA"}');
INSERT INTO settings (key, value) VALUES ('seq:VA:2025-26', '12');
INSERT INTO settings (key, value) VALUES ('seq:VMA:2026-27', '7');

-- Client 1 matches an existing LexForgeX client by email (different case).
INSERT INTO clients (id, name, contact_person, email, cc_emails, phone, address, notes, salutation, title) VALUES
  (1, 'Acme Pvt Ltd', 'Rohan Mehta', 'Accounts@Acme.test', 'cfo@acme.test, legal@acme.test', '+91 98100 00001', 'Plot 4, Sector 18, Gurgaon', NULL, 'Respected', 'Mr.'),
  (2, 'Priya Nair', NULL, 'priya@nair.test', NULL, '+91 98100 00002', 'Bandra West, Mumbai', 'Refers other founders', 'Dear', 'dr'),
  (3, 'Zenith Holdings', 'Accounts team', 'ops@zenith.test', '', NULL, NULL, NULL, 'Hello', 'Sir');

-- Invoices: 1 older prefix (VA), sent + paid; 2 three instalments, Zoho-paid first, active link on the second,
-- signed with the scanned image, DSC copy, revised once; 3 no subject, one instalment, part paid by cheque;
-- 4 cancelled after sending; 5 three instalments, second paid before the first; 6 numbered draft;
-- 7 cancelled while still a draft; 8 one instalment, a paid Zoho link and an open one.
INSERT INTO invoices (id, number, client_id, issue_date, subject, notes, total_paise, status, created_by, created_at, sent_at, cancelled_at,
                      signatory_email, signatory_name, signatory_designation, sign_with_image, revision, revised_at) VALUES
  (1, 'VA/2025-26/012', 2, '2026-02-10', 'Trademark filing', NULL, 5000000, 'sent', 'alokchauhan@vidhimeyaadvisory.com', '2026-02-10T05:00:00Z', '2026-02-10T05:30:00Z', NULL,
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 0, 0, NULL),
  (2, 'VMA/2026-27/001', 1, '2026-04-05', 'Annual compliance FY26', 'Payable in three parts', 12000000, 'sent', 'alokchauhan@vidhimeyaadvisory.com', '2026-04-05T05:00:00Z', '2026-04-05T06:00:00Z', NULL,
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 1, 1, '2026-04-07T09:00:00Z'),
  (3, 'VMA/2026-27/002', 1, '2026-05-10', NULL, NULL, 2500000, 'sent', 'shweta@vidhimeyaadvisory.com', '2026-05-10T05:00:00Z', '2026-05-10T05:10:00Z', NULL,
      'shweta@vidhimeyaadvisory.com', 'Shweta Srivastava', 'Partner', 0, 0, NULL),
  (4, 'VMA/2026-27/003', 2, '2026-06-01', 'Trademark filing', NULL, 1500000, 'cancelled', 'alokchauhan@vidhimeyaadvisory.com', '2026-06-01T05:00:00Z', '2026-06-01T05:10:00Z', '2026-06-03T05:00:00Z',
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 0, 0, NULL),
  (5, 'VMA/2026-27/004', 3, '2026-07-01', 'Due diligence', NULL, 9000000, 'sent', 'prashast@vidhimeyaadvisory.com', '2026-07-01T05:00:00Z', '2026-07-01T05:10:00Z', NULL,
      'prashast@vidhimeyaadvisory.com', 'Prashast', 'Authorized Signatory', 0, 0, NULL),
  (6, 'VMA/2026-27/005', 3, '2026-08-01', 'Due diligence', NULL, 2000000, 'draft', 'alokchauhan@vidhimeyaadvisory.com', '2026-08-01T05:00:00Z', NULL, NULL,
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 0, 0, NULL),
  (7, 'VMA/2026-27/006', 3, '2026-09-01', NULL, NULL, 500000, 'cancelled', 'alokchauhan@vidhimeyaadvisory.com', '2026-09-01T05:00:00Z', NULL, '2026-09-02T05:00:00Z',
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 0, 0, NULL),
  (8, 'VMA/2026-27/007', 2, '2026-10-01', 'Advisory retainer', NULL, 3000000, 'sent', 'alokchauhan@vidhimeyaadvisory.com', '2026-10-01T05:00:00Z', '2026-10-01T05:10:00Z', NULL,
      'alokchauhan@vidhimeyaadvisory.com', 'Alok Chauhan', 'Managing Partner', 0, 0, NULL);

INSERT INTO invoice_items (invoice_id, position, description, amount_paise) VALUES
  (1, 1, 'Trademark application, class 45', 5000000),
  (2, 1, 'ROC annual filings', 8000000),
  (2, 2, 'Board meeting minutes', 4000000),
  (3, 1, 'Advisory call', 2500000),
  (4, 1, 'Trademark opposition reply', 1500000),
  (5, 1, 'Legal due diligence report', 9000000),
  (6, 1, 'Supplementary due diligence', 2000000),
  (7, 1, 'Notarisation', 500000),
  (8, 1, 'Monthly retainer, October', 3000000);

INSERT INTO instalments (id, invoice_id, seq, amount_paise, due_date, zoho_link_id, zoho_link_url, zoho_link_paise, zoho_link_expires, emailed_at) VALUES
  (1, 1, 1, 5000000, '2026-02-25', NULL, NULL, NULL, NULL, NULL),
  (2, 2, 1, 4000000, '2026-05-05', 'ZL-1', 'https://payments.zoho.in/paymentlinks/zl1', 4000000, '2026-05-12', '2026-04-05T06:00:00Z'),
  (3, 2, 2, 4000000, '2026-12-05', 'ZL-2', 'https://payments.zoho.in/paymentlinks/zl2', 4000000, '2026-12-12', NULL),
  (4, 2, 3, 4000000, '2027-01-05', NULL, NULL, NULL, NULL, NULL),
  (5, 3, 1, 2500000, '2026-05-25', NULL, NULL, NULL, NULL, NULL),
  (6, 4, 1, 1500000, '2026-06-16', NULL, NULL, NULL, NULL, NULL),
  (7, 5, 1, 3000000, '2026-07-31', NULL, NULL, NULL, NULL, '2026-07-01T05:10:00Z'),
  (8, 5, 2, 3000000, '2026-08-31', NULL, NULL, NULL, NULL, '2026-08-28T04:30:00Z'),
  (9, 5, 3, 3000000, '2026-12-31', NULL, NULL, NULL, NULL, NULL),
  (10, 6, 1, 2000000, '2026-12-15', NULL, NULL, NULL, NULL, NULL),
  (11, 7, 1, 500000, '2026-09-16', NULL, NULL, NULL, NULL, NULL),
  (12, 8, 1, 3000000, '2026-12-31', 'ZL-4', 'https://payments.zoho.in/paymentlinks/zl4', 1500000, '2027-01-07', '2026-10-15T08:00:00Z');

INSERT INTO payments (id, invoice_id, instalment_id, amount_paise, method, reference, zoho_payment_id, zoho_link_id, paid_on, recorded_by, created_at) VALUES
  (1, 1, 1, 5000000, 'bank_transfer', 'UTR0001', NULL, NULL, '2026-02-20', 'alokchauhan@vidhimeyaadvisory.com', '2026-02-20T10:00:00Z'),
  (2, 2, 2, 4000000, 'zoho', NULL, 'ZP-1001', 'ZL-1', '2026-05-03', 'scheduler', '2026-05-03T10:00:00Z'),
  (3, 3, 5, 1000000, 'cheque', 'CHQ 456789', NULL, NULL, '2026-06-01', 'shweta@vidhimeyaadvisory.com', '2026-06-01T10:00:00Z'),
  (4, 5, 8, 3000000, 'bank_transfer', 'UTR0004', NULL, NULL, '2026-08-20', 'alokchauhan@vidhimeyaadvisory.com', '2026-08-20T10:00:00Z'),
  (5, 8, 12, 500000, 'upi', 'UPI-77', NULL, NULL, '2026-10-10', 'alokchauhan@vidhimeyaadvisory.com', '2026-10-10T10:00:00Z'),
  (6, 8, 12, 1000000, 'zoho', NULL, 'ZP-1006', 'ZL-3', '2026-10-15', 'scheduler', '2026-10-15T10:00:00Z');

INSERT INTO email_log (invoice_id, instalment_id, kind, to_addr, subject, status, error, provider_id, triggered_by, created_at) VALUES
  (2, NULL, 'invoice', 'Accounts@Acme.test', 'Invoice VMA/2026-27/001 from Vidhimeya', 'sent', NULL, 'gm-1', 'alokchauhan@vidhimeyaadvisory.com', '2026-04-05T06:00:00Z'),
  (2, 2, 'receipt', 'Accounts@Acme.test', 'Payment received for VMA/2026-27/001', 'sent', NULL, 'gm-2', 'scheduler', '2026-05-03T10:05:00Z'),
  (5, 8, 'instalment', 'ops@zenith.test', 'Instalment 2 of VMA/2026-27/004', 'failed', 'quota', NULL, 'scheduler', '2026-08-28T04:30:00Z');

INSERT INTO invoice_documents (invoice_id, pdf, size_bytes, uploaded_by, uploaded_at) VALUES
  (2, X'255044462D312E340A312030206F626A203C3C202F54797065202F536967202F46696C746572202F41646F62652E50504B4C697465202F53756246696C746572202F616462652E706B6373372E6465746163686564202F4279746552616E6765205B302031302032302033305D203E3E20656E646F626A0A2525454F460A', 126, 'alokchauhan@vidhimeyaadvisory.com', '2026-04-07T10:00:00Z');
