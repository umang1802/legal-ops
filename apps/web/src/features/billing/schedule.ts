import { fromPaise, toPaise } from '@legalops/validation';
import type { InstalmentStatus } from '@legalops/types';

/** One editable row of the instalment schedule. `amount` is what the user typed (rupees). */
export type ScheduleRow = {
  key: string;
  amount: string;
  dueDate: string;
  /** Set on rows loaded from an issued invoice (revision mode). */
  status?: InstalmentStatus;
  paid?: string;
};

export const MIN_INSTALMENTS = 2;
export const MAX_INSTALMENTS = 24;

/** Parse a typed rupee amount into integer paise; null when blank or not a valid amount. */
export function parseRupees(value: string): number | null {
  const s = value.replace(/,/g, '').trim();
  if (!s) return null;
  try {
    return toPaise(s);
  } catch {
    return null;
  }
}

/** A fully paid instalment can't change in a revision. */
export const isLockedRow = (r: ScheduleRow) => r.status === 'paid';

/** Add whole months to an ISO date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, last))).toISOString().slice(0, 10);
}

/** `total` paise split into `n` parts; the remainder paise go on the LAST part. */
export function splitEqual(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const parts = Array<number>(n).fill(base);
  parts[n - 1] = total - base * (n - 1);
  return parts;
}

export type ScheduleCheck = {
  /** Sum of all amounts in paise (blank/invalid rows count as 0). */
  sum: number;
  /** total - sum, in paise. */
  difference: number;
  /** First blocking problem, or null when the schedule can be saved. */
  error: string | null;
};

export function checkSchedule(rows: ScheduleRow[], total: number | null): ScheduleCheck {
  let sum = 0;
  let error: string | null = null;
  const fail = (m: string) => {
    error ??= m;
  };
  if (rows.length < MIN_INSTALMENTS) fail(`Use at least ${MIN_INSTALMENTS} instalments, or turn the schedule off`);
  if (rows.length > MAX_INSTALMENTS) fail(`At most ${MAX_INSTALMENTS} instalments`);
  rows.forEach((r, i) => {
    const p = parseRupees(r.amount);
    if (p === null || p <= 0) fail(`Instalment ${i + 1} needs an amount above zero`);
    else sum += p;
    if (!r.dueDate) fail(`Instalment ${i + 1} needs a due date`);
    else if (i > 0 && rows[i - 1]!.dueDate && r.dueDate <= rows[i - 1]!.dueDate)
      fail(`Instalment ${i + 1} must fall after instalment ${i}`);
    if (p !== null && r.paid && p < toPaise(r.paid)) fail(`Instalment ${i + 1} can’t go below the ${fromPaise(toPaise(r.paid))} already paid`);
  });
  const difference = total === null ? 0 : total - sum;
  if (total !== null && difference !== 0)
    fail(
      difference > 0
        ? `Instalments are ₹${fromPaise(difference)} short of the invoice total`
        : `Instalments are ₹${fromPaise(-difference)} over the invoice total`,
    );
  return { sum, difference, error };
}

/** The `instalments` body for the API. */
export const toPayload = (rows: ScheduleRow[]) =>
  rows.map((r) => ({ amount: fromPaise(parseRupees(r.amount) ?? 0), dueDate: r.dueDate }));

export const sameSchedule = (a: ScheduleRow[], b: { amount: string; dueDate: string }[]) =>
  a.length === b.length &&
  a.every((r, i) => parseRupees(r.amount) === toPaise(b[i]!.amount) && r.dueDate === b[i]!.dueDate);
