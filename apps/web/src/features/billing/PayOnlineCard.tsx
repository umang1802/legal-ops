import type { InvoiceDetailDto, InvoicePaymentLinksDto, PaymentLinkDto } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, TextField, type Tone } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { formatINR } from '../../lib/money.js';

const TONE: Record<PaymentLinkDto['status'], Tone> = {
  active: 'info',
  paid: 'success',
  expired: 'neutral',
  canceled: 'neutral',
};
const LABEL: Record<PaymentLinkDto['status'], string> = {
  active: 'Open',
  paid: 'Paid',
  expired: 'Expired',
  canceled: 'Canceled',
};

/**
 * Pay-online links for an invoice (Zoho Payments). Shown only when the firm has online payments switched on, or already
 * has links. The money is recorded by Zoho's webhook, so while a link is open this refreshes itself to pick that up.
 */
export function PayOnlineCard({ invoice, canManage }: { invoice: InvoiceDetailDto; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ['invoice-payment-links', invoice.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<InvoicePaymentLinksDto>(`/invoices/${invoice.id}/payment-links`),
    refetchInterval: (query) => (query.state.data?.links.some((l) => l.status === 'active') ? 15_000 : false),
  });
  const [amount, setAmount] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // A payment landing through the webhook changes the invoice itself: refresh it when a link turns paid.
  const paid = q.data?.links.filter((l) => l.status === 'paid').length ?? 0;
  const lastPaid = useRef<number | null>(null);
  useEffect(() => {
    if (q.data === undefined) return;
    if (lastPaid.current !== null && paid > lastPaid.current) {
      for (const k of ['invoice', 'invoices', 'payments', 'billing', 'dashboard', 'matter'])
        void qc.invalidateQueries({ queryKey: [k] });
    }
    lastPaid.current = paid;
  }, [paid, q.data, qc]);

  const create = useMutation({
    mutationFn: () =>
      api.post<PaymentLinkDto>(
        `/invoices/${invoice.id}/payment-links`,
        amount.trim() ? { amount: amount.trim() } : {},
      ),
    onSuccess: () => {
      setAmount('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const cancel = useMutation({
    mutationFn: (linkId: string) =>
      api.post<PaymentLinkDto>(`/invoices/${invoice.id}/payment-links/${linkId}/cancel`),
    onSuccess: () => {
      setConfirmCancel(null);
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  if (invoice.instalments.length > 0) return null; // each instalment carries its own link
  if (q.isPending || q.isError) return null;
  const { enabled, links } = q.data;
  if (!enabled && links.length === 0) return null;
  const active = links.find((l) => l.status === 'active');
  const canCreate =
    enabled && canManage && invoice.status === 'issued' && Number(invoice.amountDue) > 0 && !active;

  const copy = async (l: PaymentLinkDto) => {
    try {
      await navigator.clipboard.writeText(l.url);
      setCopiedId(l.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard blocked: the link is selectable on screen */
    }
  };
  const whatsapp = (l: PaymentLinkDto) =>
    `https://wa.me/?text=${encodeURIComponent(`Please pay ${formatINR(l.amount)} for invoice ${invoice.invoiceNumber ?? ''} using this secure link: ${l.url}`)}`;

  return (
    <Card>
      <CardHeader
        title="Pay online"
        description="Send the client a secure Zoho Payments link (UPI, cards, net banking)."
      />
      <CardBody className="space-y-3 text-sm">
        {create.error instanceof ApiError ? <Alert tone="danger">{create.error.message}</Alert> : null}
        {cancel.error instanceof ApiError ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
        {links.some((l) => l.environment === 'sandbox' && l.status === 'active') ? (
          <Alert tone="warning" title="Test mode">
            This link is a Zoho sandbox link. Payments through it are not real.
          </Alert>
        ) : null}

        {active ? (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">{formatINR(active.amount)}</span>
              <Badge tone={TONE.active}>Open</Badge>
              {active.expiresAt ? (
                <span className="text-xs text-muted">Expires {formatDate(active.expiresAt)}</span>
              ) : null}
            </p>
            <code className="block rounded bg-subtle px-2 py-1.5 text-xs break-all select-all">
              {active.url}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy(active)}>
                {copiedId === active.id ? 'Copied' : 'Copy link'}
              </Button>
              <a href={whatsapp(active)} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="secondary">
                  Share on WhatsApp
                </Button>
              </a>
              {canManage && confirmCancel !== active.id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger-700"
                  onClick={() => setConfirmCancel(active.id)}
                >
                  Cancel link
                </Button>
              ) : null}
              {confirmCancel === active.id ? (
                <span className="flex items-center gap-2">
                  <span className="text-muted">Cancel this link?</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-700"
                    loading={cancel.isPending}
                    onClick={() => cancel.mutate(active.id)}
                  >
                    Yes, cancel
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(null)}>
                    Keep
                  </Button>
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted">
              When the client pays, the receipt is added to this invoice automatically. This page checks every
              few seconds.
            </p>
          </div>
        ) : null}

        {canCreate ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="w-44">
              <TextField
                label="Amount (₹)"
                inputMode="decimal"
                placeholder={invoice.amountDue}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                hint="Blank = full amount due"
              />
            </div>
            <Button type="submit" loading={create.isPending}>
              Create payment link
            </Button>
          </form>
        ) : null}

        {links.filter((l) => l.status !== 'active').length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {links
              .filter((l) => l.status !== 'active')
              .map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="tabular-nums">{formatINR(l.amount)}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {l.status === 'paid' && l.receiptNumber
                      ? `Receipt ${l.receiptNumber}`
                      : formatDate(l.createdAt.slice(0, 10))}
                    <Badge tone={TONE[l.status]}>{LABEL[l.status]}</Badge>
                  </span>
                </li>
              ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
