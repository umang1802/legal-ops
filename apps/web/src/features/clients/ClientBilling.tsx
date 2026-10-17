import { can, type ClientBalanceDto, type ClientDto, type InvoiceListItemDto } from '@legalops/types';
import { Button, Card, CardHeader, EmptyState } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { IndianRupee } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatINR, isZero } from '../../lib/money.js';
import { InvoiceRow } from '../billing/InvoiceRow.js';
import { RecordPaymentSheet } from '../billing/RecordPaymentSheet.js';

/** Client → outstanding balance, advance and invoices (PRD Screen 14). */
export function ClientBilling({ client }: { client: ClientDto }) {
  const me = useSession();
  const [paying, setPaying] = useState(false);
  const balance = useQuery({
    queryKey: ['billing', 'client', client.id],
    queryFn: () => api.get<ClientBalanceDto>(`/billing/clients/${client.id}`),
  });
  const invoices = useQuery({
    queryKey: ['invoices', { clientId: client.id }],
    queryFn: () => api.getPage<InvoiceListItemDto>(`/invoices${qs({ clientId: client.id, pageSize: 50 })}`),
  });
  const b = balance.data;
  return (
    <Card>
      <CardHeader
        title="Billing"
        action={
          can(me.role, 'payments.record') ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<IndianRupee className="size-4" />}
              onClick={() => setPaying(true)}
            >
              Record payment
            </Button>
          ) : null
        }
      />
      {b ? (
        <div className="grid grid-cols-3 divide-x divide-line border-b border-line text-center">
          <div className="p-3">
            <p className="text-xs text-muted">Outstanding</p>
            <p className="font-semibold tabular-nums">{formatINR(b.outstanding, { whole: true })}</p>
          </div>
          <div className="p-3">
            <p className="text-xs text-muted">Overdue</p>
            <p className={`font-semibold tabular-nums ${!isZero(b.overdue) ? 'text-danger-700' : ''}`}>
              {formatINR(b.overdue, { whole: true })}
            </p>
          </div>
          <div className="p-3">
            <p className="text-xs text-muted">Advance</p>
            <p className="font-semibold tabular-nums">{formatINR(b.advance, { whole: true })}</p>
          </div>
        </div>
      ) : null}
      {invoices.data && invoices.data.items.length ? (
        <div className="divide-y divide-line">
          {invoices.data.items.map((i) => (
            <InvoiceRow key={i.id} invoice={i} showClient={false} />
          ))}
        </div>
      ) : (
        <EmptyState title="No invoices yet" />
      )}
      <RecordPaymentSheet
        open={paying}
        onClose={() => setPaying(false)}
        client={{ id: client.id, name: client.name }}
      />
    </Card>
  );
}
