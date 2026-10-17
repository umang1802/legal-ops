import { can, INVOICE_DISPLAY_LABELS, PAYMENT_METHOD_LABELS, type InvoiceDetailDto } from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Sheet,
  SkeletonList,
  TextAreaField,
  TextField,
} from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, FileMinus, IndianRupee, Pencil, Printer, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { INVOICE_TONE } from '../../lib/status.js';
import { NotFound } from '../common/NotFound.js';
import { ReasonSheet } from './ReasonSheet.js';
import { RecordPaymentSheet } from './RecordPaymentSheet.js';

const REFRESH = [
  'invoices',
  'invoice',
  'payments',
  'billing',
  'dashboard',
  'matter',
  'expenses',
  'fee-agreements',
];

export function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams();
  const me = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'pay' | 'void' | 'writeoff' | 'credit' | 'delete' | null>(null);
  const inv = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDetailDto>(`/invoices/${invoiceId}`),
  });
  const refresh = () => REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api.post<InvoiceDetailDto>(`/invoices/${invoiceId}/${path}`, body ?? {}),
    onSuccess: () => {
      refresh();
      setSheet(null);
    },
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/invoices/${invoiceId}`),
    onSuccess: () => {
      refresh();
      navigate('/billing/invoices', { replace: true });
    },
  });

  if (inv.isPending) return <SkeletonList rows={5} />;
  if (inv.isError)
    return inv.error instanceof ApiError && inv.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this invoice.</Alert>
    );
  const i = inv.data;
  const manage = can(me.role, 'invoices.manage');
  const open = i.status === 'issued' && !isZero(i.amountDue);

  return (
    <div className="space-y-4">
      <div>
        <Link to="/billing/invoices" className="text-sm text-muted hover:text-ink">
          ← Invoices
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {i.invoiceNumber ?? 'Draft invoice'}
            </h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              <Link to={`/clients/${i.client.id}`} className="font-medium text-brand-700 hover:underline">
                {i.client.name}
              </Link>{' '}
              ·{' '}
              <Link to={`/matters/${i.matter.id}?tab=billing`} className="hover:underline">
                {i.matter.title}
              </Link>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={INVOICE_TONE[i.displayStatus]}>
                {i.displayStatus === 'overdue'
                  ? `Overdue by ${i.daysOverdue} day${i.daysOverdue === 1 ? '' : 's'}`
                  : INVOICE_DISPLAY_LABELS[i.displayStatus]}
              </Badge>
              {i.taxMode === 'gst' ? (
                <Badge>{i.isReverseCharge ? 'GST · reverse charge' : 'GST invoice'}</Badge>
              ) : null}
            </div>
          </div>
          {i.status !== 'draft' ? (
            <Link to={`/invoices/${i.id}/print`} target="_blank">
              <Button variant="secondary" icon={<Printer className="size-4" />}>
                Print / PDF
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      {manage ? (
        <div className="flex flex-wrap gap-2">
          {i.status === 'draft' ? (
            <>
              <Button
                icon={<Send className="size-4" />}
                loading={action.isPending}
                onClick={() => action.mutate({ path: 'issue' })}
              >
                Issue invoice
              </Button>
              <Button
                variant="secondary"
                icon={<Pencil className="size-4" />}
                onClick={() => navigate(`/invoices/${i.id}/edit`)}
              >
                Edit draft
              </Button>
              <Button
                variant="ghost"
                className="text-danger-700"
                icon={<Trash2 className="size-4" />}
                onClick={() => setSheet('delete')}
              >
                Delete draft
              </Button>
            </>
          ) : null}
          {open && can(me.role, 'payments.record') ? (
            <Button icon={<IndianRupee className="size-4" />} onClick={() => setSheet('pay')}>
              Record payment
            </Button>
          ) : null}
          {open ? (
            <Button
              variant="secondary"
              icon={<FileMinus className="size-4" />}
              onClick={() => setSheet('credit')}
            >
              Credit note
            </Button>
          ) : null}
          {i.status === 'issued' ? (
            <Button
              variant="ghost"
              className="text-danger-700"
              icon={<Ban className="size-4" />}
              onClick={() => setSheet('void')}
            >
              Void
            </Button>
          ) : null}
          {open ? (
            <Button variant="ghost" onClick={() => setSheet('writeoff')}>
              Write off balance
            </Button>
          ) : null}
        </div>
      ) : null}
      {action.error && !sheet ? (
        <Alert tone="danger">
          {action.error instanceof ApiError ? action.error.message : 'Action failed.'}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Items" />
            <ul className="divide-y divide-line">
              {i.items.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                  <div className="min-w-0">
                    <p className="break-words">{l.description}</p>
                    <p className="text-xs text-muted">
                      {Number(l.quantity)} × {formatINR(l.unitPrice)}
                      {l.sacCode ? ` · SAC ${l.sacCode}` : ''}
                      {l.gstRate ? ` · GST ${Number(l.gstRate)}%` : ''}
                      {l.isPureAgent
                        ? i.taxMode === 'gst'
                          ? ' · reimbursement (no GST)'
                          : ' · reimbursement'
                        : ''}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">{formatINR(l.amount)}</span>
                </li>
              ))}
            </ul>
            <CardBody className="border-t border-line">
              <dl className="space-y-1.5 text-sm tabular-nums">
                <Line label="Subtotal" value={i.subtotal} />
                {!isZero(i.discountAmount) ? <Line label="Discount" value={`-${i.discountAmount}`} /> : null}
                {!isZero(i.cgst) ? <Line label="CGST" value={i.cgst} /> : null}
                {!isZero(i.sgst) ? <Line label="SGST" value={i.sgst} /> : null}
                {!isZero(i.igst) ? <Line label="IGST" value={i.igst} /> : null}
                {i.taxMode === 'simple' && !isZero(i.taxAmount) ? (
                  <Line label="Tax" value={i.taxAmount} />
                ) : null}
                {!isZero(i.rcmTax) ? (
                  <Line label="GST payable by client (reverse charge)" value={i.rcmTax} muted />
                ) : null}
                <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
                  <dt>Total</dt>
                  <dd>{formatINR(i.total)}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Payments & credits" />
            {i.allocations.length === 0 && i.creditNotes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted sm:px-5">Nothing received yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {i.allocations.map((a) => (
                  <li key={a.id}>
                    <Link
                      to={`/payments/${a.paymentId}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-subtle sm:px-5"
                    >
                      <span className={a.active ? '' : 'text-muted line-through'}>
                        {a.receiptNumber} · {PAYMENT_METHOD_LABELS[a.method]} · {formatDate(a.paymentDate)}
                        {a.active ? '' : ' (reversed)'}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">{formatINR(a.amount)}</span>
                    </Link>
                  </li>
                ))}
                {i.creditNotes.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5"
                  >
                    <span>
                      Credit note {c.number} · {formatDate(c.issueDate)}
                      <span className="block text-xs text-muted">{c.reason}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{formatINR(c.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Balance" />
          <CardBody>
            <dl className="space-y-2 text-sm tabular-nums">
              <Line label="Total" value={i.total} />
              <Line label="Paid" value={i.amountPaid} />
              {!isZero(i.amountCredited) ? <Line label="Credited" value={i.amountCredited} /> : null}
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
                <dt>{i.status === 'written_off' ? 'Written off' : 'Due'}</dt>
                <dd className={i.displayStatus === 'overdue' ? 'text-danger-700' : ''}>
                  {formatINR(i.amountDue)}
                </dd>
              </div>
            </dl>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
              <div>
                <dt className="text-xs text-muted">Issued</dt>
                <dd>{formatDate(i.issueDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Due</dt>
                <dd>{formatDate(i.dueDate)}</dd>
              </div>
              {i.taxMode === 'gst' ? (
                <div className="col-span-2">
                  <dt className="text-xs text-muted">Place of supply</dt>
                  <dd>{i.placeOfSupply ?? '—'}</dd>
                </div>
              ) : null}
            </dl>
            {i.voidReason ? (
              <Alert tone="info" title="Voided">
                {i.voidReason}
              </Alert>
            ) : null}
            {i.writeOffReason ? (
              <Alert tone="info" title="Written off">
                {i.writeOffReason}
              </Alert>
            ) : null}
            {i.notes ? <p className="mt-3 text-sm whitespace-pre-wrap text-ink-soft">{i.notes}</p> : null}
          </CardBody>
        </Card>
      </div>

      <RecordPaymentSheet
        open={sheet === 'pay'}
        onClose={() => setSheet(null)}
        client={i.client}
        focusInvoiceId={i.id}
      />
      <ReasonSheet
        open={sheet === 'void'}
        onClose={() => setSheet(null)}
        title="Void this invoice?"
        description="The invoice number is kept (GST requires it) and marked void. Linked milestones and expenses become billable again."
        confirmLabel="Void invoice"
        pending={action.isPending}
        error={action.error}
        onConfirm={(reason) => action.mutate({ path: 'void', body: { reason } })}
      />
      <ReasonSheet
        open={sheet === 'writeoff'}
        onClose={() => setSheet(null)}
        title={`Write off ${formatINR(i.amountDue)}?`}
        description="Use this when the balance won’t be recovered. It stops reminders and moves the amount to bad debt."
        confirmLabel="Write off"
        pending={action.isPending}
        error={action.error}
        onConfirm={(reason) => action.mutate({ path: 'write-off', body: { reason } })}
      />
      <CreditNoteSheet
        open={sheet === 'credit'}
        onClose={() => setSheet(null)}
        max={i.amountDue}
        pending={action.isPending}
        error={action.error}
        onSubmit={(body) => action.mutate({ path: 'credit-notes', body })}
      />
      <Sheet
        open={sheet === 'delete'}
        onClose={() => setSheet(null)}
        title="Delete this draft?"
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button variant="secondary" block className="sm:w-auto" onClick={() => setSheet(null)}>
              Keep
            </Button>
            <Button
              variant="danger"
              block
              className="sm:w-auto"
              loading={del.isPending}
              onClick={() => del.mutate()}
            >
              Delete draft
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-soft">
          Drafts have no invoice number yet, so nothing is lost from the numbering sequence.
        </p>
      </Sheet>
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  const negative = value.startsWith('-');
  return (
    <div className={`flex justify-between gap-4 ${muted ? 'text-muted' : ''}`}>
      <dt>{label}</dt>
      <dd>{negative ? `− ${formatINR(value.slice(1))}` : formatINR(value)}</dd>
    </div>
  );
}

function CreditNoteSheet({
  open,
  onClose,
  max,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  max: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: { amount: string; reason: string }) => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
    }
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Issue credit note"
      footer={
        <Button
          block
          loading={pending}
          disabled={!amount || reason.trim().length < 3}
          onClick={() => onSubmit({ amount, reason })}
        >
          Issue credit note
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          Reduces what the client owes on this invoice. Gets its own number for GST records.
        </p>
        {error ? (
          <Alert tone="danger">{error instanceof ApiError ? error.message : 'Could not issue.'}</Alert>
        ) : null}
        <TextField
          label="Amount (₹)"
          inputMode="decimal"
          hint={`Up to ${formatINR(max)}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}
