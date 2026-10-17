import {
  PAYMENT_METHOD_LABELS,
  type ClientDto,
  type InvoiceDetailDto,
  type OrganizationDto,
  type PaymentDto,
} from '@legalops/types';
import { Button, Spinner } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { api } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';

/**
 * Print-ready documents (browser "Save as PDF"). Server-side PDF generation and storage is a later
 * step; this keeps V1 honest and dependency-free.
 */
function PrintShell({ title, children, ready }: { title: string; children: ReactNode; ready: boolean }) {
  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-brand-700" />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-canvas py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-3xl justify-end px-4 print:hidden">
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>
      <article
        aria-label={title}
        className="mx-auto max-w-3xl bg-white px-6 py-8 text-sm text-black shadow-sm sm:px-10 print:max-w-none print:shadow-none"
      >
        {children}
      </article>
    </div>
  );
}

function FirmHeader({
  org,
  docTitle,
  number,
}: {
  org: OrganizationDto;
  docTitle: string;
  number: string | null;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-300 pb-4">
      <div>
        <p className="text-lg font-semibold">{org.legalName ?? org.name}</p>
        <p className="text-xs text-gray-600">
          {[org.address, org.city, org.state].filter(Boolean).join(', ')}
        </p>
        <p className="text-xs text-gray-600">{[org.email, org.phone].filter(Boolean).join(' · ')}</p>
        {org.gstin ? <p className="text-xs text-gray-600">GSTIN {org.gstin}</p> : null}
        {org.pan ? <p className="text-xs text-gray-600">PAN {org.pan}</p> : null}
      </div>
      <div className="text-right">
        <p className="text-xl font-semibold tracking-tight">{docTitle}</p>
        <p className="font-mono text-sm">{number}</p>
      </div>
    </header>
  );
}

export function InvoicePrintPage() {
  const { invoiceId = '' } = useParams();
  const inv = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api.get<InvoiceDetailDto>(`/invoices/${invoiceId}`),
  });
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationDto>('/organization'),
  });
  const client = useQuery({
    queryKey: ['client', inv.data?.client.id],
    queryFn: () => api.get<ClientDto>(`/clients/${inv.data!.client.id}`),
    enabled: Boolean(inv.data),
  });
  const i = inv.data;
  const ready = Boolean(i && org.data && client.data);
  const gst = i?.taxMode === 'gst';
  return (
    <PrintShell title="Invoice" ready={ready}>
      {i && org.data && client.data ? (
        <>
          <FirmHeader org={org.data} docTitle={gst ? 'Tax invoice' : 'Invoice'} number={i.invoiceNumber} />
          {i.status === 'void' ? (
            <p className="mt-3 rounded border border-red-600 px-3 py-1 text-center font-semibold text-red-700">
              VOID: {i.voidReason}
            </p>
          ) : null}
          <section className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase">Bill to</p>
              <p className="font-medium">{client.data.name}</p>
              <p className="text-xs text-gray-600">
                {[client.data.address, client.data.city, client.data.state].filter(Boolean).join(', ')}
              </p>
              {i.recipientGstin ? <p className="text-xs text-gray-600">GSTIN {i.recipientGstin}</p> : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:text-right">
              <dt className="text-gray-500">Invoice date</dt>
              <dd>{formatDate(i.issueDate)}</dd>
              <dt className="text-gray-500">Due date</dt>
              <dd>{formatDate(i.dueDate)}</dd>
              <dt className="text-gray-500">Matter</dt>
              <dd>{i.matter.title}</dd>
              {gst ? (
                <>
                  <dt className="text-gray-500">Place of supply</dt>
                  <dd>{i.placeOfSupply}</dd>
                </>
              ) : null}
            </dl>
          </section>
          <table className="mt-6 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-gray-400 text-left">
                <th className="py-2 pr-2">Description</th>
                {gst ? <th className="py-2 pr-2">SAC</th> : null}
                <th className="py-2 pr-2 text-right">Qty</th>
                <th className="py-2 pr-2 text-right">Rate</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {i.items.map((l) => (
                <tr key={l.id} className="border-b border-gray-200 align-top">
                  <td className="py-2 pr-2">
                    {l.description}
                    {l.isPureAgent ? (
                      <span className="block text-gray-500">Reimbursement as pure agent</span>
                    ) : null}
                  </td>
                  {gst ? <td className="py-2 pr-2">{l.sacCode ?? '—'}</td> : null}
                  <td className="py-2 pr-2 text-right">{Number(l.quantity)}</td>
                  <td className="py-2 pr-2 text-right">{formatINR(l.unitPrice)}</td>
                  <td className="py-2 text-right">{formatINR(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 ml-auto w-full max-w-xs space-y-1 text-xs tabular-nums">
            <Row label="Subtotal" value={formatINR(i.subtotal)} />
            {!isZero(i.discountAmount) ? (
              <Row label="Discount" value={`− ${formatINR(i.discountAmount)}`} />
            ) : null}
            {!isZero(i.cgst) ? <Row label="CGST" value={formatINR(i.cgst)} /> : null}
            {!isZero(i.sgst) ? <Row label="SGST" value={formatINR(i.sgst)} /> : null}
            {!isZero(i.igst) ? <Row label="IGST" value={formatINR(i.igst)} /> : null}
            {!gst && !isZero(i.taxAmount) ? <Row label="Tax" value={formatINR(i.taxAmount)} /> : null}
            <Row label="Total" value={formatINR(i.total)} strong />
            {!isZero(i.amountPaid) ? <Row label="Paid" value={formatINR(i.amountPaid)} /> : null}
            {!isZero(i.amountCredited) ? <Row label="Credited" value={formatINR(i.amountCredited)} /> : null}
            <Row label="Balance due" value={formatINR(i.amountDue)} strong />
          </dl>
          {i.isReverseCharge ? (
            <p className="mt-4 text-xs">
              Tax payable on reverse charge basis: Yes. GST of {formatINR(i.rcmTax)} is payable by the
              recipient.
            </p>
          ) : null}
          {i.notes ? <p className="mt-4 text-xs whitespace-pre-wrap">{i.notes}</p> : null}
          <p className="mt-8 text-xs text-gray-500">This is a computer-generated invoice.</p>
        </>
      ) : null}
    </PrintShell>
  );
}

export function ReceiptPrintPage() {
  const { paymentId = '' } = useParams();
  const p = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => api.get<PaymentDto>(`/payments/${paymentId}`),
  });
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationDto>('/organization'),
  });
  const pay = p.data;
  return (
    <PrintShell title="Receipt" ready={Boolean(pay && org.data)}>
      {pay && org.data ? (
        <>
          <FirmHeader org={org.data} docTitle="Receipt" number={pay.receiptNumber} />
          {pay.status === 'reversed' ? (
            <p className="mt-3 rounded border border-red-600 px-3 py-1 text-center font-semibold text-red-700">
              REVERSED: {pay.reversalReason}
            </p>
          ) : null}
          <p className="mt-6">
            Received with thanks from <strong>{pay.client.name}</strong> the sum of{' '}
            <strong>{formatINR(pay.amount)}</strong> by {PAYMENT_METHOD_LABELS[pay.method]}
            {pay.referenceNumber ? ` (ref. ${pay.referenceNumber})` : ''} on {formatDate(pay.paymentDate)}.
          </p>
          {!isZero(pay.tdsAmount) ? (
            <p className="mt-2">
              Tax deducted at source: {formatINR(pay.tdsAmount)}. Total settled: {formatINR(pay.settlement)}.
            </p>
          ) : null}
          {pay.allocations.filter((a) => a.active).length ? (
            <table className="mt-6 w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-gray-400 text-left">
                  <th className="py-2">Applied to invoice</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pay.allocations
                  .filter((a) => a.active)
                  .map((a) => (
                    <tr key={a.id} className="border-b border-gray-200">
                      <td className="py-2">{a.invoiceNumber}</td>
                      <td className="py-2 text-right">{formatINR(a.amount)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : null}
          {!isZero(pay.unallocated) ? (
            <p className="mt-3 text-xs">Held as advance: {formatINR(pay.unallocated)}</p>
          ) : null}
          <p className="mt-10 text-xs text-gray-500">This is a computer-generated receipt.</p>
        </>
      ) : null}
    </PrintShell>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between gap-4 ${strong ? 'border-t border-gray-300 pt-1 font-semibold' : ''}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
