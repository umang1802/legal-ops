import { zodResolver } from '@hookform/resolvers/zod';
import { CASE_STATUSES, CASE_STATUS_LABELS, type CaseDetailDto } from '@legalops/types';
import { Alert, Button, SelectField, Sheet, TextField, type ComboOption } from '@legalops/ui';
import { createCaseSchema, updateCaseSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, applyFieldErrors } from '../../lib/api.js';
import { CourtPicker } from '../matters/pickers.js';

const formSchema = z.object({
  title: z.string().trim().min(1, { error: 'Enter the case title' }).max(255),
  caseNumber: z.string(),
  cnr: z.string(),
  caseType: z.string(),
  status: z.enum(CASE_STATUSES),
  filingDate: z.string(),
  registrationDate: z.string(),
  judgeBench: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

export function CaseFormSheet({
  open,
  onClose,
  matterId,
  existing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  matterId: string;
  existing?: CaseDetailDto;
  onSaved?: (c: CaseDetailDto) => void;
}) {
  const qc = useQueryClient();
  const [court, setCourt] = useState<ComboOption | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  useEffect(() => {
    if (!open) return;
    form.reset({
      title: existing?.title ?? '',
      caseNumber: existing?.caseNumber ?? '',
      cnr: existing?.cnr ?? '',
      caseType: existing?.caseType ?? '',
      status: existing?.status ?? 'active',
      filingDate: existing?.filingDate ?? '',
      registrationDate: existing?.registrationDate ?? '',
      judgeBench: existing?.judgeBench ?? '',
    });
    setCourt(existing?.court ? { value: existing.court.id, label: existing.court.name } : null);
  }, [open, existing, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = { ...v, courtId: court?.value ?? null };
      return existing
        ? api.patch<CaseDetailDto>(`/cases/${existing.id}`, updateCaseSchema.parse(body))
        : api.post<CaseDetailDto>('/cases', createCaseSchema.parse({ ...body, matterId }));
    },
    onSuccess: (c) => {
      qc.setQueryData(['case', c.id], c);
      void qc.invalidateQueries({ queryKey: ['matter', matterId] });
      void qc.invalidateQueries({ queryKey: ['matters'] });
      onSaved?.(c);
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
  const generalError =
    save.error &&
    !(save.error instanceof z.ZodError) &&
    !(save.error instanceof ApiError && save.error.details.length > 0 && save.error.status === 422)
      ? save.error
      : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? 'Edit case' : 'Add case'}
      footer={
        <Button block type="submit" form="case-form" loading={save.isPending}>
          {existing ? 'Save changes' : 'Add case'}
        </Button>
      }
    >
      <form
        id="case-form"
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="space-y-4"
        noValidate
      >
        {generalError ? (
          <Alert tone="danger">
            {generalError instanceof ApiError && generalError.status === 409
              ? 'Another case in your firm already uses this CNR.'
              : generalError instanceof ApiError
                ? generalError.message
                : 'Could not save the case.'}
          </Alert>
        ) : null}
        <TextField
          label="Case title"
          placeholder="e.g. Raj Sharma v ABC Industries"
          error={errors.title?.message}
          {...form.register('title')}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Case number"
            placeholder="e.g. CS(OS) 412/2026"
            {...form.register('caseNumber')}
          />
          <TextField
            label="CNR"
            autoCapitalize="characters"
            error={errors.cnr?.message}
            {...form.register('cnr')}
          />
        </div>
        <CourtPicker value={court} onChange={setCourt} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Case type" {...form.register('caseType')} />
          <SelectField
            label="Status"
            options={CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_LABELS[s] }))}
            {...form.register('status')}
          />
          <TextField
            label="Filing date"
            type="date"
            error={errors.filingDate?.message}
            {...form.register('filingDate')}
          />
          <TextField
            label="Registration date"
            type="date"
            error={errors.registrationDate?.message}
            {...form.register('registrationDate')}
          />
        </div>
        <TextField label="Judge / bench" {...form.register('judgeBench')} />
      </form>
    </Sheet>
  );
}
