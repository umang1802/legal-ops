import { zodResolver } from '@hookform/resolvers/zod';
import {
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  MATTER_STATUSES,
  MATTER_STATUS_LABELS,
  PRACTICE_AREAS,
  PRIORITIES,
  PRIORITY_LABELS,
  type ClientDto,
  type MatterDetailDto,
} from '@legalops/types';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  type ComboOption,
} from '@legalops/ui';
import { createMatterSchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { api, ApiError } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { fullName } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { ClientPicker, CourtPicker } from './pickers.js';

const formSchema = z.object({
  title: z.string().trim().min(1, { error: 'Enter the matter title' }).max(255),
  referenceCode: z.string(),
  practiceArea: z.string(),
  status: z.enum(MATTER_STATUSES),
  priority: z.enum(PRIORITIES),
  startDate: z.string(),
  clientSummary: z.string(),
  internalNotes: z.string(),
  leadUserId: z.string(),
  addCase: z.boolean(),
  caseTitle: z.string(),
  caseNumber: z.string(),
  cnr: z.string(),
  caseType: z.string(),
  caseStatus: z.enum(CASE_STATUSES),
  filingDate: z.string(),
  judgeBench: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

/** Journey A (PRD §5): client → matter → team → first case, saved in one transaction. */
export function NewMatterPage() {
  const me = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const presetClientId = params.get('clientId');
  const members = useMembers();
  // Pilot finding (2026-10-03): owners creating matters left them with no lead. Anyone eligible to
  // lead defaults to leading what they create; "Choose later" stays available.
  const canLeadSelf = me.role === 'owner' || me.role === 'admin' || me.role === 'lawyer';
  const [client, setClient] = useState<ComboOption | null>(null);
  const [court, setCourt] = useState<ComboOption | null>(null);
  const [staff, setStaff] = useState<Set<string>>(new Set());
  const [clientError, setClientError] = useState<string>();

  // Prefill the client when coming from a client page.
  const preset = useQuery({
    queryKey: ['client', presetClientId],
    enabled: Boolean(presetClientId),
    queryFn: () => api.get<ClientDto>(`/clients/${presetClientId}`),
  });
  useEffect(() => {
    if (preset.data) setClient({ value: preset.data.id, label: preset.data.name });
  }, [preset.data]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: '',
      referenceCode: '',
      practiceArea: '',
      status: 'active',
      priority: 'normal',
      startDate: new Date().toISOString().slice(0, 10),
      clientSummary: '',
      internalNotes: '',
      leadUserId: canLeadSelf ? me.user.id : '',
      addCase: true,
      caseTitle: '',
      caseNumber: '',
      cnr: '',
      caseType: '',
      caseStatus: 'active',
      filingDate: '',
      judgeBench: '',
    },
  });
  // The lead <select> only has options once members load; apply the default then, or the browser
  // silently falls back to "Choose later".
  const { setValue } = form;
  useEffect(() => {
    if (members.data && canLeadSelf) setValue('leadUserId', me.user.id);
  }, [members.data, canLeadSelf, me.user.id, setValue]);

  const { errors } = form.formState;
  const addCase = form.watch('addCase');
  const leadUserId = form.watch('leadUserId');

  const create = useMutation({
    mutationFn: (payload: unknown) => api.post<MatterDetailDto>('/matters', payload),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['matters'] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
      qc.setQueryData(['matter', m.id], m);
      navigate(`/matters/${m.id}`, { replace: true });
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    if (!client) {
      setClientError('Choose or create a client');
      return;
    }
    if (v.addCase && !v.caseTitle.trim()) {
      form.setError('caseTitle', { message: 'Enter the case title (e.g. Raj Sharma v ABC Industries)' });
      return;
    }
    const parsed = createMatterSchema.safeParse({
      clientId: client.value,
      title: v.title,
      referenceCode: v.referenceCode,
      practiceArea: v.practiceArea,
      status: v.status,
      priority: v.priority,
      startDate: v.startDate,
      clientSummary: v.clientSummary,
      internalNotes: v.internalNotes,
      leadUserId: v.leadUserId || null,
      staffUserIds: [...staff].filter((id) => id !== v.leadUserId),
      initialCase: v.addCase
        ? {
            title: v.caseTitle,
            caseNumber: v.caseNumber,
            cnr: v.cnr,
            courtId: court?.value ?? null,
            caseType: v.caseType,
            status: v.caseStatus,
            filingDate: v.filingDate,
            judgeBench: v.judgeBench,
          }
        : null,
    });
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const path = i.path.join('.');
        const field = path.startsWith('initialCase.')
          ? (
              {
                title: 'caseTitle',
                caseNumber: 'caseNumber',
                cnr: 'cnr',
                filingDate: 'filingDate',
              } as Record<string, keyof FormValues>
            )[path.slice('initialCase.'.length)]
          : (path as keyof FormValues);
        if (field) form.setError(field, { message: i.message });
      }
      return;
    }
    create.mutate(parsed.data);
  });

  const leadOptions = (members.data ?? []).filter(
    (m) => m.status === 'active' && ['owner', 'admin', 'lawyer'].includes(m.role),
  );
  const staffOptions = (members.data ?? []).filter((m) => m.status === 'active' && m.userId !== leadUserId);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 pb-20 sm:pb-0">
      <PageHeader
        title="New matter"
        description="Add the client, the engagement and (optionally) the court case."
      />
      {create.error ? (
        <Alert tone="danger">
          {create.error instanceof ApiError ? create.error.message : 'Could not create the matter.'}
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="1. Client" />
        <CardBody>
          <ClientPicker
            value={client}
            onChange={(o) => {
              setClient(o);
              setClientError(undefined);
            }}
            error={clientError}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="2. Matter" />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField
              label="Matter title"
              placeholder="e.g. Sharma v ABC"
              error={errors.title?.message}
              {...form.register('title')}
            />
          </div>
          <TextField
            label="Reference code"
            hint="Your internal file number"
            {...form.register('referenceCode')}
          />
          <SelectField
            label="Practice area"
            options={[
              { value: '', label: 'Not set' },
              ...PRACTICE_AREAS.map((p) => ({ value: p, label: p })),
            ]}
            {...form.register('practiceArea')}
          />
          <SelectField
            label="Status"
            options={MATTER_STATUSES.filter((s) => s !== 'archived').map((s) => ({
              value: s,
              label: MATTER_STATUS_LABELS[s],
            }))}
            {...form.register('status')}
          />
          <SelectField
            label="Priority"
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
            {...form.register('priority')}
          />
          <TextField
            label="Start date"
            type="date"
            error={errors.startDate?.message}
            {...form.register('startDate')}
          />
          <div className="sm:col-span-2">
            <TextAreaField
              label="Summary for the client"
              hint="Shown to the client in updates. Keep it plain and factual."
              {...form.register('clientSummary')}
            />
          </div>
          <div className="sm:col-span-2">
            <TextAreaField
              label="Internal notes"
              hint="Never shown to the client."
              {...form.register('internalNotes')}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="3. Team"
          description="Lawyers, staff and read-only users only see matters they’re assigned to."
        />
        <CardBody className="space-y-4">
          <SelectField
            label="Lead lawyer"
            options={[
              { value: '', label: 'Choose later' },
              ...leadOptions.map((m) => ({
                value: m.userId,
                label: `${fullName(m)}${m.userId === me.user.id ? ' (you)' : ''}`,
              })),
            ]}
            {...form.register('leadUserId')}
          />
          {staffOptions.length > 0 ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Also assign</legend>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {staffOptions.map((m) => (
                  <label
                    key={m.userId}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-subtle"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-700"
                      checked={staff.has(m.userId)}
                      onChange={(e) =>
                        setStaff((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(m.userId);
                          else next.delete(m.userId);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">
                      {fullName(m)} <span className="text-muted">· {m.role.replace('_', ' ')}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {me.role === 'staff' || me.role === 'lawyer' ? (
            <p className="text-xs text-muted">
              You’ll be added to this matter automatically so you can keep working on it.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="4. Court case"
          action={
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-brand-700" {...form.register('addCase')} />
              Add now
            </label>
          }
        />
        {addCase ? (
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <TextField
                label="Case title"
                placeholder="e.g. Raj Sharma v ABC Industries Pvt Ltd"
                error={errors.caseTitle?.message}
                {...form.register('caseTitle')}
              />
            </div>
            <TextField
              label="Case number"
              placeholder="e.g. CS(OS) 412/2026"
              {...form.register('caseNumber')}
            />
            <TextField
              label="CNR"
              autoCapitalize="characters"
              hint="16 characters, if the court has issued one"
              error={errors.cnr?.message}
              {...form.register('cnr')}
            />
            <div className="sm:col-span-2">
              <CourtPicker value={court} onChange={setCourt} />
            </div>
            <TextField
              label="Case type"
              placeholder="e.g. Civil Suit, Bail Application"
              {...form.register('caseType')}
            />
            <SelectField
              label="Case status"
              options={CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_LABELS[s] }))}
              {...form.register('caseStatus')}
            />
            <TextField
              label="Filing date"
              type="date"
              error={errors.filingDate?.message}
              {...form.register('filingDate')}
            />
            <TextField label="Judge / bench" {...form.register('judgeBench')} />
          </CardBody>
        ) : (
          <CardBody>
            <p className="text-sm text-muted">You can add one or more cases from the matter page later.</p>
          </CardBody>
        )}
      </Card>

      <div className="fixed inset-x-0 bottom-16 z-10 flex gap-2 border-t border-line bg-surface p-3 sm:static sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-0">
        <Link to="/cases" className="hidden sm:block">
          <Button variant="secondary">Cancel</Button>
        </Link>
        <Button type="submit" block className="sm:w-auto" loading={create.isPending}>
          Create matter
        </Button>
      </div>
    </form>
  );
}
