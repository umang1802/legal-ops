import { zodResolver } from '@hookform/resolvers/zod';
import { HEARING_TYPES, type CaseListItemDto, type HearingDto } from '@legalops/types';
import { Alert, Button, Combobox, Sheet, TextAreaField, TextField, type ComboOption } from '@legalops/ui';
import { createHearingSchema, updateHearingSchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, applyFieldErrors, qs } from '../../lib/api.js';
import { useDebounced } from '../../lib/hooks.js';
import { invalidateWork } from '../../lib/invalidate.js';

const formSchema = z.object({
  scheduledDate: z.string().min(1, { error: 'Pick the hearing date' }),
  startTime: z.string(),
  endTime: z.string(),
  courtroom: z.string(),
  benchJudge: z.string(),
  hearingType: z.string(),
  notes: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

export function CasePicker({
  value,
  onChange,
  matterId,
  error,
}: {
  value: ComboOption | null;
  onChange: (o: ComboOption | null) => void;
  matterId?: string | undefined;
  error?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query);
  const cases = useQuery({
    queryKey: ['cases', 'picker', q, matterId],
    queryFn: () => api.get<CaseListItemDto[]>(`/cases${qs({ search: q, matterId })}`),
  });
  return (
    <Combobox
      label="Case"
      placeholder="Case number, CNR, matter or client"
      value={value}
      onChange={onChange}
      onQueryChange={setQuery}
      loading={cases.isFetching}
      error={error}
      emptyText="No open case matches"
      options={(cases.data ?? []).map((c) => ({
        value: c.id,
        label: c.caseNumber ?? c.title,
        description: [c.matter.title, c.clientName, c.court?.name].filter(Boolean).join(' · '),
      }))}
    />
  );
}

/**
 * Schedule (or edit) a hearing. Pass `fixedCase` when the case is known (matter/case pages);
 * otherwise the user picks one.
 */
export function HearingFormSheet({
  open,
  onClose,
  existing,
  fixedCase,
  defaultDate,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  existing?: HearingDto;
  fixedCase?: ComboOption;
  defaultDate?: string;
  onSaved?: (h: HearingDto) => void;
}) {
  const qc = useQueryClient();
  const [kase, setKase] = useState<ComboOption | null>(null);
  const [caseError, setCaseError] = useState<string>();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  useEffect(() => {
    if (!open) return;
    form.reset({
      scheduledDate: existing?.scheduledDate ?? defaultDate ?? '',
      startTime: existing?.startTime ?? '',
      endTime: existing?.endTime ?? '',
      courtroom: existing?.courtroom ?? '',
      benchJudge: existing?.benchJudge ?? '',
      hearingType: existing?.hearingType ?? '',
      notes: existing?.notes ?? '',
    });
    setKase(
      fixedCase ??
        (existing ? { value: existing.caseId, label: existing.caseNumber ?? existing.caseTitle } : null),
    );
    setCaseError(undefined);
  }, [open, existing, fixedCase, defaultDate, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      existing
        ? api.patch<HearingDto>(`/hearings/${existing.id}`, updateHearingSchema.parse(v))
        : api.post<HearingDto>('/hearings', createHearingSchema.parse({ ...v, caseId: kase?.value })),
    onSuccess: (h) => {
      invalidateWork(qc);
      onSaved?.(h);
      onClose();
    },
    onError: (err) => {
      if (err instanceof z.ZodError) {
        for (const i of err.issues)
          form.setError(i.path.join('.') as keyof FormValues, { message: i.message });
      } else applyFieldErrors(err, form.setError);
    },
  });
  const { errors } = form.formState;
  const submit = form.handleSubmit((v) => {
    if (!existing && !kase) {
      setCaseError('Choose the case');
      return;
    }
    save.mutate(v);
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? 'Edit hearing' : 'Schedule hearing'}
      footer={
        <Button block type="submit" form="hearing-form" loading={save.isPending}>
          {existing ? 'Save changes' : 'Schedule hearing'}
        </Button>
      }
    >
      <form id="hearing-form" onSubmit={submit} className="space-y-4" noValidate>
        {save.error instanceof ApiError && save.error.details.length === 0 ? (
          <Alert tone="danger">{save.error.message}</Alert>
        ) : null}
        {existing || fixedCase ? (
          <div className="rounded-lg bg-subtle px-3 py-2 text-sm">
            <span className="text-muted">Case: </span>
            <span className="font-medium">{kase?.label}</span>
          </div>
        ) : (
          <CasePicker
            value={kase}
            onChange={(o) => {
              setKase(o);
              setCaseError(undefined);
            }}
            error={caseError}
          />
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label="Date"
            type="date"
            error={errors.scheduledDate?.message}
            {...form.register('scheduledDate')}
          />
          <TextField
            label="Start time"
            type="time"
            error={errors.startTime?.message}
            {...form.register('startTime')}
          />
          <TextField
            label="End time"
            type="time"
            error={errors.endTime?.message}
            {...form.register('endTime')}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Court room" placeholder="e.g. 12" {...form.register('courtroom')} />
          <TextField
            label="Hearing type"
            list="hearing-types"
            placeholder="e.g. Arguments"
            {...form.register('hearingType')}
          />
        </div>
        <datalist id="hearing-types">
          {HEARING_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <TextField label="Judge / bench" {...form.register('benchJudge')} />
        <TextAreaField label="Notes" hint="Internal. Not shown to the client." {...form.register('notes')} />
      </form>
    </Sheet>
  );
}
