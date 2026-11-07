import { zodResolver } from '@hookform/resolvers/zod';
import { CLIENT_SALUTATIONS, type ClientDto, type DuplicateCandidate } from '@legalops/types';
import { Alert, Button, SelectField, Sheet, TextAreaField, TextField } from '@legalops/ui';
import { createClientSchema, emailSchema, updateClientSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
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
  salutation: z.string(),
  title: z.string(),
  contactPerson: z.string(),
  ccEmails: z.array(z.string()).max(5),
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
  salutation: '',
  title: '',
  contactPerson: '',
  ccEmails: [],
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
  salutation: c.salutation ?? '',
  title: c.title ?? '',
  contactPerson: c.contactPerson ?? '',
  ccEmails: c.ccEmails,
});

const MAX_CC = 5;

/** Server errors arrive at `ccEmails` or `ccEmails.N`; show whichever is present on the chip field. */
function ccError(e: unknown): string | undefined {
  if (!e) return undefined;
  const x = e as { message?: string; root?: { message?: string } } & Record<string, { message?: string } | undefined>;
  if (x.message) return x.message;
  if (x.root?.message) return x.root.message;
  for (const v of Object.values(x)) if (v && typeof v === 'object' && v.message) return v.message;
  return undefined;
}

/** Chip input: Enter, comma or leaving the field adds an address; the x removes it. */
function CcEmailsField({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string | undefined }) {
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const full = value.length >= MAX_CC;
  /** Adds every address in one pass (a paste can carry several); returns true if all were accepted. */
  const addMany = (raws: string[]): boolean => {
    const next = [...value];
    for (const raw of raws) {
      const email = raw.trim();
      if (!email) continue;
      if (next.length >= MAX_CC) return setLocalError(`Up to ${MAX_CC} CC addresses`), false;
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) return (setLocalError('Enter a valid email address'), onChange(next), false);
      const addr = String(parsed.data);
      if (next.some((v) => v.toLowerCase() === addr.toLowerCase())) return (setLocalError('That address is already added'), onChange(next), false);
      next.push(addr);
    }
    onChange(next);
    setLocalError(null);
    return true;
  };
  const add = (raw: string) => {
    if (addMany([raw])) setDraft('');
  };
  const shown = localError ?? error;
  return (
    <div className="space-y-2">
      <label htmlFor="cc-emails" className="block text-sm font-medium">
        CC emails <span className="font-normal text-muted">({value.length}/{MAX_CC})</span>
      </label>
      {value.length ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((e) => (
            <li key={e} className="flex min-h-8 max-w-full items-center gap-1 rounded-full bg-brand-100 py-1 pl-3 pr-1 text-sm text-brand-800">
              <span className="truncate">{e}</span>
              <button type="button" aria-label={`Remove ${e}`} className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-brand-200" onClick={() => onChange(value.filter((v) => v !== e))}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id="cc-emails"
        type="email"
        inputMode="email"
        autoCapitalize="none"
        disabled={full}
        value={draft}
        placeholder={full ? `Maximum of ${MAX_CC} reached` : 'name@example.com, then Enter'}
        className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm disabled:opacity-60"
        onChange={(e) => {
          const v = e.target.value;
          setLocalError(null);
          if (v.includes(',')) {
            const parts = v.split(',');
            const rest = parts[parts.length - 1] ?? '';
            setDraft(addMany(parts.slice(0, -1)) ? rest : v);
          } else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
      <p className={shown ? 'text-sm text-danger-700' : 'text-xs text-muted'}>{shown ?? 'Copied on invoices and payment emails to this client.'}</p>
    </div>
  );
}

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
      const body = { ...values, salutation: values.salutation === '' ? null : values.salutation };
      if (client) {
        const payload = updateClientSchema.parse(body);
        return api.patch<ClientDto>(`/clients/${client.id}`, payload);
      }
      const payload = createClientSchema.parse({ ...body, acknowledgeDuplicates: acknowledge });
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField
              label="Salutation"
              options={[{ value: '', label: 'None' }, ...CLIENT_SALUTATIONS.map((x) => ({ value: x, label: x }))]}
              error={errors.salutation?.message}
              {...form.register('salutation')}
            />
            <TextField label="Title" hint="e.g. Director" error={errors.title?.message} {...form.register('title')} />
          </div>
          <TextField
            label="Contact person"
            hint="Who invoices are addressed to, if not the client itself."
            error={errors.contactPerson?.message}
            {...form.register('contactPerson')}
          />
          <Controller
            control={form.control}
            name="ccEmails"
            render={({ field }) => (
              <CcEmailsField value={field.value} onChange={field.onChange} error={ccError(errors.ccEmails)} />
            )}
          />
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
