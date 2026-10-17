import type { NotificationDetailDto } from '@legalops/types';
import { Alert, Button, Sheet, TextAreaField } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';

/** "Send client update" (PRD §23): a short note wrapped in the firm's client-update template. */
export function SendUpdateSheet({
  open,
  onClose,
  clientId,
  clientName,
  clientEmail,
  emailsOff,
  matterId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  emailsOff: boolean;
  matterId: string;
  onSent?: (n: NotificationDetailDto) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote('');
  }, [open]);
  const send = useMutation({
    mutationFn: () => api.post<NotificationDetailDto>('/notifications/send-email', { clientId, matterId, customNote: note.trim() }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['matters', matterId] });
      onSent?.(n);
      onClose();
    },
  });
  const blocked = !clientEmail || emailsOff;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Send client update"
      footer={
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button block className="sm:w-auto" disabled={blocked || note.trim().length < 2} loading={send.isPending} onClick={() => send.mutate()}>
            Send
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && note.trim().length >= 2) send.mutate();
        }}
      >
        <p className="text-sm text-ink-soft">
          To <strong>{clientName}</strong>
          {clientEmail ? ` · ${clientEmail}` : ''}
        </p>
        {!clientEmail ? <Alert tone="warning">This client has no email address. Add one on the client’s page first.</Alert> : null}
        {clientEmail && emailsOff ? <Alert tone="warning">This client has email updates turned off.</Alert> : null}
        {send.error ? <Alert tone="danger">{send.error instanceof ApiError ? send.error.message : 'Something went wrong.'}</Alert> : null}
        <TextAreaField
          label="Your update"
          rows={6}
          maxLength={5000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Sent with your firm’s name and the matter details. It is logged on the matter."
          disabled={blocked}
        />
      </form>
    </Sheet>
  );
}
