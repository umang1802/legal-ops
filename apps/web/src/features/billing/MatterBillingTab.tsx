import {
  EXPENSE_CATEGORIES,
  FEE_AGREEMENT_TYPE_LABELS,
  FEE_AGREEMENT_TYPES,
  INVOICE_DISPLAY_LABELS,
  PAYMENT_METHOD_LABELS,
  type ExpenseDto,
  type FeeAgreementDto,
  type InvoiceListItemDto,
  type MatterBillingDto,
  type MatterDetailDto,
  type PaymentDto,
} from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  SelectField,
  Sheet,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { expenseSchema, feeAgreementSchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2, IndianRupee, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { formatDate, todayIn } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { INVOICE_TONE } from '../../lib/status.js';
import { InvoiceRow } from './InvoiceRow.js';
import { RecordPaymentSheet } from './RecordPaymentSheet.js';

const REFRESH = ['invoices', 'billing', 'expenses', 'fee-agreements', 'payments', 'dashboard', 'matter'];

/** Matter → Billing tab: what was agreed, billed, paid and spent (PRD §7). */
export function MatterBillingTab({ matter }: { matter: MatterDetailDto }) {
  const me = useSession();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'expense' | 'agreement' | 'payment' | null>(null);
  const billingView = canAct(me, 'billing.view');
  const id = matter.id;
  const summary = useQuery({
    queryKey: ['billing', 'matter', id],
    queryFn: () => api.get<MatterBillingDto>(`/billing/matters/${id}`),
    enabled: billingView,
  });
  const invoices = useQuery({
    queryKey: ['invoices', { matterId: id }],
    queryFn: () => api.getPage<InvoiceListItemDto>(`/invoices${qs({ matterId: id, pageSize: 100 })}`),
    enabled: billingView,
  });
  const payments = useQuery({
    queryKey: ['payments', { matterId: id }],
    queryFn: () => api.getPage<PaymentDto>(`/payments${qs({ matterId: id, pageSize: 50 })}`),
    enabled: billingView,
  });
  const agreements = useQuery({
    queryKey: ['fee-agreements', id],
    queryFn: () => api.get<FeeAgreementDto[]>(`/fee-agreements${qs({ matterId: id })}`),
    enabled: billingView,
  });
  const expenses = useQuery({
    queryKey: ['expenses', { matterId: id }],
    queryFn: () => api.get<ExpenseDto[]>(`/expenses${qs({ matterId: id })}`),
  });

  const canInvoice = canAct(me, 'invoices.manage');
  const canExpense = canAct(me, 'matters.create') || canInvoice;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {canInvoice ? (
          <Button
            icon={<FilePlus2 className="size-4" />}
            onClick={() => navigate(`/invoices/new?matterId=${id}`)}
          >
            New invoice
          </Button>
        ) : null}
        {canAct(me, 'payments.record') ? (
          <Button
            variant="secondary"
            icon={<IndianRupee className="size-4" />}
            onClick={() => setSheet('payment')}
          >
            Record payment
          </Button>
        ) : null}
        {canExpense ? (
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setSheet('expense')}>
            Add expense
          </Button>
        ) : null}
      </div>

      {billingView && summary.data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Mini label="Invoiced" value={summary.data.invoiced} />
          <Mini label="Received" value={summary.data.paid} />
          <Mini
            label="Outstanding"
            value={summary.data.outstanding}
            tone={!isZero(summary.data.overdue) ? 'danger' : undefined}
            hint={
              !isZero(summary.data.overdue)
                ? `${formatINR(summary.data.overdue, { whole: true })} overdue`
                : undefined
            }
          />
          <Mini label="Unbilled expenses" value={summary.data.unbilledExpenses} />
        </div>
      ) : null}

      {billingView ? (
        <Card>
          <CardHeader
            title="Fee agreement"
            action={
              canInvoice && agreements.data?.length === 0 ? (
                <Button size="sm" variant="secondary" onClick={() => setSheet('agreement')}>
                  Add
                </Button>
              ) : null
            }
          />
          {agreements.isPending ? (
            <SkeletonList rows={1} />
          ) : agreements.data && agreements.data.length ? (
            agreements.data.map((a) => (
              <div key={a.id} className="border-b border-line last:border-0">
                <div className="px-4 py-3 text-sm sm:px-5">
                  <p className="font-medium">
                    {FEE_AGREEMENT_TYPE_LABELS[a.agreementType]}
                    {a.agreedAmount ? ` · ${formatINR(a.agreedAmount, { whole: true })}` : ''}
                    {a.perAppearanceAmount
                      ? ` · ${formatINR(a.perAppearanceAmount, { whole: true })} per appearance`
                      : ''}
                    {a.taxIncluded ? ' (tax incl.)' : ''}
                  </p>
                  {a.description ? <p className="text-muted">{a.description}</p> : null}
                </div>
                {a.milestones.length ? (
                  <ul className="divide-y divide-line border-t border-line">
                    {a.milestones.map((m) => (
                      <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{m.name}</p>
                          <p className="text-xs text-muted">
                            {m.dueDate ? `Due ${formatDate(m.dueDate)}` : 'No date'}
                          </p>
                        </div>
                        <span className="shrink-0 tabular-nums">{formatINR(m.amount, { whole: true })}</span>
                        {m.invoiceId ? (
                          <Link to={`/invoices/${m.invoiceId}`}>
                            <Badge
                              tone={m.invoiceDisplayStatus ? INVOICE_TONE[m.invoiceDisplayStatus] : 'neutral'}
                            >
                              {m.invoiceDisplayStatus
                                ? INVOICE_DISPLAY_LABELS[m.invoiceDisplayStatus]
                                : 'Invoiced'}
                            </Badge>
                          </Link>
                        ) : m.status === 'planned' && canInvoice ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => navigate(`/invoices/new?matterId=${id}&milestoneId=${m.id}`)}
                          >
                            Invoice
                          </Button>
                        ) : (
                          <Badge>{m.status}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))
          ) : (
            <EmptyState
              title="No fee agreement recorded"
              description="Record what was agreed (fixed, retainer or milestones) to invoice against it."
            />
          )}
        </Card>
      ) : null}

      {billingView ? (
        <Card>
          <CardHeader title="Invoices" />
          {invoices.data && invoices.data.items.length ? (
            <div className="divide-y divide-line">
              {invoices.data.items.map((i) => (
                <InvoiceRow key={i.id} invoice={i} showClient={false} />
              ))}
            </div>
          ) : (
            <EmptyState title="No invoices yet" />
          )}
        </Card>
      ) : null}

      {billingView && payments.data && payments.data.items.length ? (
        <Card>
          <CardHeader title="Payments" />
          <ul className="divide-y divide-line">
            {payments.data.items.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/payments/${p.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-subtle sm:px-5"
                >
                  <span className={p.status === 'reversed' ? 'text-muted line-through' : ''}>
                    {formatDate(p.paymentDate)} · {PAYMENT_METHOD_LABELS[p.method]} · {p.receiptNumber}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{formatINR(p.amount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Expenses" />
        {expenses.data && expenses.data.length ? (
          <ul className="divide-y divide-line">
            {expenses.data.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3 text-sm sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${e.status === 'void' ? 'text-muted line-through' : ''}`}>
                    {e.category ?? 'Expense'}
                    {e.description ? `: ${e.description}` : ''}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(e.expenseDate)}
                    {e.billableToClient ? '' : ' · not billable'}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums">{formatINR(e.amount)}</span>
                {e.status === 'billed' && e.invoiceId ? (
                  <Link to={`/invoices/${e.invoiceId}`}>
                    <Badge tone="success">Billed</Badge>
                  </Link>
                ) : e.status === 'recorded' && e.billableToClient ? (
                  <Badge tone="warning">Unbilled</Badge>
                ) : e.status === 'void' ? (
                  <Badge>Void</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No expenses recorded" />
        )}
      </Card>

      <ExpenseSheet open={sheet === 'expense'} onClose={() => setSheet(null)} matter={matter} />
      <FeeAgreementSheet open={sheet === 'agreement'} onClose={() => setSheet(null)} matterId={id} />
      <RecordPaymentSheet open={sheet === 'payment'} onClose={() => setSheet(null)} client={matter.client} />
    </div>
  );
}

function Mini({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'danger' | undefined;
  hint?: string | undefined;
}) {
  return (
    <Card className="p-3">
      <p className="truncate text-xs text-muted">{label}</p>
      <p
        className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === 'danger' ? 'text-danger-700' : ''}`}
      >
        {formatINR(value, { whole: true })}
      </p>
      {hint ? <p className="truncate text-xs text-danger-700">{hint}</p> : null}
    </Card>
  );
}

function ExpenseSheet({
  open,
  onClose,
  matter,
}: {
  open: boolean;
  onClose: () => void;
  matter: MatterDetailDto;
}) {
  const me = useSession();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    category: 'Court fees',
    amount: '',
    expenseDate: '',
    description: '',
    vendorName: '',
    billableToClient: true,
    caseId: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setForm({
        category: 'Court fees',
        amount: '',
        expenseDate: todayIn(me.organization.timezone),
        description: '',
        vendorName: '',
        billableToClient: true,
        caseId: matter.cases[0]?.id ?? '',
      });
      setErrors({});
    }
  }, [open, me.organization.timezone, matter.cases]);
  const save = useMutation({
    mutationFn: (body: unknown) => api.post<ExpenseDto>('/expenses', body),
    onSuccess: () => {
      REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
      onClose();
    },
  });
  const submit = () => {
    const parsed = expenseSchema.safeParse({
      ...form,
      matterId: matter.id,
      caseId: form.caseId || null,
      reimbursable: true,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    save.mutate(parsed.data);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add expense"
      footer={
        <Button block loading={save.isPending} onClick={submit}>
          Save expense
        </Button>
      }
    >
      <div className="space-y-3">
        {save.error ? (
          <Alert tone="danger">
            {save.error instanceof ApiError ? save.error.message : 'Could not save.'}
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Category"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
          <TextField
            label="Amount (₹)"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            error={errors.amount}
          />
          <TextField
            label="Date"
            type="date"
            value={form.expenseDate}
            onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
            error={errors.expenseDate}
          />
          {matter.cases.length > 1 ? (
            <SelectField
              label="Case"
              value={form.caseId}
              onChange={(e) => setForm({ ...form, caseId: e.target.value })}
              options={matter.cases.map((c) => ({ value: c.id, label: c.caseNumber ?? c.title }))}
            />
          ) : null}
        </div>
        <TextField
          label="Description"
          placeholder="e.g. Court fee stamps on plaint"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <TextField
          label="Paid to (optional)"
          value={form.vendorName}
          onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-brand-700"
            checked={form.billableToClient}
            onChange={(e) => setForm({ ...form, billableToClient: e.target.checked })}
          />
          Bill this to the client
        </label>
      </div>
    </Sheet>
  );
}

function FeeAgreementSheet({
  open,
  onClose,
  matterId,
}: {
  open: boolean;
  onClose: () => void;
  matterId: string;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<(typeof FEE_AGREEMENT_TYPES)[number]>('milestone');
  const [agreed, setAgreed] = useState('');
  const [perAppearance, setPerAppearance] = useState('');
  const [description, setDescription] = useState('');
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [milestones, setMilestones] = useState<{ name: string; amount: string; dueDate: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setType('milestone');
      setAgreed('');
      setPerAppearance('');
      setDescription('');
      setTaxIncluded(false);
      setMilestones([{ name: 'Retainer', amount: '', dueDate: '' }]);
      setErrors({});
    }
  }, [open]);
  const save = useMutation({
    mutationFn: (body: unknown) => api.post<FeeAgreementDto>('/fee-agreements', body),
    onSuccess: () => {
      REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
      onClose();
    },
  });
  const submit = () => {
    const parsed = feeAgreementSchema.safeParse({
      matterId,
      agreementType: type,
      agreedAmount: agreed || null,
      perAppearanceAmount: perAppearance || null,
      description,
      taxIncluded,
      milestones:
        type === 'milestone' || type === 'hybrid' ? milestones.filter((m) => m.name || m.amount) : [],
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    save.mutate(parsed.data);
  };
  const withMilestones = type === 'milestone' || type === 'hybrid';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Fee agreement"
      footer={
        <Button block loading={save.isPending} onClick={submit}>
          Save agreement
        </Button>
      }
    >
      <div className="space-y-3">
        {save.error ? (
          <Alert tone="danger">
            {save.error instanceof ApiError ? save.error.message : 'Could not save.'}
          </Alert>
        ) : null}
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          options={FEE_AGREEMENT_TYPES.map((t) => ({ value: t, label: FEE_AGREEMENT_TYPE_LABELS[t] }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Agreed amount (₹)"
            inputMode="decimal"
            value={agreed}
            onChange={(e) => setAgreed(e.target.value)}
            error={errors.agreedAmount}
          />
          {type === 'per_appearance' || type === 'hybrid' ? (
            <TextField
              label="Per appearance (₹)"
              inputMode="decimal"
              value={perAppearance}
              onChange={(e) => setPerAppearance(e.target.value)}
              error={errors.perAppearanceAmount}
            />
          ) : null}
        </div>
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-brand-700"
            checked={taxIncluded}
            onChange={(e) => setTaxIncluded(e.target.checked)}
          />
          Amounts include tax
        </label>
        {withMilestones ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Milestones</legend>
            {milestones.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
                <TextField
                  label={`Stage ${i + 1}`}
                  value={m.name}
                  onChange={(e) =>
                    setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                  error={errors[`milestones.${i}.name`]}
                />
                <TextField
                  label="₹"
                  inputMode="decimal"
                  value={m.amount}
                  onChange={(e) =>
                    setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                  error={errors[`milestones.${i}.amount`]}
                />
                <button
                  type="button"
                  aria-label={`Remove stage ${i + 1}`}
                  onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                  className="mb-0.5 grid size-11 place-items-center rounded-lg text-muted hover:bg-subtle"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setMilestones((ms) => [...ms, { name: '', amount: '', dueDate: '' }])}
            >
              Add stage
            </Button>
          </fieldset>
        ) : null}
      </div>
    </Sheet>
  );
}
