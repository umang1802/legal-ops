/**
 * Reads a `wrangler d1 export` of the old Vidhimeya invoice app (SQLite SQL text) into plain rows. Uses Node's built-in
 * `node:sqlite` (experimental in Node 22, no native dependency): the SQL is executed into an in-memory database and read
 * back. Money stays integer paise, dates stay 'YYYY-MM-DD', timestamps stay ISO-8601 UTC text.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type OldClient = {
  id: number;
  name: string;
  contact_person: string | null;
  email: string;
  cc_emails: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  /** The greeting WORD in the old app ("Dear", "Respected"). */
  salutation: string | null;
  /** The honorific in the old app ("Mr.", "Dr."). */
  title: string | null;
};

export type OldInvoice = {
  id: number;
  number: string | null;
  client_id: number;
  issue_date: string;
  subject: string | null;
  notes: string | null;
  total_paise: number;
  status: 'draft' | 'sent' | 'cancelled';
  created_by: string;
  created_at: string;
  sent_at: string | null;
  cancelled_at: string | null;
  signatory_email: string | null;
  signatory_name: string | null;
  signatory_designation: string | null;
  sign_with_image: number;
  revision: number;
  revised_at: string | null;
};

export type OldItem = { invoice_id: number; position: number; description: string; amount_paise: number };

export type OldInstalment = {
  id: number;
  invoice_id: number;
  seq: number;
  amount_paise: number;
  due_date: string;
  zoho_link_id: string | null;
  zoho_link_url: string | null;
  zoho_link_paise: number | null;
  zoho_link_expires: string | null;
  emailed_at: string | null;
};

export type OldPayment = {
  id: number;
  invoice_id: number;
  instalment_id: number;
  amount_paise: number;
  method: 'zoho' | 'bank_transfer' | 'upi' | 'cheque' | 'cash' | 'other';
  reference: string | null;
  zoho_payment_id: string | null;
  zoho_link_id: string | null;
  paid_on: string;
  recorded_by: string;
  created_at: string;
};

export type OldEmail = {
  id: number;
  invoice_id: number | null;
  kind: string;
  to_addr: string;
  subject: string;
  status: string;
  triggered_by: string;
  provider_id: string | null;
  created_at: string;
};

export type OldUser = {
  email: string;
  name: string;
  designation: string;
  signature: Buffer | null;
  signature_type: string | null;
};

export type OldDocument = {
  invoice_id: number;
  pdf: Buffer;
  size_bytes: number;
  uploaded_by: string;
  uploaded_at: string;
};

export type OldData = {
  clients: OldClient[];
  invoices: OldInvoice[];
  items: OldItem[];
  instalments: OldInstalment[];
  payments: OldPayment[];
  emails: OldEmail[];
  users: OldUser[];
  documents: OldDocument[];
  /** The old app's numbering counters, settings rows `seq:{prefix}:{fy}` = the last number it handed out. */
  counters: { prefix: string; fiscalYear: string; value: number }[];
};

/** `node:sqlite` prints an ExperimentalWarning on first load; that is expected for this one-off tool, so mute just that. */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const blob = (v: unknown): Buffer | null => (v == null ? null : Buffer.from(v as Uint8Array));

function all<T>(db: DatabaseSync, q: string): T[] {
  return db.prepare(q).all() as unknown as T[];
}

/** Loads the export SQL into an in-memory SQLite database and reads every table the importer needs. */
export function readExport(path: string): OldData {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(path, 'utf8'));
    return {
      clients: all<OldClient>(db, 'SELECT * FROM clients ORDER BY id'),
      invoices: all<OldInvoice>(db, 'SELECT * FROM invoices ORDER BY id'),
      items: all<OldItem>(
        db,
        'SELECT invoice_id, position, description, amount_paise FROM invoice_items ORDER BY invoice_id, position, id',
      ),
      instalments: all<OldInstalment>(db, 'SELECT * FROM instalments ORDER BY invoice_id, seq'),
      payments: all<OldPayment>(db, 'SELECT * FROM payments ORDER BY paid_on, id'),
      emails: all<OldEmail>(db, 'SELECT * FROM email_log ORDER BY created_at, id'),
      users: all<Record<string, unknown>>(db, 'SELECT * FROM users ORDER BY email').map((u) => ({
        email: String(u.email),
        name: String(u.name),
        designation: String(u.designation),
        signature: blob(u.signature),
        signature_type: (u.signature_type as string | null) ?? null,
      })),
      documents: all<Record<string, unknown>>(db, 'SELECT * FROM invoice_documents ORDER BY invoice_id').map(
        (d) => ({
          invoice_id: Number(d.invoice_id),
          pdf: blob(d.pdf)!,
          size_bytes: Number(d.size_bytes),
          uploaded_by: String(d.uploaded_by),
          uploaded_at: String(d.uploaded_at),
        }),
      ),
      counters: all<{ key: string; value: string }>(
        db,
        "SELECT key, value FROM settings WHERE key LIKE 'seq:%' ORDER BY key",
      )
        .map((r) => ({ m: /^seq:(.+):(\d{4}-\d{2})$/.exec(r.key), value: Number(r.value) }))
        .filter((r) => r.m && Number.isFinite(r.value))
        .map((r) => ({ prefix: r.m![1]!, fiscalYear: r.m![2]!, value: r.value })),
    };
  } finally {
    db.close();
  }
}
