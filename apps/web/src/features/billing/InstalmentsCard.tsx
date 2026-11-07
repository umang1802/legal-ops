import type { InstalmentDto, InstalmentStatus, InvoiceDetailDto } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, type Tone } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { formatINR } from '../../lib/money.js';

const TONE: Record<InstalmentStatus, Tone> = { paid: 'success', part_paid: 'warning', due: 'info', overdue: 'danger' };
const LABEL: Record<InstalmentStatus, string> = { paid: 'Paid', part_paid: 'Part paid', due: 'Due', overdue: 'Overdue' };
const REFRESH = ['invoices', 'invoice', 'billing', 'dashboard', 'matter', 'invoice-payment-links'];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API blocked (insecure origin / permissions): fall back to a hidden textarea.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** The payment schedule of an invoice with instalments: status, last emailed, send now, copy the live link. */
export function InstalmentsCard({ invoice, canManage }: { invoice: InvoiceDetailDto; canManage: boolean }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const send = useMutation({
    mutationFn: (seq: number) => api.post<unknown>(`/invoices/${invoice.id}/instalments/${seq}/send`, {}),
    onSuccess: () => REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] })),
  });
  if (invoice.instalments.length === 0) return null;
  const issued = invoice.status === 'issued';
  const sent = invoice.sentAt !== null;

  const copy = async (x: InstalmentDto) => {
    if (!x.activeLink) return;
    const ok = await copyText(x.activeLink.url);
    setCopyFailed(!ok);
    setCopied(ok ? x.id : null);
    if (ok) window.setTimeout(() => setCopied((c) => (c === x.id ? null : c)), 2000);
  };

  return (
    <Card>
      <CardHeader title="Instalments" description={`${invoice.instalments.length} parts · the last one is the invoice due date`} />
      <CardBody className="space-y-3 text-sm">
        {send.error ? (
          <Alert tone="danger">{send.error instanceof ApiError ? send.error.message : 'Could not send.'}</Alert>
        ) : null}
        {copyFailed ? <Alert tone="warning">Couldn’t copy automatically. Select the link below and copy it.</Alert> : null}
        {issued && !sent ? (
          <p className="text-xs text-muted">Instalments can be sent once the invoice itself has been sent.</p>
        ) : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {invoice.instalments.map((x) => {
            const paid = x.status === 'paid';
            const sendingThis = send.isPending && send.variables === x.seq;
            return (
              <li key={x.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      #{x.seq} · <span className="tabular-nums">{formatINR(x.amount)}</span>
                    </p>
                    <p className="text-xs text-muted">
                      Due {formatDate(x.dueDate)}
                      {x.status === 'part_paid' ? ` · ${formatINR(x.remaining)} left` : ''}
                    </p>
                    <p className="text-xs text-muted">
                      {x.emailedAt ? `Emailed ${formatDate(x.emailedAt.slice(0, 10))}` : 'Not emailed yet'}
                    </p>
                  </div>
                  <Badge tone={TONE[x.status]}>{LABEL[x.status]}</Badge>
                </div>
                {x.activeLink ? (
                  <code className="block rounded bg-subtle px-2 py-1.5 text-xs break-all select-all">{x.activeLink.url}</code>
                ) : null}
                {issued ? (
                  <div className="flex flex-wrap gap-2">
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={paid || !sent}
                        loading={sendingThis}
                        onClick={() => send.mutate(x.seq)}
                      >
                        Send now
                      </Button>
                    ) : null}
                    {x.activeLink ? (
                      <Button size="sm" variant="secondary" onClick={() => void copy(x)}>
                        {copied === x.id ? 'Copied' : 'Copy link'}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
