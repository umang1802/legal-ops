import { zodResolver } from '@hookform/resolvers/zod';
import type { ClientDto, DuplicateCandidate } from '@legalops/types';
import { Alert, Button, SelectField, Sheet, TextAreaField, TextField } from '@legalops/ui';
import { createClientSchema, updateClientSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { api, ApiError, applyFieldErrors } from '../../lib/api.js';

const formSchema = z.object({
  clientType: z.enum(['person', 'company']),
  name: z.string().trim().min(1, { error: 'Enter the client name' }).max(255),
  email: z.string(),
  phone: z.string(),
  alternatePhone: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  gstin: z.string(),
  pan: z.string(),
  notes: z.string(),
  emailNotificationsEnabled: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

const EMPTY: FormValues = {
  clientType: 'person',
  name: '',
  email: '',
  phone: '',
  alternatePhone: '',
  address: '',
  city: '',
  state: '',
  gstin: '',
  pan: '',
  notes: '',
  emailNotificationsEnabled: true,
};

const fromClient = (c: ClientDto): FormValues => ({
  clientType: c.clientType,
  name: c.name,
  email: c.email ?? '',
  phone: c.phone ?? '',
  alternatePhone: c.alternatePhone ?? '',
  address: c.address ?? '',
  city: c.city ?? '',
  state: c.state ?? '',
  gstin: c.gstin ?? '',
  pan: c.pan ?? '',
  notes: c.notes ?? '',
  emailNotificationsEnabled: c.emailNotificationsEnabled,
});

/** Create or edit a client. Duplicates produce a warning the user must consciously override. */
export function ClientFormSheet({
  open,
  onClose,
  client,
  onSaved,
  defaultName,
}: {
  open: boolean;
  onClose: () => void;
  client?: ClientDto;
  onSaved?: (c: ClientDto) => void;
  defaultName?: string;
}) {
  const qc = useQueryClient();
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: EMPTY });

  useEffect(() => {
    if (open) {
      form.reset(client ? fromClient(client) : { ...EMPTY, name: defaultName ?? '' });
      setDuplicates(null);
    }
  }, [open, client, defaultName, form]);

  const save = useMutation({
    mutationFn: async ({ values, acknowledge }: { values: FormValues; acknowledge: boolean }) => {
      if (client) {
        const payload = updateClientSchema.parse(values);
        return api.patch<ClientDto>(`/clients/${client.id}`, payload);
      }
      const payload = createClientSchema.parse({ ...values, acknowledgeDuplicates: acknowledge });
      return api.post<ClientDto>('/clients', payload);
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      qc.setQueryData(['client', c.id], c);
      onSaved?.(c);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'DUPLICATE_WARNING') {
        setDuplicates(err.details as unknown as DuplicateCandidate[]);
        return;
      }
      if (err instanceof z.ZodError) {
        for (const i of err.issues)
          form.setError(i.path.join('.') as keyof FormValues, { message: i.message });
        return;
      }
      applyFieldErrors(err, form.setError);
    },
  });

  const submit = (acknowledge: boolean) =>
    form.handleSubmit((values) => save.mutate({ values, acknowledge }));
  const { errors } = form.formState;
  const isCompany = form.watch('clientType') === 'company';
  const generalError =
    save.error &&
    !(save.error instanceof z.ZodError) &&
    !(
      save.error instanceof ApiError &&
      (save.error.details.length || save.error.code === 'DUPLICATE_WARNING')
    )
      ? save.error
      : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={client ? 'Edit client' : 'New client'}
      footer={
        duplicates ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setDuplicates(null)}>
              Back to form
            </Button>
            <Button loading={save.isPending} onClick={() => void submit(true)()}>
              Create anyway
            </Button>
          </div>
        ) : (
          <Button block type="submit" form="client-form" loading={save.isPending}>
            {client ? 'Save changes' : 'Create client'}
          </Button>
        )
      }
    >
      {duplicates ? (
        <div className="space-y-3">
          <Alert tone="warning" title="This may be an existing client">
            LexForgeX never merges records. Open the existing client, or create a separate record if this is a
            different person or company.
          </Alert>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {duplicates.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <p className="truncate text-xs text-muted">
                    {[d.email, d.phone].filter(Boolean).join(' · ') || 'No contact details'} · matches{' '}
                    {d.matchedOn.join(', ')}
                  </p>
                </div>
                <Link
                  to={`/clients/${d.id}`}
                  onClick={onClose}
                  className="shrink-0 text-sm font-medium text-brand-700 hover:underline"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <form id="client-form" onSubmit={submit(false)} className="space-y-4" noValidate>
          {generalError ? (
            <Alert tone="danger">
              {generalError instanceof ApiError ? generalError.message : 'Could not save the client.'}
            </Alert>
          ) : null}
          <SelectField
            label="Type"
            options={[
              { value: 'person', label: 'Individual' },
              { value: 'company', label: 'Company / organisation' },
            ]}
            {...form.register('clientType')}
          />
          <TextField
            label={isCompany ? 'Company name' : 'Full name'}
            error={errors.name?.message}
            {...form.register('name')}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Email"
              type="email"
              inputMode="email"
              hint="Needed for automatic updates."
              error={errors.email?.message}
              {...form.register('email')}
            />
            <TextField
              label="Phone"
              type="tel"
              inputMode="tel"
              error={errors.phone?.message}
              {...form.register('phone')}
            />
            <TextField
              label="Alternate phone"
              type="tel"
              inputMode="tel"
              error={errors.alternatePhone?.message}
              {...form.register('alternatePhone')}
            />
            <TextField label="City" {...form.register('city')} />
          </div>
          <TextField label="Address" {...form.register('address')} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField label="State" {...form.register('state')} />
            {isCompany ? (
              <TextField
                label="GSTIN"
                autoCapitalize="characters"
                error={errors.gstin?.message}
                {...form.register('gstin')}
              />
            ) : null}
            <TextField
              label="PAN"
              autoCapitalize="characters"
              error={errors.pan?.message}
              {...form.register('pan')}
            />
          </div>
          <TextAreaField label="Notes" {...form.register('notes')} />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-brand-700"
              {...form.register('emailNotificationsEnabled')}
            />
            Send this client automated email updates
          </label>
        </form>
      )}
    </Sheet>
  );
}
