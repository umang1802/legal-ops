import {
  type ClientDto,
  type ExpenseDto,
  type FeeAgreementDto,
  type InvoiceDetailDto,
  type MatterDetailDto,
  type OrganizationDto,
} from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  SkeletonList,
  TextAreaField,
  TextField,
  cn,
  type ComboOption,
} from '@legalops/ui';
import {
  computeInvoiceTotals,
  createInvoiceSchema,
  fromPaise,
  InvoiceCalcError,
  reviseInvoiceSchema,
  updateInvoiceSchema,
} from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { addDays, todayIn } from '../../lib/format.js';
import { formatINR } from '../../lib/money.js';
import {
  addMonths,
  checkSchedule,
  isLockedRow,
  MAX_INSTALMENTS,
  MIN_INSTALMENTS,
  parseRupees,
  sameSchedule,
  splitEqual,
  toPayload,
  type ScheduleRow,
} from './schedule.js';
import { IssueSheet } from './IssueSheet.js';
import { MatterPicker } from '../matters/pickers.js';

type Line = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  sacCode: string;
  gstRate: string;
  isPureAgent: boolean;
  feeMilestoneId?: string | undefined;
  expenseId?: string | undefined;
};

let seq = 0;
let rowSeq = 0;
const newRow = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  key: `r${++rowSeq}`,
  amount: '',
  dueDate: '',
  ...over,
});
const newLine = (
  over: Partial<Line> = {},
  defaults: { sac: string; rate: string } = { sac: '', rate: '' },
): Line => ({
  key: `l${++seq}`,
  description: '',
  quantity: '1',
  unitPrice: '',
  sacCode: defaults.sac,
  gstRate: defaults.rate,
  isPureAgent: false,
  ...over,
});

/** New or draft invoice (PRD Journey D). Totals preview uses the same shared calculation as the server. */
export function InvoiceEditorPage() {
  const me = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { invoiceId } = useParams();
  const [params] = useSearchParams();
  const today = todayIn(me.organization.timezone);

  const existing = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDetailDto>(`/invoices/${invoiceId}`),
    enabled: Boolean(invoiceId),
  });
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationDto>('/organization'),
  });
  const gst = (existing.data?.taxMode ?? org.data?.taxMode ?? me.organization.taxMode) === 'gst';
  const defaults = useMemo(() => ({ sac: gst ? '998212' : '', rate: gst ? '18' : '' }), [gst]);

  const [matter, setMatter] = useState<ComboOption | null>(null);
  const [lines, setLines] = useState<Line[]>([newLine({}, defaults)]);
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, 15));
  const [discount, setDiscount] = useState('');
  const [tax, setTax] = useState('');
  const [rcm, setRcm] = useState<boolean | null>(null);
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Instalment schedule. `rows` only goes to the server when the user changed it (absent = unchanged there).
  const [instOn, setInstOn] = useState(false);
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [splitN, setSplitN] = useState('3');
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [notifyClient, setNotifyClient] = useState(false);
  const [issuing, setIssuing] = useState<InvoiceDetailDto | null>(null);
  const [initialised, setInitialised] = useState(false);

  // "Edit invoice" on an issued simple-mode invoice opens this same editor in revision mode.
  const revising = Boolean(invoiceId) && params.get('revise') === '1' && Boolean(existing.data?.canRevise);
  const presetMatterId = existing.data?.matter.id ?? params.get('matterId');
  const matterDetail = useQuery({
    queryKey: ['matter', presetMatterId ?? matter?.value],
    queryFn: () => api.get<MatterDetailDto>(`/matters/${presetMatterId ?? matter!.value}`),
    enabled: Boolean(presetMatterId ?? matter),
  });
  const matterId = matterDetail.data?.id;
  const client = useQuery({
    queryKey: ['client', matterDetail.data?.client.id],
    queryFn: () => api.get<ClientDto>(`/clients/${matterDetail.data!.client.id}`),
    enabled: Boolean(matterDetail.data),
  });
  const expenses = useQuery({
    queryKey: ['expenses', { matterId, status: 'unbilled' }],
    queryFn: () => api.get<ExpenseDto[]>(`/expenses${qs({ matterId, status: 'unbilled' })}`),
    enabled: Boolean(matterId),
  });
  const agreements = useQuery({
    queryKey: ['fee-agreements', matterId],
    queryFn: () => api.get<FeeAgreementDto[]>(`/fee-agreements${qs({ matterId })}`),
    enabled: Boolean(matterId),
  });

  // Initialise from an existing draft, or from ?milestoneId= when invoicing a milestone.
  useEffect(() => {
    if (initialised) return;
    if (invoiceId && existing.data) {
      const d = existing.data;
      setLines(
        d.items.map((i) =>
          newLine({
            description: i.description,
            quantity: String(Number(i.quantity)),
            unitPrice: i.unitPrice,
            sacCode: i.sacCode ?? '',
            gstRate: i.gstRate ? String(Number(i.gstRate)) : '',
            isPureAgent: i.isPureAgent,
            feeMilestoneId: i.feeMilestoneId ?? undefined,
            expenseId: i.expenseId ?? undefined,
          }),
        ),
      );
      setIssueDate(d.issueDate ?? today);
      setDueDate(d.dueDate ?? addDays(today, 15));
      setDiscount(Number(d.discountAmount) ? d.discountAmount : '');
      setTax(Number(d.taxAmount) && d.taxMode === 'simple' ? d.taxAmount : '');
      setRcm(d.isReverseCharge);
      setPlaceOfSupply(d.placeOfSupply ?? '');
      setNotes(d.notes ?? '');
      setInstOn(d.instalments.length > 0);
      setRows(
        d.instalments.map((x) =>
          newRow({ amount: x.amount, dueDate: x.dueDate, status: x.status, paid: x.paid }),
        ),
      );
      setSplitN(String(d.instalments.length || 3));
      setInitialised(true);
    } else if (!invoiceId && agreements.data) {
      const msId = params.get('milestoneId');
      const ms = agreements.data.flatMap((a) => a.milestones).find((m) => m.id === msId);
      if (ms)
        setLines([newLine({ description: ms.name, unitPrice: ms.amount, feeMilestoneId: ms.id }, defaults)]);
      setInitialised(true);
    }
  }, [invoiceId, existing.data, agreements.data, initialised, params, today, defaults]);

  // GST defaults from the client once known: place of supply and reverse charge (D-010).
  useEffect(() => {
    if (!gst || !client.data || invoiceId) return;
    setPlaceOfSupply((p) => p || client.data!.stateCode || org.data?.stateCode || '');
    setRcm((r) => (r === null ? client.data!.clientType === 'company' && Boolean(client.data!.gstin) : r));
  }, [gst, client.data, org.data, invoiceId]);

  const preview = useMemo(() => {
    try {
      const totals = computeInvoiceTotals({
        taxMode: gst ? 'gst' : 'simple',
        lines: lines
          .filter((l) => l.unitPrice.trim())
          .map((l) => ({
            quantity: l.quantity || '1',
            unitPrice: l.unitPrice.replace(/,/g, ''),
            gstRate: gst && !l.isPureAgent ? l.gstRate || null : null,
            isPureAgent: l.isPureAgent,
          })),
        discount: discount.replace(/,/g, '') || '0',
        simpleTax: tax.replace(/,/g, '') || '0',
        intraState: placeOfSupply !== '' && placeOfSupply === org.data?.stateCode,
        isReverseCharge: Boolean(rcm),
      });
      return { totals, error: null as string | null };
    } catch (err) {
      return {
        totals: null,
        error: err instanceof InvoiceCalcError || err instanceof Error ? err.message : 'Check the amounts',
      };
    }
  }, [lines, discount, tax, gst, placeOfSupply, org.data, rcm]);

  const totalPaise = preview.totals?.total ?? null;
  const check = useMemo(() => checkSchedule(rows, totalPaise), [rows, totalPaise]);
  const scheduleError = instOn ? check.error : null;
  const lastDue = rows[rows.length - 1]?.dueDate || dueDate;
  const lastLocked = rows.reduce((a, r, i) => (isLockedRow(r) ? i : a), -1);
  const effectiveDue = instOn && rows.length > 0 ? lastDue : dueDate;

  const editRows = (next: ScheduleRow[]) => {
    setRows(next);
    setScheduleDirty(true);
  };
  const toggleInstalments = (on: boolean) => {
    setInstOn(on);
    setScheduleDirty(true);
    if (on && rows.length === 0 && totalPaise) {
      const n = Number(splitN);
      splitInto(n >= MIN_INSTALMENTS && n <= MAX_INSTALMENTS ? n : 3);
    }
  };
  /**
   * Equal split into n parts, remainder paise on the LAST. Rows never move: fully paid rows stay first and untouched,
   * a part-paid row keeps what was paid (its new amount = paid + its share), and only the unpaid remainder is re-split.
   * On an existing schedule the unpaid rows keep their dates (extra rows continue monthly from the first date).
   */
  const splitInto = (n: number) => {
    if (!totalPaise || n < MIN_INSTALMENTS || n > MAX_INSTALMENTS) return;
    const kept = rows.filter(isLockedRow);
    const keptSum = kept.reduce((a, r) => a + (parseRupees(r.amount) ?? 0), 0);
    const tail = rows.slice(kept.length);
    const alreadyPaid = tail[0]?.status === 'part_paid' ? (parseRupees(tail[0].paid ?? '0') ?? 0) : 0;
    const free = n - kept.length;
    const pool = totalPaise - keptSum - alreadyPaid;
    if (free < 1 || pool <= 0) return;
    const parts = splitEqual(pool, free);
    const firstDate = rows[0]?.dueDate || dueDate || addDays(today, 15);
    const next = parts.map((p, k) => {
      const old = tail[k];
      const amount = fromPaise(p + (k === 0 ? alreadyPaid : 0));
      const date = revising && old?.dueDate ? old.dueDate : addMonths(firstDate, kept.length + k);
      return old ? { ...old, amount, dueDate: date } : newRow({ amount, dueDate: date });
    });
    editRows([...kept, ...next]);
  };

  const save = useMutation({
    mutationFn: async (_issue: boolean) => {
      // absent = unchanged; [] = switch the schedule off; 2–24 = replace it.
      const hadSchedule = (existing.data?.instalments.length ?? 0) > 0;
      const unchanged = existing.data ? sameSchedule(rows, existing.data.instalments) && instOn === hadSchedule : false;
      const instalments = instOn
        ? !invoiceId || (scheduleDirty && !unchanged)
          ? toPayload(rows)
          : undefined
        : hadSchedule && scheduleDirty
          ? []
          : undefined;
      const body = {
        issueDate,
        dueDate: effectiveDue,
        notes,
        discountAmount: discount || '0',
        taxAmount: gst ? '0' : tax || '0',
        ...(gst ? { isReverseCharge: Boolean(rcm), placeOfSupply } : {}),
        items: lines
          .filter((l) => l.description.trim() || l.unitPrice.trim())
          .map((l) => ({
            description: l.description,
            quantity: l.quantity || '1',
            unitPrice: l.unitPrice,
            sacCode: gst && !l.isPureAgent ? l.sacCode : null,
            gstRate: gst && !l.isPureAgent ? l.gstRate : null,
            isPureAgent: gst ? l.isPureAgent : false,
            feeMilestoneId: l.feeMilestoneId ?? null,
            expenseId: l.expenseId ?? null,
          })),
        ...(instalments ? { instalments } : {}),
      };
      if (revising) {
        return api.patch<InvoiceDetailDto>(
          `/invoices/${invoiceId}/revision`,
          reviseInvoiceSchema.parse({ ...body, notifyClient: notifyClient && Boolean(existing.data?.sentAt) }),
        );
      }
      if (invoiceId) {
        await api.patch<InvoiceDetailDto>(`/invoices/${invoiceId}`, updateInvoiceSchema.parse(body));
        return api.get<InvoiceDetailDto>(`/invoices/${invoiceId}`);
      }
      // "Issue invoice" saves the draft first, then the issue sheet picks signatory / send-later.
      return api.post<InvoiceDetailDto>('/invoices', createInvoiceSchema.parse({ ...body, matterId, issue: false }));
    },
    onSuccess: (inv, issue) => {
      for (const k of ['invoices', 'invoice', 'billing', 'dashboard', 'matter', 'expenses', 'fee-agreements'])
        void qc.invalidateQueries({ queryKey: [k] });
      if (issue) setIssuing(inv);
      else navigate(`/invoices/${inv.id}`, { replace: true });
    },
    onError: (err) => {
      if (err instanceof z.ZodError)
        setErrors(Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])));
      else if (err instanceof ApiError)
        setErrors(
          Object.fromEntries(err.details.filter((d) => d.path).map((d) => [d.path!, d.message ?? ''])),
        );
    },
  });

  if (invoiceId && existing.isPending) return <SkeletonList rows={5} />;
  if (existing.data && existing.data.status !== 'draft' && !revising) {
    return (
      <Alert tone="info">
        This invoice is issued and can no longer be edited. Use a credit note or void it.
      </Alert>
    );
  }

  const set = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const usedExpenses = new Set(lines.map((l) => l.expenseId).filter(Boolean));
  const usedMilestones = new Set(lines.map((l) => l.feeMilestoneId).filter(Boolean));
  const billableMilestones = (agreements.data ?? [])
    .flatMap((a) => a.milestones)
    .filter((m) => m.status === 'planned' && !usedMilestones.has(m.id));
  const t = preview.totals;
  // Revisions: show the server's refusal (409/422) verbatim, even when it carries field details.
  const generalError =
    save.error instanceof ApiError && (revising || save.error.details.length === 0) ? save.error.message : null;

  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <PageHeader
        title={revising ? `Edit invoice ${existing.data?.invoiceNumber ?? ''}` : invoiceId ? 'Edit draft invoice' : 'New invoice'}
        description={
          revising
            ? `Saving creates revision ${(existing.data?.revision ?? 0) + 1}. The number, date, client and matter stay fixed.`
            : gst
              ? 'GST invoice'
              : 'Tax entered as a single amount (firm setting)'
        }
      />
      {revising ? (
        <Alert tone="info">
          Editing creates Revision {(existing.data?.revision ?? 0) + 1}; any signed copy will no longer apply.
        </Alert>
      ) : null}
      {generalError ? <Alert tone="danger">{generalError}</Alert> : null}

      <Card>
        <CardHeader title="Bill to" />
        <CardBody className="space-y-3">
          {presetMatterId || invoiceId ? (
            <div className="rounded-lg bg-subtle px-3 py-2 text-sm">
              <span className="font-medium">{matterDetail.data?.title ?? '…'}</span>
              <span className="text-muted"> · {matterDetail.data?.client.name}</span>
            </div>
          ) : (
            <MatterPicker label="Matter" value={matter} onChange={setMatter} />
          )}
          {errors.matterId ? <p className="text-sm text-danger-700">Choose the matter</p> : null}
          {gst && client.data ? (
            <p className="text-xs text-muted">
              Client GSTIN: {client.data.gstin ?? 'not on file'} · State code:{' '}
              {client.data.stateCode ?? 'not on file'}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Items" />
        <CardBody className="space-y-3">
          {lines.map((l, i) => (
            <div key={l.key} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    label={`Item ${i + 1}`}
                    placeholder="e.g. Professional fees: drafting of plaint"
                    value={l.description}
                    onChange={(e) => set(l.key, { description: e.target.value })}
                    error={errors[`items.${i}.description`]}
                  />
                </div>
                {lines.length > 1 ? (
                  <button
                    type="button"
                    aria-label={`Remove item ${i + 1}`}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="mt-7 grid size-10 place-items-center rounded-lg text-muted hover:bg-subtle"
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
              <div className={cn('grid gap-2', gst ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2')}>
                <TextField
                  label="Qty"
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => set(l.key, { quantity: e.target.value })}
                  error={errors[`items.${i}.quantity`]}
                />
                <TextField
                  label="Rate (₹)"
                  inputMode="decimal"
                  value={l.unitPrice}
                  onChange={(e) => set(l.key, { unitPrice: e.target.value })}
                  error={errors[`items.${i}.unitPrice`]}
                />
                {gst && !l.isPureAgent ? (
                  <>
                    <TextField
                      label="GST %"
                      inputMode="decimal"
                      value={l.gstRate}
                      onChange={(e) => set(l.key, { gstRate: e.target.value })}
                      error={errors[`items.${i}.gstRate`]}
                    />
                    <TextField
                      label="SAC"
                      inputMode="numeric"
                      value={l.sacCode}
                      onChange={(e) => set(l.key, { sacCode: e.target.value })}
                      error={errors[`items.${i}.sacCode`]}
                    />
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                {gst ? (
                  <label className="flex min-h-9 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-700"
                      checked={l.isPureAgent}
                      onChange={(e) => set(l.key, { isPureAgent: e.target.checked })}
                    />
                    Reimbursement as pure agent (no GST)
                  </label>
                ) : (
                  <span />
                )}
                {l.expenseId ? (
                  <span>Linked expense</span>
                ) : l.feeMilestoneId ? (
                  <span>Linked milestone</span>
                ) : null}
                {t ? (
                  <span className="font-medium text-ink-soft tabular-nums">
                    {formatINR(
                      fromPaise(t.lineAmounts[lines.filter((x) => x.unitPrice.trim()).indexOf(l)] ?? 0),
                    )}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
          {errors.items ? <p className="text-sm text-danger-700">{errors.items}</p> : null}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-4" />}
            onClick={() => setLines((ls) => [...ls, newLine({}, defaults)])}
          >
            Add item
          </Button>
          {(expenses.data ?? []).filter((e) => !usedExpenses.has(e.id)).length ||
          billableMilestones.length ? (
            <div className="space-y-2 rounded-lg bg-subtle p-3">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                Unbilled on this matter
              </p>
              <div className="flex flex-wrap gap-2">
                {billableMilestones.map((m) => (
                  <Button
                    key={m.id}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setLines((ls) => [
                        ...ls.filter((x) => x.description || x.unitPrice),
                        newLine({ description: m.name, unitPrice: m.amount, feeMilestoneId: m.id }, defaults),
                      ])
                    }
                  >
                    + {m.name} · {formatINR(m.amount, { whole: true })}
                  </Button>
                ))}
                {(expenses.data ?? [])
                  .filter((e) => !usedExpenses.has(e.id))
                  .map((e) => (
                    <Button
                      key={e.id}
                      size="sm"
                      variant="secondary"
                      icon={<Receipt className="size-3.5" />}
                      onClick={() =>
                        setLines((ls) => [
                          ...ls.filter((x) => x.description || x.unitPrice),
                          newLine(
                            {
                              description: `${e.category ?? 'Expense'}${e.description ? `: ${e.description}` : ''}`,
                              unitPrice: e.amount,
                              expenseId: e.id,
                              isPureAgent: gst,
                            },
                            defaults,
                          ),
                        ])
                      }
                    >
                      {e.category ?? 'Expense'} · {formatINR(e.amount, { whole: true })}
                    </Button>
                  ))}
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Terms & tax" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Invoice date"
            type="date"
            value={issueDate}
            disabled={revising}
            onChange={(e) => setIssueDate(e.target.value)}
            error={errors.issueDate}
          />
          {instOn ? (
            <TextField
              label="Due date"
              type="date"
              value={effectiveDue}
              disabled
              hint="The last instalment’s date"
              onChange={() => undefined}
            />
          ) : (
            <TextField
              label="Due date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              error={errors.dueDate}
            />
          )}
          <TextField
            label="Discount (₹)"
            inputMode="decimal"
            placeholder="0"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            error={errors.discountAmount}
          />
          {gst ? (
            <TextField
              label="Place of supply (state code)"
              inputMode="numeric"
              value={placeOfSupply}
              onChange={(e) => setPlaceOfSupply(e.target.value)}
              error={errors.placeOfSupply}
              hint={
                placeOfSupply && placeOfSupply === org.data?.stateCode
                  ? 'Same state: CGST + SGST'
                  : 'Other state: IGST'
              }
            />
          ) : (
            <TextField
              label="Tax (₹)"
              inputMode="decimal"
              placeholder="0"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              error={errors.taxAmount}
            />
          )}
          {gst ? (
            <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand-700"
                checked={Boolean(rcm)}
                onChange={(e) => setRcm(e.target.checked)}
              />
              <span>
                Reverse charge: GST is payable by the client
                <span className="block text-xs text-muted">
                  Usually applies to legal services to business entities. Confirm with your CA.
                </span>
              </span>
            </label>
          ) : null}
          <div className="sm:col-span-2">
            <TextAreaField
              label="Notes on invoice"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Pay in instalments" description="Split the total into dated parts. Each gets its own payment link." />
        <CardBody className="space-y-3">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-brand-700"
              checked={instOn}
              onChange={(e) => toggleInstalments(e.target.checked)}
            />
            Pay this invoice in instalments
          </label>
          {instOn ? (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-24">
                  <TextField
                    label="Instalments"
                    inputMode="numeric"
                    value={splitN}
                    onChange={(e) => setSplitN(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={!totalPaise || Number(splitN) < MIN_INSTALMENTS || Number(splitN) > MAX_INSTALMENTS}
                  onClick={() => splitInto(Number(splitN))}
                >
                  Split equally into {splitN || '…'}, monthly
                </Button>
              </div>
              <ul className="space-y-2">
                {rows.map((r, idx) => {
                  const locked = isLockedRow(r);
                  const setRow = (patch: Partial<ScheduleRow>) =>
                    editRows(rows.map((x) => (x.key === r.key ? { ...x, ...patch } : x)));
                  return (
                    <li key={r.key} className="rounded-lg border border-line p-3">
                      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
                        <span className="font-medium text-ink-soft">Instalment {idx + 1}</span>
                        {locked ? (
                          <Badge tone="success">Paid</Badge>
                        ) : r.status === 'part_paid' ? (
                          <Badge tone="warning">Part paid · {formatINR(r.paid ?? '0')}</Badge>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                        <TextField
                          label="Amount (₹)"
                          inputMode="decimal"
                          value={r.amount}
                          disabled={locked}
                          onChange={(e) => setRow({ amount: e.target.value })}
                          error={errors[`instalments.${idx}.amount`]}
                        />
                        <TextField
                          label="Due date"
                          type="date"
                          value={r.dueDate}
                          disabled={locked}
                          onChange={(e) => setRow({ dueDate: e.target.value })}
                          error={errors[`instalments.${idx}.dueDate`]}
                        />
                        {!locked && !(parseRupees(r.paid ?? '0') ?? 0) ? (
                          <button
                            type="button"
                            aria-label={`Remove instalment ${idx + 1}`}
                            disabled={rows.length <= MIN_INSTALMENTS || idx < lastLocked}
                            onClick={() => editRows(rows.filter((x) => x.key !== r.key))}
                            className="grid size-10 place-items-center justify-self-end rounded-lg text-muted hover:bg-subtle disabled:opacity-40"
                          >
                            <X className="size-4" />
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="size-4" />}
                  disabled={rows.length >= MAX_INSTALMENTS}
                  onClick={() =>
                    editRows([
                      ...rows,
                      newRow({
                        dueDate: rows.length ? addMonths(rows[0]!.dueDate || dueDate, rows.length) : dueDate,
                      }),
                    ])
                  }
                >
                  Add instalment
                </Button>
                <p
                  className={cn(
                    'text-sm tabular-nums',
                    totalPaise !== null && check.difference !== 0 ? 'text-danger-700' : 'text-ink-soft',
                  )}
                >
                  {formatINR(fromPaise(check.sum))} of {totalPaise !== null ? formatINR(fromPaise(totalPaise)) : '—'}
                </p>
              </div>
              {scheduleError ? <Alert tone="warning">{scheduleError}</Alert> : null}
            </>
          ) : null}
        </CardBody>
      </Card>

      {revising && !existing.data?.sentAt ? (
        <p className="text-sm text-muted">
          This invoice hasn’t been sent yet, so the client isn’t notified. Save, then use Send.
        </p>
      ) : null}
      {revising && existing.data?.sentAt ? (
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand-700"
            checked={notifyClient}
            onChange={(e) => setNotifyClient(e.target.checked)}
          />
          <span>
            Notify client
            <span className="block text-xs text-muted">Emails the client the updated invoice.</span>
          </span>
        </label>
      ) : null}

      <Card>
        <CardHeader title="Total" />
        <CardBody>
          {preview.error ? (
            <Alert tone="warning">{preview.error}</Alert>
          ) : t ? (
            <dl className="space-y-1.5 text-sm tabular-nums">
              <Row label="Subtotal" value={t.subtotal} />
              {t.discount ? <Row label="Discount" value={-t.discount} /> : null}
              {t.cgst ? <Row label="CGST" value={t.cgst} /> : null}
              {t.sgst ? <Row label="SGST" value={t.sgst} /> : null}
              {t.igst ? <Row label="IGST" value={t.igst} /> : null}
              {!gst && t.tax ? <Row label="Tax" value={t.tax} /> : null}
              {t.rcmTax ? (
                <Row label="GST payable by client (reverse charge)" value={t.rcmTax} muted />
              ) : null}
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd>{formatINR(fromPaise(t.total))}</dd>
              </div>
            </dl>
          ) : null}
        </CardBody>
      </Card>

      <div className="fixed inset-x-0 bottom-16 z-10 flex gap-2 border-t border-line bg-surface p-3 sm:static sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-0">
        <Link to={invoiceId ? `/invoices/${invoiceId}` : '/billing'} className="hidden sm:block">
          <Button variant="secondary">Cancel</Button>
        </Link>
        {revising ? (
          <Button
            block
            className="sm:w-auto"
            loading={save.isPending}
            disabled={Boolean(preview.error) || Boolean(scheduleError)}
            onClick={() => save.mutate(false)}
          >
            Save revision
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              block
              className="sm:w-auto"
              loading={save.isPending && save.variables === false}
              disabled={!matterId || Boolean(preview.error) || Boolean(scheduleError)}
              onClick={() => save.mutate(false)}
            >
              Save draft
            </Button>
            <Button
              block
              className="sm:w-auto"
              loading={save.isPending && save.variables === true}
              disabled={!matterId || Boolean(preview.error) || Boolean(scheduleError)}
              onClick={() => save.mutate(true)}
            >
              Issue invoice
            </Button>
          </>
        )}
      </div>
      {issuing ? (
        <IssueSheet
          open
          invoice={issuing}
          onClose={() => navigate(`/invoices/${issuing.id}`, { replace: true })}
          onIssued={(inv) => navigate(`/invoices/${inv.id}`, { replace: true })}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', muted && 'text-muted')}>
      <dt>{label}</dt>
      <dd>{value < 0 ? `− ${formatINR(fromPaise(-value))}` : formatINR(fromPaise(value))}</dd>
    </div>
  );
}
