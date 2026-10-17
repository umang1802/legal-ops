import { fiscalYear } from '@legalops/validation';
import { queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';

export type SequenceKind = 'invoice' | 'receipt' | 'credit_note';

/**
 * Next number in a gapless per-firm, per-financial-year sequence. The upsert row-locks the
 * sequence until the surrounding transaction ends, so concurrent issues serialise and a rolled-back
 * transaction gives its number back (GST requires consecutive invoice numbering).
 */
export async function nextDocumentNumber(
  db: Db,
  organizationId: string,
  kind: SequenceKind,
  date: string,
  prefix: string,
): Promise<{ number: string; fiscalYear: string }> {
  const fy = fiscalYear(date);
  const row = await queryOne<{ n: string }>(
    db,
    sql`INSERT INTO document_sequences (organization_id, kind, fiscal_year, next_value)
        VALUES (${organizationId}, ${kind}, ${fy}, 2)
        ON CONFLICT (organization_id, kind, fiscal_year)
        DO UPDATE SET next_value = document_sequences.next_value + 1
        RETURNING (next_value - 1)::text AS n`,
  );
  return { number: `${prefix}/${fy}/${row!.n.padStart(6, '0')}`, fiscalYear: fy };
}

export const RECEIPT_PREFIX = 'RCPT';
export const CREDIT_NOTE_PREFIX = 'CN';
