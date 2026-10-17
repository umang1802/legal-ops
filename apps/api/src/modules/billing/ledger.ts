import { fromPaise } from '@legalops/validation';
import { query, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';

type Account =
  | 'accounts_receivable'
  | 'fee_revenue'
  | 'cash_bank'
  | 'tds_receivable'
  | 'client_advance'
  | 'gst_output'
  | 'discount'
  | 'bad_debt'
  | 'expense'
  | 'expense_payable';

export type LedgerEntry = {
  entryType:
    | 'invoice_issued'
    | 'invoice_voided'
    | 'invoice_written_off'
    | 'credit_note_issued'
    | 'payment_received'
    | 'payment_reversed'
    | 'payment_allocated'
    | 'allocation_reversed'
    | 'expense_recorded'
    | 'expense_voided';
  debit: Account;
  credit: Account;
  amountPaise: number;
  matterId?: string | null;
  clientId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  creditNoteId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends double-entry style rows (PRD §7.6). ledger_entries is append-only at the DB level;
 * corrections are new contra entries, never edits. Zero amounts are skipped.
 */
export async function postLedger(
  db: Db,
  organizationId: string,
  actorUserId: string | null,
  entries: LedgerEntry[],
) {
  for (const e of entries) {
    if (e.amountPaise === 0) continue;
    if (e.amountPaise < 0) throw new Error('Ledger amounts must be positive; use a contra entry');
    await query(
      db,
      sql`INSERT INTO ledger_entries (organization_id, matter_id, client_id, invoice_id, payment_id, credit_note_id,
                                      entry_type, debit_account, credit_account, amount, actor_user_id, metadata)
          VALUES (${organizationId}, ${e.matterId ?? null}, ${e.clientId ?? null}, ${e.invoiceId ?? null},
                  ${e.paymentId ?? null}, ${e.creditNoteId ?? null}, ${e.entryType}, ${e.debit}, ${e.credit},
                  ${fromPaise(e.amountPaise)}, ${actorUserId}, ${JSON.stringify(e.metadata ?? {})})`,
    );
  }
}
