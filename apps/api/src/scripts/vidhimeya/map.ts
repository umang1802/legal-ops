/** Pure mapping rules from the old Vidhimeya app to LexForgeX (spec §10). No I/O here. */
import type { PaymentMethod } from '@legalops/types';
import type { OldInstalment, OldPayment } from './read-export.js';

export const SALUTATIONS = ['Mr', 'Ms', 'Mrs', 'Dr', 'Adv', 'M/s'] as const;
export type Salutation = (typeof SALUTATIONS)[number];

/**
 * The old `title` is the honorific ("Mr.", "dr", "M/s."). It maps to the new `salutation` enum, case-insensitive and
 * without a trailing dot; anything else maps to null (the caller reports it).
 */
export function mapHonorific(title: string | null): {
  salutation: Salutation | null;
  unmapped: string | null;
} {
  const raw = title?.trim() ?? '';
  if (!raw) return { salutation: null, unmapped: null };
  const key = raw.replace(/\.+$/, '').toLowerCase();
  const hit = SALUTATIONS.find((s) => s.toLowerCase() === key);
  return hit ? { salutation: hit, unmapped: null } : { salutation: null, unmapped: raw };
}

/** "a@x.test, b@x.test" -> ['a@x.test', 'b@x.test']; LexForgeX keeps at most 5. */
export function splitCc(cc: string | null): { emails: string[]; dropped: string[] } {
  const all = [
    ...new Set(
      (cc ?? '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
    ),
  ];
  return { emails: all.slice(0, 5), dropped: all.slice(5) };
}

/** "VMA/2026-27/007" -> prefix VMA, FY 2026-27, value 7. Null when the number doesn't follow the old pattern. */
export function parseNumber(n: string): { prefix: string; fiscalYear: string; value: number } | null {
  const m = /^(.+)\/(\d{4}-\d{2})\/(\d+)$/.exec(n);
  return m ? { prefix: m[1]!, fiscalYear: m[2]!, value: Number(m[3]) } : null;
}

/** Old `zoho` is an online payment: method `other` with provider `zohopay`. Every other method maps as is. */
export function mapMethod(m: OldPayment['method']): { method: PaymentMethod; provider: 'zohopay' | null } {
  return m === 'zoho' ? { method: 'other', provider: 'zohopay' } : { method: m, provider: null };
}

/** Matter per client per subject; no subject -> "Advisory: {client}". Titles fit VARCHAR(255). */
export function matterTitle(subject: string | null, clientName: string): string {
  const s = subject?.trim();
  return (s ? s : `Advisory: ${clientName}`).slice(0, 255);
}

/**
 * True when some payment went to a later instalment while an earlier one was not yet covered by its own payments
 * (as of that payment). LexForgeX derives instalment status in seq order, so such invoices may show differently.
 */
export function paidOutOfOrder(instalments: OldInstalment[], payments: OldPayment[]): boolean {
  if (instalments.length < 2) return false;
  const seqOf = new Map(instalments.map((i) => [i.id, i.seq]));
  const sorted = [...payments].sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.id - b.id);
  const paid = new Map<number, number>();
  for (const p of sorted) {
    const seq = seqOf.get(p.instalment_id) ?? 0;
    const earlierOpen = instalments.some((i) => i.seq < seq && (paid.get(i.id) ?? 0) < i.amount_paise);
    if (earlierOpen) return true;
    paid.set(p.instalment_id, (paid.get(p.instalment_id) ?? 0) + p.amount_paise);
  }
  return false;
}
