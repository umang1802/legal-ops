import { AGING_BUCKETS, PAYMENT_METHOD_LABELS, type BillingSummaryDto } from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Skeleton,
  SkeletonList,
} from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FilePlus2, IndianRupee } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BillingNav } from './BillingNav.js';
import { api } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { formatDate } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { InvoiceRow } from './InvoiceRow.js';
import { PickClientPaymentSheet } from './PickClientPaymentSheet.js';

/** PRD Screen 15: "who owes us money, how much, and when is it due?" */
export function BillingPage() {
  const me = useSession();
  const navigate = useNavigate();
  const [paying, setPaying] = useState(false);
  const s = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => api.get<BillingSummaryDto>('/billing/summary'),
  });
  const d = s.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing"
        description={d?.scope === 'mine' ? 'Invoices on matters you’re assigned to.' : undefined}
        actions={
          <>
            {canAct(me, 'payments.record') ? (
              <Button
                variant="secondary"
                icon={<IndianRupee className="size-4" />}
                onClick={() => setPaying(true)}
              >
                Record payment
              </Button>
            ) : null}
            {canAct(me, 'invoices.manage') ? (
              <Button icon={<FilePlus2 className="size-4" />} onClick={() => navigate('/invoices/new')}>
                New invoice
              </Button>
            ) : null}
          </>
        }
      />
      <BillingNav />
      {s.isError ? <Alert tone="danger">Couldn’t load billing.</Alert> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-5">
        <Metric label="Outstanding" value={d?.outstanding} to="/billing/invoices?status=open" />
        <Metric
          label="Overdue"
          value={d?.overdue}
          danger={d && !isZero(d.overdue)}
          to="/billing/collections"
        />
        <Metric label="Due in 7 days" value={d?.dueThisWeek} />
        <Metric label="Invoiced this month" value={d?.invoicedThisMonth} />
        <Metric label="Collected this month" hint="incl. TDS" value={d?.receivedThisMonth} />
      </div>

      {d && !isZero(d.overdue) ? (
        <Card>
          <CardHeader
            title="Overdue by age"
            action={
              <Link to="/billing/collections" className="text-sm font-medium text-brand-700 hover:underline">
                Collections
              </Link>
            }
          />
          <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
            {AGING_BUCKETS.map((b) => (
              <Link key={b} to={`/billing/collections?bucket=${b}`} className="p-4 hover:bg-subtle">
                <p className="text-xs text-muted">{b} days</p>
                <p className="text-lg font-semibold tabular-nums">
                  {formatINR(d.aging[b].amount, { whole: true })}
                </p>
                <p className="text-xs text-muted">
                  {d.aging[b].count} invoice{d.aging[b].count === 1 ? '' : 's'}
                </p>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Overdue" />
            {s.isPending ? (
              <SkeletonList rows={2} />
            ) : d && d.overdueInvoices.length ? (
              <div className="divide-y divide-line">
                {d.overdueInvoices.map((i) => (
                  <InvoiceRow key={i.id} invoice={i} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing overdue" />
            )}
          </Card>
          <Card>
            <CardHeader
              title="Due in the next 2 weeks"
              action={
                <Link to="/billing/invoices" className="text-sm font-medium text-brand-700 hover:underline">
                  All invoices
                </Link>
              }
            />
            {d && d.dueSoon.length ? (
              <div className="divide-y divide-line">
                {d.dueSoon.map((i) => (
                  <InvoiceRow key={i.id} invoice={i} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing due soon" />
            )}
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader
            title="Recent payments"
            action={
              <Link to="/billing/payments" className="text-sm font-medium text-brand-700 hover:underline">
                All
              </Link>
            }
          />
          {d && d.recentPayments.length ? (
            <ul className="divide-y divide-line">
              {d.recentPayments.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/payments/${p.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate text-sm font-medium ${p.status === 'reversed' ? 'text-muted line-through' : ''}`}
                      >
                        {p.client.name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {formatDate(p.paymentDate)} · {PAYMENT_METHOD_LABELS[p.method]}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{formatINR(p.amount)}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No payments yet" />
          )}
          {d && !isZero(d.unallocatedAdvances) ? (
            <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">
              Advances not yet applied: {formatINR(d.unallocatedAdvances)}
            </p>
          ) : null}
        </Card>
      </div>
      <PickClientPaymentSheet open={paying} onClose={() => setPaying(false)} />
    </div>
  );
}

function Metric({
  label,
  value,
  danger,
  to,
  hint,
}: {
  label: string;
  value: string | undefined;
  danger?: boolean | undefined;
  to?: string;
  hint?: string;
}) {
  const body = (
    <Card className="h-full p-4 transition-colors hover:bg-subtle">
      <p className="truncate text-xs font-medium text-muted">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <p className={`mt-1 text-xl font-semibold tabular-nums ${danger ? 'text-danger-700' : ''}`}>
          {formatINR(value, { whole: true })}
        </p>
      )}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
