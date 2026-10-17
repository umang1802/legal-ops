import type { PlatformFirmDetail } from '@legalops/types';
import { inviteFirmSchema } from '@legalops/validation';
import { Alert, Button, Sheet, TextField } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../lib/api.js';
import { platformApi } from './api.js';

export function InviteFirmSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firmName: '', partnerName: '', partnerEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invite = useMutation({
    mutationFn: (body: typeof form) => platformApi.post<PlatformFirmDetail>('/firms', body),
    onSuccess: (firm) => {
      void qc.invalidateQueries({ queryKey: ['platform', 'firms'] });
      onClose();
      navigate(`/platform/firms/${firm.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const parsed = inviteFirmSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    invite.mutate(parsed.data);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Sheet open={open} onClose={onClose} title="Invite a firm">
      <form className="space-y-4" onSubmit={submit}>
        {invite.error instanceof ApiError ? <Alert tone="danger">{invite.error.message}</Alert> : null}
        <TextField
          label="Firm name"
          value={form.firmName}
          onChange={set('firmName')}
          error={errors.firmName}
        />
        <TextField
          label="Managing partner’s name"
          value={form.partnerName}
          onChange={set('partnerName')}
          error={errors.partnerName}
        />
        <TextField
          label="Partner’s email"
          type="email"
          value={form.partnerEmail}
          onChange={set('partnerEmail')}
          error={errors.partnerEmail}
        />
        <p className="text-sm text-muted">
          They get a set-up link valid for 7 days. Only invite firms that have paid.
        </p>
        <Button type="submit" className="w-full" disabled={invite.isPending}>
          Send invitation
        </Button>
      </form>
    </Sheet>
  );
}
