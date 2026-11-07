import type { WireDocModel } from '@legalops/types';
import {
  INVOICE_SECTION_LABELS,
  REQUIRED_INVOICE_SECTIONS,
  type InvoiceFormat,
  type InvoiceSectionId,
} from '@legalops/validation';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  SelectField,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { InvoiceDocument } from '../billing/InvoiceDocument.js';

type FormatResponse = { format: InvoiceFormat; isDefault: boolean };
const A4_PX = 794; // 210 mm at 96 dpi

/** The value, a moment after it stops changing. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Group({
  title,
  hint,
  children,
  open = false,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span>
          <span className="block text-sm font-semibold text-ink">{title}</span>
          {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
        </span>
        <span className="text-muted transition-transform group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium text-ink">{label}</span>
        {hint ? <span className="block text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-ink">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          className="h-11 w-14 cursor-pointer rounded-lg border border-line bg-surface p-1"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <input
          aria-label={label}
          className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink uppercase focus:outline-2 focus:outline-brand-600 sm:text-sm"
          value={text}
          maxLength={7}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
        />
      </div>
    </div>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  show,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="flex justify-between font-medium text-ink">
        <span>{label}</span>
        <span className="text-muted tabular-nums">{show(value)}</span>
      </span>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Mover({
  onUp,
  onDown,
  first,
  last,
  name,
}: {
  onUp: () => void;
  onDown: () => void;
  first: boolean;
  last: boolean;
  name: string;
}) {
  return (
    <span className="flex shrink-0 gap-1">
      <button
        type="button"
        aria-label={`Move ${name} up`}
        disabled={first}
        onClick={onUp}
        className="grid size-8 place-items-center rounded-lg border border-line text-ink-soft hover:bg-subtle disabled:opacity-30"
      >
        <ArrowUp className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Move ${name} down`}
        disabled={last}
        onClick={onDown}
        className="grid size-8 place-items-center rounded-lg border border-line text-ink-soft hover:bg-subtle disabled:opacity-30"
      >
        <ArrowDown className="size-4" aria-hidden />
      </button>
    </span>
  );
}

function move<T>(list: T[], from: number, to: number) {
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
}

/** A4 sheet scaled to the width of its box. */
function Preview({ model, busy }: { model: WireDocModel | undefined; busy: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / A4_PX));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={box}
      className="relative w-full overflow-hidden rounded-lg border border-line bg-canvas"
      style={{ height: `${1123 * scale}px` }}
      aria-busy={busy}
    >
      {model ? (
        <div style={{ width: A4_PX, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <InvoiceDocument model={model} />
        </div>
      ) : null}
      {busy ? (
        <span className="absolute top-2 right-2 rounded bg-surface/90 px-2 py-0.5 text-xs text-muted">
          Updating…
        </span>
      ) : null}
    </div>
  );
}

export function InvoiceFormatPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['invoice-format'],
    queryFn: () => api.get<FormatResponse>('/organization/invoice-format'),
  });
  const [draft, setDraft] = useState<InvoiceFormat | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (q.data && draft === null) setDraft(q.data.format);
  }, [q.data, draft]);

  const edit = (fn: (d: InvoiceFormat) => void) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  const draftKey = useDebounced(draft ? JSON.stringify(draft) : '', 400);
  const preview = useQuery({
    queryKey: ['invoice-format-preview', draftKey],
    queryFn: () => api.post<WireDocModel>('/organization/invoice-format/preview', JSON.parse(draftKey)),
    enabled: draftKey !== '',
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  const done = (r: FormatResponse) => {
    qc.setQueryData(['invoice-format'], r);
    setDraft(r.format);
    setConfirmReset(false);
    void qc.invalidateQueries({ queryKey: ['invoice-document'] });
  };
  const save = useMutation({
    mutationFn: (f: InvoiceFormat) => api.patch<FormatResponse>('/organization/invoice-format', f),
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: () => api.post<FormatResponse>('/organization/invoice-format/reset'),
    onSuccess: done,
  });

  if (q.isPending || !draft) return <SkeletonList rows={6} />;
  if (q.isError) return <Alert tone="danger">Couldn’t load the invoice format. Refresh to try again.</Alert>;

  const saved = q.data.format;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const err = [save.error, reset.error].find((e) => e instanceof ApiError) as ApiError | undefined;
  const text = (get: (d: InvoiceFormat) => string, set: (d: InvoiceFormat, v: string) => void) => ({
    value: get(draft),
    onChange: (e: { target: { value: string } }) => edit((d) => set(d, e.target.value)),
  });

  return (
    <div className="space-y-4 pb-20 sm:pb-0">
      <PageHeader
        title="Invoice format"
        description="How your invoices look when they are printed, downloaded or emailed. Changes apply to every invoice, including ones already issued."
      />
      {err ? <Alert tone="danger">{err.message}</Alert> : null}
      {save.isSuccess && !dirty ? <Alert tone="success">Invoice format saved.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Group title="Layout" hint="Order the sections and choose which ones appear" open>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {draft.sections.map((s, i) => {
                const required = REQUIRED_INVOICE_SECTIONS.includes(s.id);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <Check
                      label={INVOICE_SECTION_LABELS[s.id as InvoiceSectionId]}
                      checked={s.show}
                      disabled={required}
                      onChange={(v) => edit((d) => void (d.sections[i]!.show = v))}
                    />
                    <Mover
                      name={INVOICE_SECTION_LABELS[s.id as InvoiceSectionId]}
                      first={i === 0}
                      last={i === draft.sections.length - 1}
                      onUp={() => edit((d) => move(d.sections, i, i - 1))}
                      onDown={() => edit((d) => move(d.sections, i, i + 1))}
                    />
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted">
              The letterhead and invoice title are always at the top and the footer at the bottom. The
              customer and the items can be moved but not hidden.
            </p>
            <SelectField
              label="Invoice details column"
              value={draft.parties.detailsSide}
              onChange={(e) => edit((d) => void (d.parties.detailsSide = e.target.value as 'left' | 'right'))}
              options={[
                { value: 'right', label: 'On the right of the customer' },
                { value: 'left', label: 'On the left of the customer' },
              ]}
            />
            <SelectField
              label="Signature position"
              value={draft.signature.align}
              onChange={(e) =>
                edit((d) => void (d.signature.align = e.target.value as 'left' | 'center' | 'right'))
              }
              options={[
                { value: 'right', label: 'Right' },
                { value: 'center', label: 'Centre' },
                { value: 'left', label: 'Left' },
              ]}
            />
          </Group>

          <Group title="Colours and style">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField
                label="Main colour"
                value={draft.accentColor}
                onChange={(v) => edit((d) => void (d.accentColor = v))}
              />
              <ColorField
                label="Line colour"
                value={draft.ruleColor}
                onChange={(v) => edit((d) => void (d.ruleColor = v))}
              />
            </div>
            <SelectField
              label="Amounts"
              value={draft.currencyStyle}
              onChange={(e) => edit((d) => void (d.currencyStyle = e.target.value as 'rs' | 'symbol'))}
              options={[
                { value: 'rs', label: 'Rs. 15,000.00' },
                { value: 'symbol', label: '₹15,000.00' },
              ]}
            />
            <Check
              label="Coloured header bar on the items table"
              checked={draft.items.filledHeader}
              onChange={(v) => edit((d) => void (d.items.filledHeader = v))}
            />
            <Check
              label="Show the total in the main colour"
              checked={draft.totals.accent}
              onChange={(v) => edit((d) => void (d.totals.accent = v))}
            />
            <Check
              label="Signer’s name in the main colour"
              checked={draft.signature.accentName}
              onChange={(v) => edit((d) => void (d.signature.accentName = v))}
            />
          </Group>

          <Group title="Letterhead" hint="Logo, firm name and address at the top">
            <SelectField
              label="Alignment"
              value={draft.letterhead.align}
              onChange={(e) => edit((d) => void (d.letterhead.align = e.target.value as 'left' | 'center'))}
              options={[
                { value: 'center', label: 'Centred' },
                { value: 'left', label: 'Left' },
              ]}
            />
            <Check
              label="Logo"
              checked={draft.letterhead.showLogo}
              onChange={(v) => edit((d) => void (d.letterhead.showLogo = v))}
            />
            <SelectField
              label="Logo size"
              value={draft.letterhead.logoSize}
              onChange={(e) =>
                edit((d) => void (d.letterhead.logoSize = e.target.value as 'small' | 'medium' | 'large'))
              }
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
            />
            <Check
              label="Firm name"
              checked={draft.letterhead.showName}
              onChange={(v) => edit((d) => void (d.letterhead.showName = v))}
            />
            <Check
              label="Firm name in capitals"
              checked={draft.letterhead.uppercaseName}
              onChange={(v) => edit((d) => void (d.letterhead.uppercaseName = v))}
            />
            <Check
              label="Registration number"
              hint="For example LLPIN or Bar Council number, from Firm settings"
              checked={draft.letterhead.showRegistration}
              onChange={(v) => edit((d) => void (d.letterhead.showRegistration = v))}
            />
            <Check
              label="Address"
              checked={draft.letterhead.showAddress}
              onChange={(v) => edit((d) => void (d.letterhead.showAddress = v))}
            />
            <TextField
              label="Text before the address"
              {...text(
                (d) => d.letterhead.addressPrefix,
                (d, v) => void (d.letterhead.addressPrefix = v),
              )}
              hint="For example “Registered Office:”. Leave empty to print the address alone."
            />
            <Check
              label="GSTIN"
              checked={draft.letterhead.showGstin}
              onChange={(v) => edit((d) => void (d.letterhead.showGstin = v))}
            />
            <Check
              label="Email and phone"
              hint="Usually shown in the footer instead"
              checked={draft.letterhead.showContact}
              onChange={(v) => edit((d) => void (d.letterhead.showContact = v))}
            />
            <Check
              label="Line under the letterhead"
              checked={draft.letterhead.rule}
              onChange={(v) => edit((d) => void (d.letterhead.rule = v))}
            />
          </Group>

          <Group title="Wording" hint="Titles and labels">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Invoice title"
                {...text(
                  (d) => d.title.text,
                  (d, v) => void (d.title.text = v),
                )}
              />
              <TextField
                label="Title on a GST invoice"
                {...text(
                  (d) => d.title.taxText,
                  (d, v) => void (d.title.taxText = v),
                )}
              />
            </div>
            <SelectField
              label="Title position"
              value={draft.title.align}
              onChange={(e) =>
                edit((d) => void (d.title.align = e.target.value as 'left' | 'center' | 'right'))
              }
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centre' },
                { value: 'right', label: 'Right' },
              ]}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Customer heading"
                {...text(
                  (d) => d.parties.billedToLabel,
                  (d, v) => void (d.parties.billedToLabel = v),
                )}
              />
              <TextField
                label="Details heading"
                {...text(
                  (d) => d.parties.detailsLabel,
                  (d, v) => void (d.parties.detailsLabel = v),
                )}
              />
              <TextField
                label="Subject label"
                {...text(
                  (d) => d.subject.label,
                  (d, v) => void (d.subject.label = v),
                )}
              />
              <TextField
                label="Total label"
                {...text(
                  (d) => d.totals.totalLabel,
                  (d, v) => void (d.totals.totalLabel = v),
                )}
              />
              <TextField
                label="Description column"
                {...text(
                  (d) => d.items.descriptionLabel,
                  (d, v) => void (d.items.descriptionLabel = v),
                )}
              />
              <TextField
                label="Amount column"
                {...text(
                  (d) => d.items.amountLabel,
                  (d, v) => void (d.items.amountLabel = v),
                )}
              />
              <TextField
                label="Payment heading"
                {...text(
                  (d) => d.payment.title,
                  (d, v) => void (d.payment.title = v),
                )}
              />
              <TextField
                label="Notes heading"
                {...text(
                  (d) => d.notes.title,
                  (d, v) => void (d.notes.title = v),
                )}
              />
              <TextField
                label="Schedule heading"
                {...text(
                  (d) => d.schedule.title,
                  (d, v) => void (d.schedule.title = v),
                )}
              />
            </div>
            <TextField
              label="Line above the bank details"
              {...text(
                (d) => d.payment.intro,
                (d, v) => void (d.payment.intro = v),
              )}
            />
            <TextField
              label="Signature line"
              {...text(
                (d) => d.signature.onBehalfText,
                (d, v) => void (d.signature.onBehalfText = v),
              )}
              hint="{firm} becomes your firm’s name"
            />
            <Check
              label="Item numbers"
              checked={draft.items.showNumber}
              onChange={(v) => edit((d) => void (d.items.showNumber = v))}
            />
            <Check
              label="Quantity and rate columns"
              hint="Always shown when an item has a quantity other than 1"
              checked={draft.items.showQuantityRate}
              onChange={(v) => edit((d) => void (d.items.showQuantityRate = v))}
            />
          </Group>

          <Group title="Invoice details" hint="The rows next to the customer">
            <ul className="divide-y divide-line rounded-lg border border-line">
              {draft.parties.details.map((r, i) => (
                <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    aria-label={`Show ${r.label}`}
                    checked={r.show}
                    onChange={(e) => edit((d) => void (d.parties.details[i]!.show = e.target.checked))}
                  />
                  <input
                    aria-label={`Label for ${r.id}`}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-sm focus:outline-2 focus:outline-brand-600"
                    value={r.label}
                    maxLength={40}
                    onChange={(e) => edit((d) => void (d.parties.details[i]!.label = e.target.value))}
                  />
                  <Mover
                    name={r.label}
                    first={i === 0}
                    last={i === draft.parties.details.length - 1}
                    onUp={() => edit((d) => move(d.parties.details, i, i - 1))}
                    onDown={() => edit((d) => move(d.parties.details, i, i + 1))}
                  />
                </li>
              ))}
            </ul>
            <Check
              label="Customer’s attention line"
              checked={draft.parties.showAttention}
              onChange={(v) => edit((d) => void (d.parties.showAttention = v))}
            />
            <Check
              label="Customer’s email"
              checked={draft.parties.showEmail}
              onChange={(v) => edit((d) => void (d.parties.showEmail = v))}
            />
            <Check
              label="Customer’s phone"
              checked={draft.parties.showPhone}
              onChange={(v) => edit((d) => void (d.parties.showPhone = v))}
            />
            <Check
              label="Customer’s GSTIN"
              checked={draft.parties.showClientGstin}
              onChange={(v) => edit((d) => void (d.parties.showClientGstin = v))}
            />
          </Group>

          <Group title="Footer">
            <Check
              label="Show the footer"
              checked={draft.footer.show}
              onChange={(v) => edit((d) => void (d.footer.show = v))}
            />
            <TextField
              label="Thank-you line"
              {...text(
                (d) => d.footer.thankYou,
                (d, v) => void (d.footer.thankYou = v),
              )}
            />
            <TextField
              label="Website"
              {...text(
                (d) => d.footer.website,
                (d, v) => void (d.footer.website = v),
              )}
              placeholder="www.yourfirm.com"
            />
            <TextField
              label="Tagline"
              {...text(
                (d) => d.footer.tagline,
                (d, v) => void (d.footer.tagline = v),
              )}
              placeholder="Corporate advisory & regulatory compliance"
            />
            <Check
              label="Phone and email in the footer"
              checked={draft.footer.showContact}
              onChange={(v) => edit((d) => void (d.footer.showContact = v))}
            />
            <Check
              label="Line above the footer"
              checked={draft.footer.rule}
              onChange={(v) => edit((d) => void (d.footer.rule = v))}
            />
            <Check
              label="“Powered by LexForgeX”"
              checked={draft.footer.poweredBy}
              onChange={(v) => edit((d) => void (d.footer.poweredBy = v))}
            />
          </Group>

          <Group title="Watermark" hint="A faint mark behind the invoice">
            <SelectField
              label="Watermark"
              value={draft.watermark.mode}
              onChange={(e) =>
                edit((d) => void (d.watermark.mode = e.target.value as 'none' | 'logo' | 'text'))
              }
              options={[
                { value: 'logo', label: 'Your logo' },
                { value: 'text', label: 'Text' },
                { value: 'none', label: 'None' },
              ]}
            />
            {draft.watermark.mode === 'text' ? (
              <TextField
                label="Watermark text"
                maxLength={40}
                {...text(
                  (d) => d.watermark.text,
                  (d, v) => void (d.watermark.text = v),
                )}
                placeholder="CONFIDENTIAL"
              />
            ) : null}
            {draft.watermark.mode !== 'none' ? (
              <>
                <Range
                  label="Strength"
                  value={draft.watermark.opacity}
                  min={0.01}
                  max={0.4}
                  step={0.005}
                  show={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => edit((d) => void (d.watermark.opacity = v))}
                />
                <Range
                  label="Size"
                  value={draft.watermark.scale}
                  min={0.2}
                  max={0.95}
                  step={0.05}
                  show={(v) => `${Math.round(v * 100)}% of the page width`}
                  onChange={(v) => edit((d) => void (d.watermark.scale = v))}
                />
                <Range
                  label="Angle"
                  value={draft.watermark.rotation}
                  min={-90}
                  max={90}
                  step={5}
                  show={(v) => `${v}°`}
                  onChange={(v) => edit((d) => void (d.watermark.rotation = v))}
                />
                <SelectField
                  label="Position"
                  value={draft.watermark.position}
                  onChange={(e) =>
                    edit((d) => void (d.watermark.position = e.target.value as 'top' | 'center' | 'bottom'))
                  }
                  options={[
                    { value: 'center', label: 'Middle of the page' },
                    { value: 'top', label: 'Upper part' },
                    { value: 'bottom', label: 'Lower part' },
                  ]}
                />
                {draft.watermark.mode === 'logo' ? (
                  <p className="text-xs text-muted">
                    Uses the logo from Firm settings. With no logo uploaded, no watermark is drawn.
                  </p>
                ) : null}
              </>
            ) : null}
          </Group>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader
              title="Preview"
              description="A sample invoice with your letterhead, logo and bank details."
            />
            <CardBody>
              {preview.isError ? (
                <Alert tone="danger">Couldn’t draw the preview. Your last valid preview is shown.</Alert>
              ) : null}
              <Preview model={preview.data} busy={preview.isFetching || draftKey !== JSON.stringify(draft)} />
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-16 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface p-3 sm:static sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-0">
        <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
          Save changes
        </Button>
        <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(saved)}>
          Discard changes
        </Button>
        {!q.data.isDefault && !confirmReset ? (
          <Button variant="ghost" onClick={() => setConfirmReset(true)}>
            Back to standard format
          </Button>
        ) : null}
        {confirmReset ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-muted">Replace your format with the standard one?</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger-700"
              loading={reset.isPending}
              onClick={() => reset.mutate()}
            >
              Yes, reset
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
              Keep mine
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
