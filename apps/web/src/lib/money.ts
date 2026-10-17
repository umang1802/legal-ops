import { toPaise } from '@legalops/validation';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** '50000.00' -> '₹50,000.00' (Indian digit grouping). Formatting only; arithmetic stays in paise. */
export function formatINR(amount: string | null | undefined, opts: { whole?: boolean } = {}): string {
  if (amount === null || amount === undefined) return '—';
  const rupees = toPaise(amount) / 100;
  return (opts.whole ? inrWhole : inr).format(rupees);
}

export const isZero = (amount: string) => toPaise(amount) === 0;
