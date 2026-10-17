import { can, PAYMENT_METHOD_LABELS, type InvoiceListItemDto, type PaymentDto } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  SelectField,
  Sheet,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, Undo2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, fullName, todayIn } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { NotFound } from '../common/NotFound.js';
import { ReasonSheet } from './ReasonSheet.js';

const REFRESH = ['invoices', 'invoice', 'payments', 'payment', 'billing', 'dashboard', 'matter'];

/** PRD Screen 19. Corrections are reversals, never edits. */
export function PaymentDetailPage() {
  const { paymentId = '' } = useParams();
  const me = useSession();
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<'reverse' | 'apply' | 'tds' | null>(null);
  const p = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => api.get<PaymentDto>(`/payments/${paymentId}`),
  });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      api.post<PaymentDto>(`/payments/${paymentId}/${path}`, body),
    onSuccess: (data) => {
      qc.setQueryData(['payment', paymentId], data);
      REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
      setSheet(null);
    },
  });

  if (p.isPending) return <SkeletonList rows={4} />;
  if (p.isError)
    return p.error instanceof ApiError && p.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this payment.</Alert>
    );
  const pay = p.data;
  const canRecord = can(me.role, 'payments.record');
  const posted = pay.status === 'posted';

  return (
    <div className="space-y-4">
      <div>
        <Link to="/billing/payments" className="text-sm text-muted hover:text-ink">
          ← Payments
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{formatINR(pay.amount)}</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              from{' '}
              <Link to={`/clients/${pay.client.id}`} className="font-medium text-brand-700 hover:underline">
                {pay.client.name}
              </Link>{' '}
              · {pay.receiptNumber}
            </p>
            <div className="mt-2 flex gap-2">
              {pay.status === 'reversed' ? (
                <Badge tone="danger">Reversed</Badge>
              ) : (
                <Badge tone="success">Received</Badge>
              )}
            </div>
          </div>
          <Link to={`/payments/${pay.id}/receipt`} target="_blank">
            <Button variant="secondary" icon={<Printer className="size-4" />}>
              Receipt
            </Button>
          </Link>
        </div>
      </div>

      {pay.status === 'reversed' ? (
        <Alert tone="danger" title="Reversed">
          {pay.reversalReason}
        </Alert>
      ) : null}
      {canRecord && posted ? (
        <div className="flex flex-wrap gap-2">
          {!isZero(pay.unallocated) ? (
            <Button onClick={() => setSheet('apply')}>Apply advance to an invoice</Button>
          ) : null}
          {!isZero(pay.tdsAmount) && !pay.tdsCertificateNumber ? (
            <Button variant="secondary" onClick={() => setSheet('tds')}>
              Record TDS certificate
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="text-danger-700"
            icon={<Undo2 className="size-4" />}
            onClick={() => setSheet('reverse')}
          >
            Reverse payment
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Applied to" />
          {pay.allocations.length ? (
            <ul className="divide-y divide-line">
              {pay.allocations.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                  <Link
                    to={`/invoices/${a.invoiceId}`}
                    className={`hover:underline ${a.active ? 'text-brand-700' : 'text-muted line-through'}`}
                  >
                    {a.invoiceNumber}
                    {a.active ? '' : ' (un-applied)'}
                  </Link>
                  <span className="font-medium tabular-nums">{formatINR(a.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted sm:px-5">Not applied to any invoice.</p>
          )}
          {posted && !isZero(pay.unallocated) ? (
            <p className="border-t border-line px-4 py-3 text-sm text-warning-800 sm:px-5">
              Held as advance: {formatINR(pay.unallocated)}
            </p>
          ) : null}
        </Card>
        <Card className="h-fit">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <D label="Received">{formatINR(pay.amount)}</D>
              <D label="TDS">{isZero(pay.tdsAmount) ? '—' : formatINR(pay.tdsAmount)}</D>
              <D label="Date">{formatDate(pay.paymentDate)}</D>
              <D label="Method">{PAYMENT_METHOD_LABELS[pay.method]}</D>
              <D label="Reference" wide>
                {pay.referenceNumber}
              </D>
              {pay.matter ? (
                <D label="Matter" wide>
                  <Link
                    to={`/matters/${pay.matter.id}?tab=billing`}
                    className="text-brand-700 hover:underline"
                  >
                    {pay.matter.title}
                  </Link>
                </D>
              ) : null}
              {pay.tdsCertificateNumber ? (
                <D label="TDS certificate" wide>
                  {pay.tdsCertificateNumber} · {formatDate(pay.tdsCertificateReceivedAt)}
                </D>
              ) : null}
              <D label="Recorded by" wide>
                {fullName(pay.recordedBy)}
              </D>
              {pay.notes ? (
                <D label="Notes" wide>
                  {pay.notes}
                </D>
              ) : null}
            </dl>
          </CardBody>
        </Card>
      </div>

      <ReasonSheet
        open={sheet === 'reverse'}
        onClose={() => setSheet(null)}
        title="Reverse this payment?"
        description="Use this for a bounced cheque or a payment recorded by mistake. Every invoice it paid becomes due again. The original record is kept."
        confirmLabel="Reverse payment"
        pending={act.isPending}
        error={act.error}
        onConfirm={(reason) => act.mutate({ path: 'reverse', body: { reason } })}
      />
      <ApplyAdvanceSheet
        open={sheet === 'apply'}
        onClose={() => setSheet(null)}
        payment={pay}
        pending={act.isPending}
        error={act.error}
        onSubmit={(body) => act.mutate({ path: 'allocations', body })}
      />
      <TdsSheet
        open={sheet === 'tds'}
        onClose={() => setSheet(null)}
        pending={act.isPending}
        error={act.error}
        onSubmit={(body) => act.mutate({ path: 'tds-certificate', body })}
      />
    </div>
  );
}

function D({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words">{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

function ApplyAdvanceSheet({
  open,
  onClose,
  payment,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  payment: PaymentDto;
  pending: boolean;
  error: unknown;
  onSubmit: (b: { invoiceId: string; amount: string }) => void;
}) {
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const invoices = useQuery({
    queryKey: ['invoices', { clientId: payment.client.id, status: 'open' }],
    queryFn: () =>
      api.getPage<InvoiceListItemDto>(
        `/invoices${qs({ clientId: payment.client.id, status: 'open', pageSize: 100 })}`,
      ),
    enabled: open,
  });
  useEffect(() => {
    if (open) {
      setInvoiceId('');
      setAmount('');
    }
  }, [open]);
  const chosen = invoices.data?.items.find((i) => i.id === invoiceId);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Apply advance"
      footer={
        <Button
          block
          loading={pending}
          disabled={!invoiceId || !amount}
          onClick={() => onSubmit({ invoiceId, amount })}
        >
          Apply
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">Available: {formatINR(payment.unallocated)}</p>
        {error ? (
          <Alert tone="danger">{error instanceof ApiError ? error.message : 'Could not apply.'}</Alert>
        ) : null}
        <SelectField
          label="Invoice"
          value={invoiceId}
          onChange={(e) => {
            setInvoiceId(e.target.value);
            const inv = invoices.data?.items.find((i) => i.id === e.target.value);
            if (inv)
              setAmount(
                Number(inv.amountDue) < Number(payment.unallocated) ? inv.amountDue : payment.unallocated,
              );
          }}
          options={[
            { value: '', label: invoices.data?.items.length ? 'Choose…' : 'No open invoices' },
            ...(invoices.data?.items ?? []).map((i) => ({
              value: i.id,
              label: `${i.invoiceNumber} · due ${formatINR(i.amountDue)}`,
            })),
          ]}
        />
        <TextField
          label="Amount (₹)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint={chosen ? `Due on this invoice: ${formatINR(chosen.amountDue)}` : undefined}
        />
      </div>
    </Sheet>
  );
}

function TdsSheet({
  open,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  error: unknown;
  onSubmit: (b: { certificateNumber: string; receivedOn: string }) => void;
}) {
  const me = useSession();
  const [num, setNum] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => {
    if (open) {
      setNum('');
      setDate(todayIn(me.organization.timezone));
    }
  }, [open, me.organization.timezone]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="TDS certificate (Form 16A)"
      footer={
        <Button
          block
          loading={pending}
          disabled={!num || !date}
          onClick={() => onSubmit({ certificateNumber: num, receivedOn: date })}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        {error ? (
          <Alert tone="danger">{error instanceof ApiError ? error.message : 'Could not save.'}</Alert>
        ) : null}
        <TextField label="Certificate number" value={num} onChange={(e) => setNum(e.target.value)} />
        <TextField label="Received on" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
    </Sheet>
  );
}
