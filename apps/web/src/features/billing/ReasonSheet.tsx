import { Alert, Button, Sheet, TextAreaField } from '@legalops/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/api.js';

/** Confirmation that requires a written reason (void, write-off, reversal). Destructive by design. */
export function ReasonSheet({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  pending: boolean;
  error: unknown;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            block
            className="sm:w-auto"
            disabled={reason.trim().length < 3}
            loading={pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="text-sm text-ink-soft">{description}</div>
        {error ? (
          <Alert tone="danger">{error instanceof ApiError ? error.message : 'Something went wrong.'}</Alert>
        ) : null}
        <TextAreaField
          label="Reason (kept in the audit trail)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </Sheet>
  );
}
