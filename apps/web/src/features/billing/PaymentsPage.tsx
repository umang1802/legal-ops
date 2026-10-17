import { PAYMENT_METHOD_LABELS, type PaymentDto } from '@legalops/types';
import { Alert, Badge, Card, EmptyState, PageHeader, Pagination, SkeletonList } from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, IndianRupee } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { BillingNav } from './BillingNav.js';
import { api, qs } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';

export function PaymentsPage() {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['payments', { page }],
    queryFn: () => api.getPage<PaymentDto>(`/payments${qs({ page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Payments" />
      <BillingNav />
      {list.isPending ? (
        <SkeletonList rows={5} />
      ) : list.isError ? (
        <Alert tone="danger">Couldn’t load payments.</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<IndianRupee />} title="No payments recorded yet" />
        </Card>
      ) : (
        <>
          <Card className="divide-y divide-line">
            {list.data.items.map((p) => (
              <Link
                key={p.id}
                to={`/payments/${p.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{p.client.name}</p>
                    {p.status === 'reversed' ? <Badge tone="danger">Reversed</Badge> : null}
                    {p.status === 'posted' && !isZero(p.unallocated) ? (
                      <Badge tone="warning">Advance {formatINR(p.unallocated, { whole: true })}</Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted">
                    {p.receiptNumber} · {formatDate(p.paymentDate)} · {PAYMENT_METHOD_LABELS[p.method]}
                    {!isZero(p.tdsAmount) ? ` · TDS ${formatINR(p.tdsAmount)}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{formatINR(p.amount)}</span>
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              </Link>
            ))}
          </Card>
          <Pagination
            page={page}
            pageSize={list.data.meta.pageSize}
            total={list.data.meta.total}
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}
