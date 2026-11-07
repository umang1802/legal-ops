import type { InvoiceDetailDto, OrganizationDto } from '@legalops/types';
import { Alert, Button, SelectField, Sheet } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { useMembers } from '../../lib/hooks.js';

const REFRESH = ['invoices', 'invoice', 'payments', 'billing', 'dashboard', 'matter', 'expenses', 'fee-agreements'];

/** Issue a draft: pick who signs, whether to print their scanned signature, and whether to email the client now. */
export function IssueSheet({
  open,
  onClose,
  invoice,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  invoice: InvoiceDetailDto;
  /** Called after a successful issue instead of closing (the editor navigates away). */
  onIssued?: (inv: InvoiceDetailDto) => void;
}) {
  const me = useSession();
  const qc = useQueryClient();
  const members = useMembers();
  const org = useQuery({ queryKey: ['organization'], queryFn: () => api.get<OrganizationDto>('/organization') });
  const firmName = org.data?.legalName ?? org.data?.name ?? me.organization.name;
  const active = useMemo(() => (members.data ?? []).filter((m) => m.status === 'active'), [members.data]);
  const [userId, setUserId] = useState('');
  const [withImage, setWithImage] = useState(false);
  const [sendLater, setSendLater] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWithImage(false);
    setSendLater(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Default: the person issuing, if they are listed.
    setUserId((cur) => cur || (active.find((m) => m.userId === me.user.id) ?? active[0])?.userId || '');
  }, [open, active, me.user.id]);

  const picked = active.find((m) => m.userId === userId);
  const canImage = Boolean(picked?.hasSignature);
  useEffect(() => {
    if (!canImage) setWithImage(false);
  }, [canImage]);

  const issue = useMutation({
    mutationFn: () =>
      api.post<InvoiceDetailDto>(`/invoices/${invoice.id}/issue`, {
        sendToClient: !sendLater,
        ...(userId ? { signatoryUserId: userId } : {}),
        signWithImage: withImage && canImage,
      }),
    onSuccess: (inv) => {
      REFRESH.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
      if (onIssued) onIssued(inv);
      else onClose();
    },
  });

  const { reset } = issue;
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Issue invoice"
      footer={
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button block className="sm:w-auto" loading={issue.isPending} onClick={() => issue.mutate()}>
            {sendLater ? 'Issue, send later' : 'Issue and send'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        {issue.error ? (
          <Alert tone="danger">{issue.error instanceof ApiError ? issue.error.message : 'Could not issue.'}</Alert>
        ) : null}
        <SelectField
          label="Signatory"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          options={active.map((m) => ({
            value: m.userId,
            label: `${m.firstName}${m.lastName ? ` ${m.lastName}` : ''} · ${m.designation}`,
          }))}
          hint={`Printed in the “For ${firmName}” block.`}
        />
        <label className={`flex min-h-11 items-start gap-2 ${canImage ? '' : 'text-muted'}`}>
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand-700"
            checked={withImage}
            disabled={!canImage}
            onChange={(e) => setWithImage(e.target.checked)}
          />
          <span>
            Print scanned signature
            {!canImage && picked ? (
              <span className="block text-xs">
                {picked.firstName} hasn’t uploaded a signature yet (Settings → Team).
              </span>
            ) : null}
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand-700"
            checked={sendLater}
            onChange={(e) => setSendLater(e.target.checked)}
          />
          <span>
            Issue now, send later
            <span className="block text-xs text-muted">
              The invoice is numbered but not emailed. Use “Send invoice” when you’re ready, for example after
              uploading a digitally signed copy.
            </span>
          </span>
        </label>
      </div>
    </Sheet>
  );
}
