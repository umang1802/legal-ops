import { zodResolver } from '@hookform/resolvers/zod';
import {
  can,
  CASE_STATUS_LABELS,
  PARTY_SIDE_LABELS,
  PARTY_SIDES,
  type CaseDetailDto,
  type HearingDto,
} from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  SelectField,
  Sheet,
  SkeletonList,
  TextField,
} from '@legalops/ui';
import { advocateSchema, partySchema } from '@legalops/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, todayIn } from '../../lib/format.js';
import { CASE_STATUS_TONE } from '../../lib/status.js';
import { NotFound } from '../common/NotFound.js';
import { HearingFormSheet } from '../hearings/HearingFormSheet.js';
import { HearingRow } from '../hearings/HearingRow.js';
import { CaseFormSheet } from './CaseFormSheet.js';

export function CaseDetailPage() {
  const { caseId = '' } = useParams();
  const me = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [addingParty, setAddingParty] = useState(false);
  const [addingAdvocate, setAddingAdvocate] = useState(false);
  const kase = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => api.get<CaseDetailDto>(`/cases/${caseId}`),
  });
  const refresh = useMutation({ mutationFn: () => api.post(`/cases/${caseId}/refresh`) });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['case', caseId] });
    if (kase.data) void qc.invalidateQueries({ queryKey: ['matter', kase.data.matter.id] });
  };
  const removeParty = useMutation({
    mutationFn: (id: string) => api.delete(`/cases/${caseId}/parties/${id}`),
    onSuccess: invalidate,
  });
  const removeAdvocate = useMutation({
    mutationFn: (id: string) => api.delete(`/cases/${caseId}/advocates/${id}`),
    onSuccess: invalidate,
  });

  if (kase.isPending) return <SkeletonList rows={5} />;
  if (kase.isError) {
    return kase.error instanceof ApiError && kase.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this case.</Alert>
    );
  }
  const c = kase.data;
  const canEdit = can(me.role, 'matters.edit');
  const canAdd = can(me.role, 'matters.create');
  const removeError = removeParty.error ?? removeAdvocate.error;

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/matters/${c.matter.id}`} className="text-sm text-muted hover:text-ink">
          ← {c.matter.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">
              {c.caseNumber ?? c.title}
            </h1>
            {c.caseNumber ? <p className="mt-0.5 text-sm break-words text-ink-soft">{c.title}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={CASE_STATUS_TONE[c.status]}>{CASE_STATUS_LABELS[c.status]}</Badge>
              {c.court ? <Badge>{c.court.name}</Badge> : null}
            </div>
          </div>
          {canEdit ? (
            <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <CaseHearings caseId={c.id} caseLabel={c.caseNumber ?? c.title} />
          <Card>
            <CardHeader
              title="Parties"
              action={
                canAdd ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus className="size-4" />}
                    onClick={() => setAddingParty(true)}
                  >
                    Add
                  </Button>
                ) : null
              }
            />
            {removeError ? (
              <div className="px-4 pt-3 sm:px-5">
                <Alert tone="danger">
                  {removeError instanceof ApiError ? removeError.message : 'Could not remove.'}
                </Alert>
              </div>
            ) : null}
            <ul className="divide-y divide-line">
              {c.parties.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted sm:px-5">No parties added.</li>
              ) : null}
              {c.parties.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {p.name} {p.isClient ? <Badge tone="info">Our client</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {[p.side ? PARTY_SIDE_LABELS[p.side] : null, p.partyType, p.phone, p.email]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  </div>
                  {canEdit ? (
                    <RemoveButton label={`Remove ${p.name}`} onClick={() => removeParty.mutate(p.id)} />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader
              title="Advocates"
              action={
                canAdd ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus className="size-4" />}
                    onClick={() => setAddingAdvocate(true)}
                  >
                    Add
                  </Button>
                ) : null
              }
            />
            <ul className="divide-y divide-line">
              {c.advocates.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted sm:px-5">No advocates added.</li>
              ) : null}
              {c.advocates.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a.name} {a.isInternal ? <Badge tone="info">Our firm</Badge> : null}{' '}
                      {a.isLead ? <Badge>Lead</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {[a.side ? `For ${PARTY_SIDE_LABELS[a.side].toLowerCase()}` : null, a.firmName, a.phone]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  </div>
                  {canEdit ? (
                    <RemoveButton label={`Remove ${a.name}`} onClick={() => removeAdvocate.mutate(a.id)} />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Detail
                  label="CNR"
                  value={c.cnr ? <span className="font-mono text-xs">{c.cnr}</span> : null}
                />
                <Detail label="Case type" value={c.caseType} />
                <Detail label="Filed" value={c.filingDate ? formatDate(c.filingDate) : null} />
                <Detail
                  label="Registered"
                  value={c.registrationDate ? formatDate(c.registrationDate) : null}
                />
                <Detail label="Judge / bench" value={c.judgeBench} wide />
                <Detail
                  label="Next hearing"
                  value={c.nextHearingDate ? formatDate(c.nextHearingDate) : null}
                />
                <Detail
                  label="Client"
                  value={
                    <Link className="text-brand-700 hover:underline" to={`/clients/${c.matter.client.id}`}>
                      {c.matter.client.name}
                    </Link>
                  }
                />
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Court data" />
            <CardBody className="space-y-3 text-sm">
              <p className="text-ink-soft">
                {c.lastSyncedAt
                  ? `Last synced ${formatDate(c.lastSyncedAt.slice(0, 10))}`
                  : 'Entered manually. Not synced from a court source.'}
              </p>
              {refresh.error ? (
                <Alert tone="info">
                  {refresh.error instanceof ApiError ? refresh.error.message : 'Refresh failed.'}
                </Alert>
              ) : null}
              <Button
                variant="secondary"
                block
                icon={<RefreshCw className="size-4" />}
                loading={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                Refresh from court
              </Button>
            </CardBody>
          </Card>
        </div>
      </div>

      {canEdit ? (
        <CaseFormSheet open={editing} onClose={() => setEditing(false)} matterId={c.matter.id} existing={c} />
      ) : null}
      {canAdd ? (
        <PartySheet
          open={addingParty}
          onClose={() => setAddingParty(false)}
          caseId={c.id}
          onSaved={invalidate}
        />
      ) : null}
      {canAdd ? (
        <AdvocateSheet
          open={addingAdvocate}
          onClose={() => setAddingAdvocate(false)}
          caseId={c.id}
          onSaved={invalidate}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words">{value ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="flex shrink-0 gap-1">
      <Button size="sm" variant="danger" onClick={onClick}>
        Remove
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </div>
  ) : (
    <button
      type="button"
      aria-label={label}
      onClick={() => setConfirming(true)}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-danger-700"
    >
      <X className="size-4" />
    </button>
  );
}

const SIDE_OPTIONS = [
  { value: '', label: 'Not set' },
  ...PARTY_SIDES.map((s) => ({ value: s, label: PARTY_SIDE_LABELS[s] })),
];

const partyForm = z.object({
  name: z.string().trim().min(1, { error: 'Enter the name' }),
  side: z.string(),
  partyType: z.string(),
  isClient: z.boolean(),
  email: z.string(),
  phone: z.string(),
});

function PartySheet({
  open,
  onClose,
  caseId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
  onSaved: () => void;
}) {
  const form = useForm<z.infer<typeof partyForm>>({ resolver: zodResolver(partyForm) });
  useEffect(() => {
    if (open) form.reset({ name: '', side: '', partyType: '', isClient: false, email: '', phone: '' });
  }, [open, form]);
  const save = useMutation({
    mutationFn: (v: z.infer<typeof partyForm>) =>
      api.post(`/cases/${caseId}/parties`, partySchema.parse({ ...v, side: v.side || null })),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => {
      if (err instanceof z.ZodError)
        for (const i of err.issues) form.setError(i.path.join('.') as 'name', { message: i.message });
    },
  });
  const { errors } = form.formState;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add party"
      footer={
        <Button block type="submit" form="party-form" loading={save.isPending}>
          Add party
        </Button>
      }
    >
      <form
        id="party-form"
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="space-y-4"
        noValidate
      >
        {save.error instanceof ApiError ? <Alert tone="danger">{save.error.message}</Alert> : null}
        <TextField label="Name" error={errors.name?.message} {...form.register('name')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Side" options={SIDE_OPTIONS} {...form.register('side')} />
          <TextField label="Type" placeholder="e.g. State, Company" {...form.register('partyType')} />
          <TextField label="Phone" type="tel" error={errors.phone?.message} {...form.register('phone')} />
          <TextField label="Email" type="email" error={errors.email?.message} {...form.register('email')} />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-700" {...form.register('isClient')} />
          This party is our client
        </label>
      </form>
    </Sheet>
  );
}

const advocateForm = z.object({
  name: z.string().trim().min(1, { error: 'Enter the name' }),
  firmName: z.string(),
  enrollmentNumber: z.string(),
  phone: z.string(),
  email: z.string(),
  side: z.string(),
  isInternal: z.boolean(),
  isLead: z.boolean(),
});

function AdvocateSheet({
  open,
  onClose,
  caseId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
  onSaved: () => void;
}) {
  const form = useForm<z.infer<typeof advocateForm>>({ resolver: zodResolver(advocateForm) });
  useEffect(() => {
    if (open)
      form.reset({
        name: '',
        firmName: '',
        enrollmentNumber: '',
        phone: '',
        email: '',
        side: '',
        isInternal: false,
        isLead: false,
      });
  }, [open, form]);
  const save = useMutation({
    mutationFn: (v: z.infer<typeof advocateForm>) =>
      api.post(`/cases/${caseId}/advocates`, advocateSchema.parse({ ...v, side: v.side || null })),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => {
      if (err instanceof z.ZodError)
        for (const i of err.issues) form.setError(i.path.join('.') as 'name', { message: i.message });
    },
  });
  const { errors } = form.formState;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add advocate"
      footer={
        <Button block type="submit" form="advocate-form" loading={save.isPending}>
          Add advocate
        </Button>
      }
    >
      <form
        id="advocate-form"
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="space-y-4"
        noValidate
      >
        {save.error instanceof ApiError ? <Alert tone="danger">{save.error.message}</Alert> : null}
        <TextField label="Name" error={errors.name?.message} {...form.register('name')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Firm / chamber" {...form.register('firmName')} />
          <TextField label="Enrollment no." hint="Optional" {...form.register('enrollmentNumber')} />
          <SelectField label="Appearing for" options={SIDE_OPTIONS} {...form.register('side')} />
          <TextField label="Phone" type="tel" error={errors.phone?.message} {...form.register('phone')} />
        </div>
        <TextField label="Email" type="email" error={errors.email?.message} {...form.register('email')} />
        <div className="flex flex-wrap gap-x-6">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-700" {...form.register('isInternal')} />
            From our firm
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-700" {...form.register('isLead')} />
            Lead counsel
          </label>
        </div>
      </form>
    </Sheet>
  );
}

function CaseHearings({ caseId, caseLabel }: { caseId: string; caseLabel: string }) {
  const me = useSession();
  const today = todayIn(me.organization.timezone);
  const [scheduling, setScheduling] = useState(false);
  const hearings = useQuery({
    queryKey: ['hearings', { caseId }],
    queryFn: () => api.get<HearingDto[]>(`/hearings${qs({ caseId })}`),
  });
  return (
    <Card>
      <CardHeader
        title="Hearings"
        action={
          can(me.role, 'hearings.manage') ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() => setScheduling(true)}
            >
              Schedule
            </Button>
          ) : null
        }
      />
      {hearings.data && hearings.data.length > 0 ? (
        <div className="divide-y divide-line">
          {hearings.data.slice(0, 6).map((h) => (
            <HearingRow key={h.id} hearing={h} today={today} showDate showMatter={false} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted sm:px-5">
          {hearings.isPending ? 'Loading…' : 'No hearings yet.'}
        </p>
      )}
      <HearingFormSheet
        open={scheduling}
        onClose={() => setScheduling(false)}
        fixedCase={{ value: caseId, label: caseLabel }}
      />
    </Card>
  );
}
