import { cn } from '@legalops/ui';
import { NavLink } from 'react-router';

const LINKS = [
  { to: '/billing', label: 'Overview', end: true },
  { to: '/billing/invoices', label: 'Invoices' },
  { to: '/billing/payments', label: 'Payments' },
  { to: '/billing/collections', label: 'Collections' },
];

export function BillingNav() {
  return (
    <nav
      aria-label="Billing"
      className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
    >
      {LINKS.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end ?? false}
          className={({ isActive }) =>
            cn(
              'relative h-11 shrink-0 px-3 text-sm leading-[2.75rem] font-medium whitespace-nowrap',
              isActive
                ? 'text-brand-700 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand-700'
                : 'text-muted hover:text-ink',
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
