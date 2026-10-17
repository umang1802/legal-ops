import type { HearingDto } from '@legalops/types';
import { Alert, Button, cn, SelectField, Sheet, TextAreaField, TextField } from '@legalops/ui';
import { completeHearingSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { formatDate, fullName } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { invalidateWork } from '../../lib/invalidate.js';

type Action = { title: string; assigneeId: string; dueDate: string };

/**
 * Journey C, built for a phone in a court corridor: outcome, next date, follow-ups. One tap to save.
 * Everything (next hearing, tasks, timeline, events) is created in a single server transaction.
 */
export function CompleteHearingSheet({
  open,
  onClose,
  hearing,
}: {
  open: boolean;
  onClose: () => void;
  hearing: HearingDto;
}) {
  const qc = useQueryClient();
  const members = useMembers();
  const [result, setResult] = useState<'adjourned' | 'completed'>('adjourned');
  const [outcome, setOutcome] = useState('');
  const [clientSummary, setClientSummary] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [nextTime, setNextTime] = useState('');
  const [actions, setActions] = useState<Action[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setResult('adjourned');
    setOutcome('');
    setClientSummary('');
    setNextDate('');
    setNextTime('');
    setActions([]);
    setErrors({});
  }, [open]);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api.post<{ hearing: HearingDto; nextHearing: HearingDto | null; taskIds: string[] }>(
        `/hearings/${hearing.id}/complete`,
        body,
      ),
    onSuccess: () => {
      invalidateWork(qc);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        const map: Record<string, string> = {};
        for (const d of err.details) if (d.path && d.message) map[d.path] = d.message;
        setErrors(map);
      }
    },
  });

  const submit = () => {
    const parsed = completeHearingSchema.safeParse({
      result,
      outcome,
      clientSummary: clientSummary || null,
      nextHearingDate: nextDate || null,
      nextStartTime: nextTime || null,
      nextActions: actions
        .filter((a) => a.title.trim())
        .map((a) => ({ title: a.title, assigneeId: a.assigneeId || null, dueDate: a.dueDate || null })),
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    if (result === 'adjourned' && !nextDate) {
      setErrors({ nextHearingDate: 'An adjourned hearing needs the next date (or choose “Heard”)' });
      return;
    }
    save.mutate(parsed.data);
  };

  const people = (members.data ?? []).filter((m) => m.status === 'active');
  const generalError =
    save.error instanceof ApiError && save.error.details.length === 0 ? save.error.message : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record outcome"
      footer={
        <Button block onClick={submit} loading={save.isPending}>
          Save outcome
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {hearing.caseNumber ?? hearing.caseTitle} · {formatDate(hearing.scheduledDate)}
        </p>
        {generalError ? <Alert tone="danger">{generalError}</Alert> : null}
        {errors.result ? <Alert tone="danger">{errors.result}</Alert> : null}

        <div role="radiogroup" aria-label="What happened" className="grid grid-cols-2 gap-2">
          {(
            [
              ['adjourned', 'Adjourned', 'Next date given'],
              ['completed', 'Heard', 'Matter was taken up'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={result === value}
              onClick={() => setResult(value)}
              className={cn(
                'rounded-xl border px-3 py-3 text-left',
                result === value
                  ? 'border-brand-700 bg-brand-50 ring-1 ring-brand-700'
                  : 'border-line bg-surface',
              )}
            >
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>

        <TextAreaField
          label="Internal note (team only)"
          hint="Never sent to the client."
          placeholder={
            result === 'adjourned'
              ? 'e.g. Respondent sought time; judge unconvinced on limitation'
              : 'e.g. Arguments heard, orders reserved'
          }
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          error={errors.outcome}
        />
        <TextAreaField
          label="Update for client (optional)"
          hint="Goes in the client's case-update email (sent when you give a next date) and their next hearing reminder. Leave blank for a neutral line."
          placeholder="e.g. The court gave the other side time to file a reply."
          maxLength={2000}
          value={clientSummary}
          onChange={(e) => setClientSummary(e.target.value)}
          error={errors.clientSummary}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Next date"
            type="date"
            value={nextDate}
            onChange={(e) => setNextDate(e.target.value)}
            error={errors.nextHearingDate}
          />
          <TextField
            label="Time"
            type="time"
            value={nextTime}
            onChange={(e) => setNextTime(e.target.value)}
          />
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Next actions</legend>
          {actions.map((a, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    label={`Task ${i + 1}`}
                    placeholder="e.g. Prepare written submissions"
                    value={a.title}
                    onChange={(e) =>
                      setActions((xs) => xs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                    }
                    error={errors[`nextActions.${i}.title`]}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Remove task ${i + 1}`}
                  onClick={() => setActions((xs) => xs.filter((_, j) => j !== i))}
                  className="mt-7 grid size-10 place-items-center rounded-lg text-muted hover:bg-subtle"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <SelectField
                  label="For"
                  value={a.assigneeId}
                  onChange={(e) =>
                    setActions((xs) => xs.map((x, j) => (j === i ? { ...x, assigneeId: e.target.value } : x)))
                  }
                  options={[
                    { value: '', label: hearing.lead ? `Lead (${fullName(hearing.lead)})` : 'Me' },
                    ...people.map((p) => ({ value: p.userId, label: fullName(p) })),
                  ]}
                />
                <TextField
                  label="Due"
                  type="date"
                  value={a.dueDate}
                  onChange={(e) =>
                    setActions((xs) => xs.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))
                  }
                />
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-4" />}
            onClick={() => setActions((xs) => [...xs, { title: '', assigneeId: '', dueDate: '' }])}
            disabled={actions.length >= 10}
          >
            Add next action
          </Button>
        </fieldset>
      </div>
    </Sheet>
  );
}

export function CancelHearingSheet({
  open,
  onClose,
  hearing,
}: {
  open: boolean;
  onClose: () => void;
  hearing: HearingDto;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const cancel = useMutation({
    mutationFn: () => api.post<HearingDto>(`/hearings/${hearing.id}/cancel`, { reason }),
    onSuccess: () => {
      invalidateWork(qc);
      onClose();
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Cancel hearing?"
      footer={
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            block
            className="sm:w-auto"
            disabled={!reason.trim()}
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel hearing
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">
          Use this when the listing was dropped or entered by mistake. If the court gave a new date, record
          the outcome as “Adjourned” instead.
        </p>
        {cancel.error ? (
          <Alert tone="danger">
            {cancel.error instanceof ApiError ? cancel.error.message : 'Could not cancel.'}
          </Alert>
        ) : null}
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}
