import { PAYMENT_METHOD_LABELS, type OrganizationDto, type PaymentDto, type WireDocModel } from '@legalops/types';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { FirmLogo } from '../../components/branding/FirmLogo.js';
import { PrintShell } from '../../components/print/PrintShell.js';
import { InvoiceDocument } from './InvoiceDocument.js';

function FirmHeader({
  org,
  docTitle,
  number,
  gstin,
  revisionLine,
}: {
  org: OrganizationDto;
  docTitle: string;
  number: string | null;
  /** The GSTIN printed on the document. Invoices pass their issue-time snapshot; defaults to the firm's current one. */
  gstin?: string | null | undefined;
  revisionLine?: string | null | undefined;
}) {
  const shownGstin = gstin === undefined ? org.gstin : gstin;
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-300 pb-4">
      <div>
        <FirmLogo name={org.legalName ?? org.name} logoUrl={org.logoUrl} className="mb-2 max-h-14 max-w-56" />
        <p className="text-lg font-semibold">{org.legalName ?? org.name}</p>
        <p className="text-xs text-gray-600">
          {[org.address, org.city, org.state, org.pincode].filter(Boolean).join(', ')}
        </p>
        <p className="text-xs text-gray-600">{[org.email, org.phone].filter(Boolean).join(' · ')}</p>
        {shownGstin ? <p className="text-xs text-gray-600">GSTIN {shownGstin}</p> : null}
        {org.registrationLabel && org.registrationValue ? (
          <p className="text-xs text-gray-600">
            {org.registrationLabel} {org.registrationValue}
          </p>
        ) : null}
        {org.pan ? <p className="text-xs text-gray-600">PAN {org.pan}</p> : null}
      </div>
      <div className="text-right">
        <p className="text-xl font-semibold tracking-tight">{docTitle}</p>
        <p className="font-mono text-sm">{number}</p>
        {revisionLine ? <p className="text-xs text-gray-600">{revisionLine}</p> : null}
      </div>
    </header>
  );
}

/** The invoice, drawn from the same document the PDF is made from, in the firm's own format. */
export function InvoicePrintPage() {
  const { invoiceId = '' } = useParams();
  const doc = useQuery({
    queryKey: ['invoice-document', invoiceId],
    queryFn: () => api.get<WireDocModel>(`/invoices/${invoiceId}/document`),
  });
  return (
    <PrintShell title="Invoice" ready={Boolean(doc.data)} bare pdfHref={`/api/v1/invoices/${invoiceId}/pdf`}>
      {doc.data ? <InvoiceDocument model={doc.data} forPrint /> : null}
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
          <p className="mt-10 text-xs text-gray-500">This is a computer-generated receipt. Powered by LexForgeX.</p>
        </>
      ) : null}
    </PrintShell>
  );
}
