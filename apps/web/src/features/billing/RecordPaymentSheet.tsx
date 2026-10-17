import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type InvoiceListItemDto,
  type PaymentDto,
} from '@legalops/types';
import { Alert, Button, SelectField, Sheet, Spinner, TextField } from '@legalops/ui';
import { fromPaise, recordPaymentSchema, toPaise } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, todayIn } from '../../lib/format.js';
import { formatINR } from '../../lib/money.js';

const safePaise = (v: string) => {
  try {
    return v.trim() ? toPaise(v.replace(/,/g, '')) : 0;
  } catch {
    return NaN;
  }
};

/**
 * PRD Screen 18. Money received is spread across the client's open invoices (oldest first by default),
 * with TDS counted towards settlement. Any remainder needs an explicit "keep as advance".
 */
export function RecordPaymentSheet({
  open,
  onClose,
  client,
  focusInvoiceId,
}: {
  open: boolean;
  onClose: () => void;
  client: { id: string; name: string };
  focusInvoiceId?: string;
}) {
  const me = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [amount, setAmount] = useState('');
  const [tds, setTds] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('upi');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [keepAdvance, setKeepAdvance] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const openInvoices = useQuery({
    queryKey: ['invoices', { clientId: client.id, status: 'open' }],
    queryFn: () =>
      api.getPage<InvoiceListItemDto>(
        `/invoices${qs({ clientId: client.id, status: 'open', pageSize: 100 })}`,
      ),
    enabled: open,
  });
  // Oldest due first; the focused invoice (if any) goes to the top.
  const invoices = useMemo(
    () =>
      [...(openInvoices.data?.items ?? [])].sort((a, b) =>
        a.id === focusInvoiceId
          ? -1
          : b.id === focusInvoiceId
            ? 1
            : (a.dueDate ?? '').localeCompare(b.dueDate ?? ''),
      ),
    [openInvoices.data, focusInvoiceId],
  );

  useEffect(() => {
    if (!open) return;
    setAmount('');
    setTds('');
    setDate(todayIn(me.organization.timezone));
    setMethod('upi');
    setReference('');
    setNotes('');
    setAlloc({});
    setKeepAdvance(false);
    setErrors({});
  }, [open, me.organization.timezone]);

  const settlement = safePaise(amount) + safePaise(tds || '0');
  const allocated = Object.values(alloc).reduce((s, v) => s + (safePaise(v) || 0), 0);
  const remainder = Number.isNaN(settlement) ? NaN : settlement - allocated;

  /** Fill allocations oldest-first up to the settlement amount. */
  const autoAllocate = (total: number) => {
    let left = total;
    const next: Record<string, string> = {};
    for (const inv of invoices) {
      if (left <= 0) break;
      const take = Math.min(left, toPaise(inv.amountDue));
      next[inv.id] = fromPaise(take);
      left -= take;
    }
    setAlloc(next);
  };

  const save = useMutation({
    mutationFn: (body: unknown) => api.post<PaymentDto>('/payments', body),
    onSuccess: (p) => {
      for (const k of ['invoices', 'invoice', 'payments', 'billing', 'dashboard', 'matter'])
        void qc.invalidateQueries({ queryKey: [k] });
      onClose();
      navigate(`/payments/${p.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError)
        setErrors(
          Object.fromEntries(err.details.filter((d) => d.path).map((d) => [d.path!, d.message ?? ''])),
        );
    },
  });

  const submit = () => {
    const parsed = recordPaymentSchema.safeParse({
      clientId: client.id,
      amount: amount || '0',
      tdsAmount: tds || '0',
      paymentDate: date,
      method,
      referenceNumber: reference,
      notes,
      allocations: Object.entries(alloc)
        .filter(([, v]) => safePaise(v) > 0)
        .map(([invoiceId, v]) => ({ invoiceId, amount: v })),
      keepRemainderAsAdvance: keepAdvance,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    save.mutate(parsed.data);
  };

  const general = save.error instanceof ApiError ? save.error.message : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Payment from ${client.name}`}
      footer={
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted">Applied to invoices</span>
            <span className="font-medium tabular-nums">{formatINR(fromPaise(allocated || 0))}</span>
          </div>
          {!Number.isNaN(remainder) && remainder !== 0 ? (
            <div className="flex justify-between text-sm">
              <span className={remainder < 0 ? 'text-danger-700' : 'text-warning-800'}>
                {remainder < 0 ? 'Applied more than received' : 'Not applied (advance)'}
              </span>
              <span className="font-medium tabular-nums">{formatINR(fromPaise(Math.abs(remainder)))}</span>
            </div>
          ) : null}
          <Button block onClick={submit} loading={save.isPending}>
            Record payment
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {general ? <Alert tone="danger">{general}</Alert> : null}
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Amount received (₹)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => Object.keys(alloc).length === 0 && settlement > 0 && autoAllocate(settlement)}
            error={errors.amount}
          />
          <TextField
            label="TDS deducted (₹)"
            inputMode="decimal"
            placeholder="0"
            hint="If the client deducted tax at source"
            value={tds}
            onChange={(e) => setTds(e.target.value)}
            error={errors.tdsAmount}
          />
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            error={errors.paymentDate}
          />
          <SelectField
            label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))}
          />
        </div>
        <TextField
          label="Reference"
          placeholder="UTR / cheque no."
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />

        <fieldset className="space-y-2">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-medium">Apply to invoices</legend>
            {invoices.length > 0 && settlement > 0 ? (
              <button
                type="button"
                className="text-sm font-medium text-brand-700 hover:underline"
                onClick={() => autoAllocate(settlement)}
              >
                Oldest first
              </button>
            ) : null}
          </div>
          {openInvoices.isPending ? (
            <Spinner className="size-4 text-muted" />
          ) : invoices.length === 0 ? (
            <p className="text-sm text-muted">
              No open invoices. The full amount will be held as an advance.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {invoices.map((inv, idx) => (
                <li key={inv.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.invoiceNumber}</p>
                    <p className="truncate text-xs text-muted">
                      Due {formatINR(inv.amountDue)}
                      {inv.dueDate
                        ? ` · ${inv.daysOverdue > 0 ? `${inv.daysOverdue}d overdue` : formatDate(inv.dueDate)}`
                        : ''}
                    </p>
                  </div>
                  <label className="w-28 shrink-0">
                    <span className="sr-only">Amount for {inv.invoiceNumber}</span>
                    <input
                      inputMode="decimal"
                      placeholder="0"
                      value={alloc[inv.id] ?? ''}
                      onChange={(e) => setAlloc((a) => ({ ...a, [inv.id]: e.target.value }))}
                      aria-invalid={errors[`allocations.${idx}.amount`] ? true : undefined}
                      className="h-10 w-full rounded-lg border border-line bg-surface px-2 text-right text-sm tabular-nums"
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
          {Object.entries(errors)
            .filter(([k]) => k.startsWith('allocations'))
            .map(([k, v]) => (
              <p key={k} className="text-sm text-danger-700">
                {v}
              </p>
            ))}
        </fieldset>

        {remainder > 0 ? (
          <label className="flex min-h-11 items-start gap-2 rounded-lg bg-warning-50 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-brand-700"
              checked={keepAdvance}
              onChange={(e) => setKeepAdvance(e.target.checked)}
            />
            <span>
              Keep {formatINR(fromPaise(remainder))} as an advance for {client.name}
              {errors.keepRemainderAsAdvance ? (
                <span className="block text-danger-700">{errors.keepRemainderAsAdvance}</span>
              ) : null}
            </span>
          </label>
        ) : null}
        <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Sheet>
  );
}
