import { zodResolver } from '@hookform/resolvers/zod';
import type { OrganizationDto } from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  SelectField,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { updateOrganizationSchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, applyFieldErrors } from '../../lib/api.js';
import { hasFeature, ME_KEY, useSession } from '../../lib/auth.js';

// Form works on strings; empty string = "clear this field" (sent as null).
const formSchema = z.object({
  name: z.string().trim().min(1, { error: 'Firm name is required' }).max(200),
  legalName: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z
    .string()
    .refine((v) => v.trim() === '' || /^[1-9][0-9]{5}$/.test(v.trim()), { error: 'Use the 6-digit PIN code' }),
  stateCode: z.string(),
  timezone: z.string().min(1),
  remindersEnabled: z.boolean(),
  calendarHideParties: z.boolean(),
  invoicePrefix: z.string(),
  taxMode: z.enum(['simple', 'gst']),
  gstin: z.string(),
  pan: z.string(),
  defaultSendTime: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

const toForm = (o: OrganizationDto): FormValues => ({
  name: o.name,
  legalName: o.legalName ?? '',
  email: o.email ?? '',
  phone: o.phone ?? '',
  address: o.address ?? '',
  city: o.city ?? '',
  state: o.state ?? '',
  pincode: o.pincode ?? '',
  stateCode: o.stateCode ?? '',
  timezone: o.timezone,
  remindersEnabled: o.remindersEnabled,
  calendarHideParties: o.calendarHideParties,
  invoicePrefix: o.invoicePrefix,
  taxMode: o.taxMode,
  gstin: o.gstin ?? '',
  pan: o.pan ?? '',
  defaultSendTime: o.defaultSendTime,
});

const NULLABLE = [
  'legalName',
  'email',
  'phone',
  'address',
  'city',
  'state',
  'pincode',
  'stateCode',
  'gstin',
  'pan',
] as const;

function toPayload(v: FormValues) {
  const out: Record<string, unknown> = { ...v };
  for (const k of NULLABLE) out[k] = v[k].trim() === '' ? null : v[k];
  return updateOrganizationSchema.parse(out);
}

export function FirmSettingsPage() {
  const qc = useQueryClient();
  const me = useSession();
  const org = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationDto>('/organization'),
  });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema) });
  const save = useMutation({
    mutationFn: (v: FormValues) => api.patch<OrganizationDto>('/organization', toPayload(v)),
    onSuccess: (o) => {
      qc.setQueryData(['organization'], o);
      void qc.invalidateQueries({ queryKey: ME_KEY });
      form.reset(toForm(o));
    },
    onError: (err) => applyFieldErrors(err, form.setError),
  });

  useEffect(() => {
    if (org.data) form.reset(toForm(org.data));
  }, [org.data, form]);

  const taxMode = form.watch('taxMode');
  const { errors, isDirty } = form.formState;

  if (org.isPending) return <SkeletonList rows={6} />;
  if (org.isError) return <Alert tone="danger">Couldn’t load firm settings. Refresh to try again.</Alert>;

  const submit = form.handleSubmit((v) => {
    try {
      save.mutate(v);
    } catch (err) {
      if (err instanceof z.ZodError) {
        for (const i of err.issues)
          form.setError(i.path.join('.') as keyof FormValues, { message: i.message });
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4 pb-20 sm:pb-0">
      <PageHeader title="Firm settings" description="Shown on invoices, receipts and client emails." />
      {save.isSuccess && !isDirty ? <Alert tone="success">Settings saved.</Alert> : null}
      {save.error && !(save.error instanceof ApiError && save.error.details.length) ? (
        <Alert tone="danger">{save.error instanceof ApiError ? save.error.message : 'Could not save.'}</Alert>
      ) : null}

      <Card>
        <CardHeader title="Firm profile" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Firm name" error={errors.name?.message} {...form.register('name')} />
          <TextField label="Legal name" {...form.register('legalName')} />
          <TextField
            label="Office email"
            type="email"
            inputMode="email"
            error={errors.email?.message}
            {...form.register('email')}
          />
          <TextField label="Phone" type="tel" inputMode="tel" {...form.register('phone')} />
          <div className="sm:col-span-2">
            <TextField label="Address" {...form.register('address')} />
          </div>
          <TextField label="City" {...form.register('city')} />
          <TextField label="State" {...form.register('state')} />
          <TextField
            label="PIN code"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            hint="6 digits, e.g. 110001"
            error={errors.pincode?.message}
            {...form.register('pincode')}
          />
        </CardBody>
      </Card>

      {/* Hidden (but still submitted unchanged) when the firm doesn't have Billing. */}
      <Card className={hasFeature(me, 'billing') ? undefined : 'hidden'}>
        <CardHeader
          title="Billing & tax"
          description="How invoices calculate tax. Existing invoices keep the mode they were issued with."
        />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Tax mode"
            options={[
              { value: 'simple', label: 'Simple: enter tax as one amount' },
              { value: 'gst', label: 'GST: CGST/SGST/IGST, reverse charge' },
            ]}
            {...form.register('taxMode')}
          />
          <TextField
            label="Invoice prefix"
            hint="e.g. LGL → LGL/2026-27/000001"
            error={errors.invoicePrefix?.message}
            {...form.register('invoicePrefix', { setValueAs: (v: string) => v.toUpperCase() })}
          />
          <TextField
            label={taxMode === 'gst' ? 'GSTIN (required)' : 'GSTIN'}
            autoCapitalize="characters"
            error={errors.gstin?.message}
            {...form.register('gstin')}
          />
          <TextField
            label={taxMode === 'gst' ? 'GST state code (required)' : 'GST state code'}
            inputMode="numeric"
            hint="2 digits, e.g. 07 for Delhi"
            error={errors.stateCode?.message}
            {...form.register('stateCode')}
          />
          <TextField
            label="PAN"
            autoCapitalize="characters"
            error={errors.pan?.message}
            {...form.register('pan')}
          />
          {taxMode === 'gst' ? (
            <div className="sm:col-span-2">
              <Alert tone="warning" title="Confirm GST treatment with your CA">
                Reverse-charge applicability and rates for legal services depend on your clients. LexForgeX
                applies what you configure; it does not give tax advice.
              </Alert>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reminders" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex items-start gap-3 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4" {...form.register('remindersEnabled')} />
            <span>
              <span className="font-medium">Send reminders</span>
              <span className="block text-muted">
                Hearing and payment-due reminders to your team and clients. Turn this off to stop all of them at
                once; reminders that fall due while it is off are skipped, not sent later. Other emails
                (invitations, invoices, receipts, task assignments) are not affected.
              </span>
            </span>
          </label>
          {/* Hidden (but still submitted unchanged) when the firm doesn't have Calendar sync. */}
          <label className={`flex items-start gap-3 text-sm sm:col-span-2 ${hasFeature(me, 'calendar_sync') ? '' : 'hidden'}`}>
            <input type="checkbox" className="mt-0.5 size-4" {...form.register('calendarHideParties')} />
            <span>
              <span className="font-medium">Hide parties in synced calendars</span>
              <span className="block text-muted">
                Calendar sync copies hearings into each person’s Google, Outlook or Apple calendar. With this on, events show only
                the case number and court, never parties, client or matter names.
              </span>
            </span>
          </label>
          <TextField label="Timezone" error={errors.timezone?.message} {...form.register('timezone')} />
          <TextField
            label="Default reminder send time"
            type="time"
            hint="Used for “1 day before hearing” style reminders."
            error={errors.defaultSendTime?.message}
            {...form.register('defaultSendTime')}
          />
        </CardBody>
      </Card>

      {/* Sticky save bar on mobile (PRD §18: sticky primary actions) */}
      <div className="fixed inset-x-0 bottom-16 z-10 border-t border-line bg-surface p-3 sm:static sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-0">
        <Button type="submit" block className="sm:w-auto" loading={save.isPending} disabled={!isDirty}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
