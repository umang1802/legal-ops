import type { InvoiceDetailDto } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';

const MAX_SIGNED_PDF_BYTES = 10 * 1024 * 1024;
const REFRESH = ['invoices', 'invoice', 'billing', 'dashboard', 'matter'];

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

/** Browser → signed PUT straight to storage → the API checks the PDF carries a digital signature. */
async function uploadSigned(invoiceId: string, file: File): Promise<InvoiceDetailDto> {
  if (!(file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name)))) throw new Error('That file isn’t a PDF');
  if (file.size > MAX_SIGNED_PDF_BYTES) throw new Error('Signed PDFs can be up to 10 MB');
  const start = await api.post<{ uploadId: string; url: string }>(`/invoices/${invoiceId}/signed-document/uploads`, {});
  const put = await fetch(start.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
  if (!put.ok) throw new Error('The upload didn’t go through. Check your connection and try again.');
  return api.post<InvoiceDetailDto>(`/invoices/${invoiceId}/signed-document/uploads/${start.uploadId}/complete`, {});
}

/** Download the PDF, attach the firm's digitally signed copy, or remove it. Once attached, only that copy is sent. */
export function SignedDocumentCard({ invoice, canManage }: { invoice: InvoiceDetailDto; canManage: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const upload = useMutation({ mutationFn: (f: File) => uploadSigned(invoice.id, f), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.delete<InvoiceDetailDto>(`/invoices/${invoice.id}/signed-document`),
    onSuccess: () => (setConfirmRemove(false), refresh()),
  });
  const doc = invoice.signedDocument;
  const error = upload.error ?? remove.error;
  const uploader = doc?.uploadedBy ? [doc.uploadedBy.firstName, doc.uploadedBy.lastName].filter(Boolean).join(' ') : null;

  return (
    <Card>
      <CardHeader
        title="Digitally signed copy"
        description="Sign the PDF with your DSC, upload it here, then send. Emails and downloads use that copy."
      />
      <CardBody className="space-y-3 text-sm">
        {error ? <Alert tone="danger">{errText(error, 'Something went wrong.')}</Alert> : null}
        {doc ? (
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="success">Digitally signed</Badge>
            <span className="text-xs text-muted">
              {uploader ? `${uploader} · ` : ''}
              {formatDate(doc.uploadedAt.slice(0, 10))} · {(doc.sizeBytes / 1024).toFixed(0)} KB
            </span>
          </p>
        ) : invoice.revision > 0 ? (
          <p className="text-xs text-muted">This invoice was revised, so any earlier signed copy no longer applies.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <a href={`/api/v1/invoices/${invoice.id}/pdf`} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
              {doc ? 'Download signed PDF' : 'Download PDF'}
            </Button>
          </a>
          {canManage ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<FileUp className="size-4" />}
              loading={upload.isPending}
              onClick={() => (upload.reset(), remove.reset(), input.current?.click())}
            >
              {doc ? 'Replace signed PDF' : 'Upload signed PDF'}
            </Button>
          ) : null}
          {canManage && doc && !confirmRemove ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger-700"
              icon={<Trash2 className="size-4" />}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          ) : null}
          {confirmRemove ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Remove the signed copy?</span>
              <Button size="sm" variant="ghost" className="text-danger-700" loading={remove.isPending} onClick={() => remove.mutate()}>
                Yes, remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </span>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
      </CardBody>
    </Card>
  );
}
