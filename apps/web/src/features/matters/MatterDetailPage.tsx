import { zodResolver } from '@hookform/resolvers/zod';
import {
  can,
  CASE_STATUS_LABELS,
  MATTER_STAFF_ROLE_LABELS,
  MATTER_STAFF_ROLES,
  MATTER_STATUS_LABELS,
  MATTER_STATUSES,
  PRACTICE_AREAS,
  PRIORITIES,
  PRIORITY_LABELS,
  type MatterDetailDto,
  type MatterStaffRole,
  type HearingDto,
  type TaskDto,
  type TimelineEventDto,
} from '@legalops/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SelectField,
  Sheet,
  SkeletonList,
  Tabs,
  TextAreaField,
  TextField,
} from '@legalops/ui';
import { updateMatterSchema } from '@legalops/validation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  FileText,
  Mail,
  Pencil,
  Plus,
  Scale,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { z } from 'zod';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, formatDateTime, fullName, relativeTime, todayIn } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { CASE_STATUS_TONE, MATTER_STATUS_TONE, PRIORITY_TONE } from '../../lib/status.js';
import { MatterBillingTab } from '../billing/MatterBillingTab.js';
import { MatterCommunicationTab } from '../communication/MatterCommunicationTab.js';
import { CaseFormSheet } from '../cases/CaseFormSheet.js';
import { NotFound } from '../common/NotFound.js';
import { CasePicker, HearingFormSheet } from '../hearings/HearingFormSheet.js';
import { HearingRow } from '../hearings/HearingRow.js';
import { TaskFormSheet } from '../tasks/TaskFormSheet.js';
import { TaskRow } from '../tasks/TaskRow.js';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'hearings', label: 'Hearings' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'documents', label: 'Documents' },
  { key: 'billing', label: 'Billing' },
  { key: 'communication', label: 'Communication' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function MatterDetailPage() {
  const { matterId = '' } = useParams();
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview') as TabKey;
  const [editing, setEditing] = useState(false);
  const [addingCase, setAddingCase] = useState(false);
  const [managingTeam, setManagingTeam] = useState(false);
  const [addingHearing, setAddingHearing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);

  const matter = useQuery({
    queryKey: ['matter', matterId],
    queryFn: () => api.get<MatterDetailDto>(`/matters/${matterId}`),
  });

  if (matter.isPending) return <SkeletonList rows={5} />;
  if (matter.isError) {
    return matter.error instanceof ApiError && matter.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this matter.</Alert>
    );
  }
  const m = matter.data;
  const canEdit = can(me.role, 'matters.edit');
  const canAdd = can(me.role, 'matters.create');

  return (
    <div className="space-y-4">
      <div>
        <Link to="/cases" className="text-sm text-muted hover:text-ink">
          ← Cases
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{m.title}</h1>
            <p className="mt-0.5 text-sm text-ink-soft">
              <Link to={`/clients/${m.client.id}`} className="font-medium text-brand-700 hover:underline">
                {m.client.name}
              </Link>
              {m.referenceCode ? <span className="text-muted"> · {m.referenceCode}</span> : null}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={MATTER_STATUS_TONE[m.status]}>{MATTER_STATUS_LABELS[m.status]}</Badge>
              {m.priority !== 'normal' ? (
                <Badge tone={PRIORITY_TONE[m.priority]}>{PRIORITY_LABELS[m.priority]} priority</Badge>
              ) : null}
              {m.practiceArea ? <Badge>{m.practiceArea}</Badge> : null}
              {m.lead ? (
                <Badge tone="info">Lead: {fullName(m.lead)}</Badge>
              ) : (
                <Badge tone="warning">No lead lawyer</Badge>
              )}
            </div>
          </div>
          {canEdit ? (
            <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {/* Quick actions (PRD Screen 7). Later-phase actions are shown disabled, not hidden, so the flow is visible. */}
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        {canAdd ? (
          <QuickAction icon={<Scale />} label="Add case" onClick={() => setAddingCase(true)} />
        ) : null}
        {can(me.role, 'hearings.manage') && m.cases.length > 0 ? (
          <QuickAction icon={<CalendarDays />} label="Add hearing" onClick={() => setAddingHearing(true)} />
        ) : null}
        {can(me.role, 'tasks.manage') ? (
          <QuickAction icon={<CheckSquare />} label="Add task" onClick={() => setAddingTask(true)} />
        ) : null}
        <QuickAction icon={<FileText />} label="Add document" soon />
        {can(me.role, 'invoices.manage') ? (
          <QuickAction
            icon={<Banknote />}
            label="Invoice"
            onClick={() => navigate(`/invoices/new?matterId=${m.id}`)}
          />
        ) : null}
        <QuickAction icon={<Mail />} label="Client update" soon />
      </div>

      <Tabs
        label="Matter sections"
        items={TABS}
        value={tab}
        onChange={(k) => setParams({ tab: k }, { replace: true })}
      />

      {tab === 'overview' ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader
                title="Cases"
                action={
                  canAdd ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Plus className="size-4" />}
                      onClick={() => setAddingCase(true)}
                    >
                      Add
                    </Button>
                  ) : null
                }
              />
              {m.cases.length === 0 ? (
                <EmptyState
                  icon={<Scale />}
                  title="No court case yet"
                  description="Add the case number, CNR and court once filed."
                />
              ) : (
                <div className="divide-y divide-line">
                  {m.cases.map((c) => (
                    <Link
                      key={c.id}
                      to={`/cases/${c.id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold">{c.caseNumber ?? c.title}</p>
                          <Badge tone={CASE_STATUS_TONE[c.status]}>{CASE_STATUS_LABELS[c.status]}</Badge>
                        </div>
                        {c.caseNumber ? <p className="truncate text-sm text-ink-soft">{c.title}</p> : null}
                        <p className="truncate text-xs text-muted">
                          {[c.court?.name, c.cnr ? `CNR ${c.cnr}` : null].filter(Boolean).join(' · ') ||
                            'Court not set'}
                        </p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                    </Link>
                  ))}
                </div>
              )}
            </Card>
            {m.clientSummary || m.internalNotes ? (
              <Card>
                <CardHeader title="Notes" />
                <CardBody className="space-y-4 text-sm">
                  {m.clientSummary ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                        Client-visible summary
                      </p>
                      <p className="whitespace-pre-wrap">{m.clientSummary}</p>
                    </div>
                  ) : null}
                  {m.internalNotes ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
                        Internal
                      </p>
                      <p className="whitespace-pre-wrap text-ink-soft">{m.internalNotes}</p>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Team"
                action={
                  canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Users className="size-4" />}
                      onClick={() => setManagingTeam(true)}
                    >
                      Manage
                    </Button>
                  ) : null
                }
              />
              <ul className="divide-y divide-line">
                {m.staff.length === 0 ? (
                  <li className="px-4 py-3 text-sm text-muted sm:px-5">Nobody assigned yet.</li>
                ) : null}
                {m.staff.map((s) => (
                  <li
                    key={s.userId}
                    className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5"
                  >
                    <span className="truncate">{fullName(s)}</span>
                    <span className="shrink-0 text-xs text-muted">{MATTER_STAFF_ROLE_LABELS[s.role]}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Key dates" />
              <CardBody>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Next hearing</dt>
                    <dd className="font-medium">{formatDate(m.nextHearingDate)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Opened</dt>
                    <dd>{formatDate(m.startDate)}</dd>
                  </div>
                  {m.closeDate ? (
                    <div>
                      <dt className="text-xs text-muted">Closed</dt>
                      <dd>{formatDate(m.closeDate)}</dd>
                    </div>
                  ) : null}
                </dl>
              </CardBody>
            </Card>
          </div>
        </div>
      ) : tab === 'timeline' ? (
        <TimelineTab matterId={m.id} timeZone={me.organization.timezone} />
      ) : tab === 'hearings' ? (
        <MatterHearingsTab
          matter={m}
          onAdd={
            can(me.role, 'hearings.manage') && m.cases.length > 0 ? () => setAddingHearing(true) : undefined
          }
        />
      ) : tab === 'billing' ? (
        <MatterBillingTab matter={m} />
      ) : tab === 'communication' ? (
        <MatterCommunicationTab matter={m} />
      ) : tab === 'tasks' ? (
        <MatterTasksTab
          matterId={m.id}
          onAdd={can(me.role, 'tasks.manage') ? () => setAddingTask(true) : undefined}
        />
      ) : (
        <Card>
          <EmptyState
            title={`${TABS.find((t) => t.key === tab)!.label} arrive in ${PHASE[tab as keyof typeof PHASE]}`}
            description="This matter’s data is already linked and will appear here automatically."
            className="py-12"
          />
        </Card>
      )}

      {canEdit ? <EditMatterSheet open={editing} onClose={() => setEditing(false)} matter={m} /> : null}
      {canAdd ? (
        <CaseFormSheet open={addingCase} onClose={() => setAddingCase(false)} matterId={m.id} />
      ) : null}
      {canEdit ? <TeamSheet open={managingTeam} onClose={() => setManagingTeam(false)} matter={m} /> : null}
      {/* With a single case, schedule straight onto it; otherwise let the user pick among this matter's cases. */}
      <MatterHearingSheet open={addingHearing} onClose={() => setAddingHearing(false)} matter={m} />
      <TaskFormSheet
        open={addingTask}
        onClose={() => setAddingTask(false)}
        fixedMatter={{ value: m.id, label: m.title }}
      />
    </div>
  );
}

const PHASE: Record<Exclude<TabKey, 'overview' | 'timeline' | 'hearings' | 'tasks' | 'billing' | 'communication'>, string> = {
  documents: 'Phase 6',
};

function QuickAction({
  icon,
  label,
  onClick,
  soon,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  soon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={soon}
      title={soon ? 'Coming in a later phase' : undefined}
      className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-soft hover:bg-subtle disabled:opacity-45 sm:min-h-11 sm:flex-row sm:gap-2 sm:text-sm [&_svg]:size-4.5"
    >
      {icon}
      {label}
    </button>
  );
}

function TimelineTab({ matterId, timeZone }: { matterId: string; timeZone: string }) {
  const timeline = useInfiniteQuery({
    queryKey: ['matter', matterId, 'timeline'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.getPage<TimelineEventDto>(`/matters/${matterId}/timeline${qs({ page: pageParam, pageSize: 25 })}`),
    getNextPageParam: (last) =>
      last.meta.page * last.meta.pageSize < last.meta.total ? last.meta.page + 1 : undefined,
  });
  if (timeline.isPending) return <SkeletonList rows={4} />;
  if (timeline.isError) return <Alert tone="danger">Couldn’t load the timeline.</Alert>;
  const events = timeline.data.pages.flatMap((p) => p.items);
  if (events.length === 0)
    return (
      <Card>
        <EmptyState title="Nothing has happened yet" />
      </Card>
    );
  return (
    <Card>
      <ol className="relative px-4 py-4 sm:px-5">
        {events.map((e, i) => (
          <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < events.length - 1 ? (
              <span className="absolute top-3 bottom-0 left-[5px] w-px bg-line" aria-hidden />
            ) : null}
            <span
              className="relative mt-1.5 size-2.75 shrink-0 rounded-full border-2 border-brand-600 bg-surface"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{e.title}</p>
              {e.description ? <p className="text-sm break-words text-ink-soft">{e.description}</p> : null}
              <p className="mt-0.5 text-xs text-muted">
                <time dateTime={e.createdAt} title={formatDateTime(e.createdAt, timeZone)}>
                  {relativeTime(e.createdAt)}
                </time>
                {e.actor ? ` · ${fullName(e.actor)}` : e.actorType !== 'user' ? ` · ${e.actorType}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {timeline.hasNextPage ? (
        <div className="border-t border-line p-3 text-center">
          <Button
            variant="ghost"
            size="sm"
            loading={timeline.isFetchingNextPage}
            onClick={() => void timeline.fetchNextPage()}
          >
            Show older
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const editSchema = z.object({
  title: z.string().trim().min(1, { error: 'Enter the matter title' }).max(255),
  referenceCode: z.string(),
  practiceArea: z.string(),
  status: z.enum(MATTER_STATUSES),
  priority: z.enum(PRIORITIES),
  clientSummary: z.string(),
  internalNotes: z.string(),
});
type EditValues = z.infer<typeof editSchema>;

function EditMatterSheet({
  open,
  onClose,
  matter,
}: {
  open: boolean;
  onClose: () => void;
  matter: MatterDetailDto;
}) {
  const qc = useQueryClient();
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema) });
  useEffect(() => {
    if (open) {
      form.reset({
        title: matter.title,
        referenceCode: matter.referenceCode ?? '',
        practiceArea: matter.practiceArea ?? '',
        status: matter.status,
        priority: matter.priority,
        clientSummary: matter.clientSummary ?? '',
        internalNotes: matter.internalNotes ?? '',
      });
    }
  }, [open, matter, form]);
  const save = useMutation({
    mutationFn: (v: EditValues) =>
      api.patch<MatterDetailDto>(`/matters/${matter.id}`, updateMatterSchema.parse(v)),
    onSuccess: (m) => {
      qc.setQueryData(['matter', m.id], m);
      void qc.invalidateQueries({ queryKey: ['matters'] });
      void qc.invalidateQueries({ queryKey: ['matter', m.id, 'timeline'] });
      onClose();
    },
  });
  const { errors } = form.formState;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit matter"
      footer={
        <Button block type="submit" form="matter-form" loading={save.isPending}>
          Save changes
        </Button>
      }
    >
      <form
        id="matter-form"
        onSubmit={form.handleSubmit((v) => save.mutate(v))}
        className="space-y-4"
        noValidate
      >
        {save.error ? (
          <Alert tone="danger">
            {save.error instanceof ApiError ? save.error.message : 'Could not save.'}
          </Alert>
        ) : null}
        <TextField label="Title" error={errors.title?.message} {...form.register('title')} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Reference code" {...form.register('referenceCode')} />
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
            options={MATTER_STATUSES.map((s) => ({ value: s, label: MATTER_STATUS_LABELS[s] }))}
            {...form.register('status')}
          />
          <SelectField
            label="Priority"
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
            {...form.register('priority')}
          />
        </div>
        <TextAreaField label="Summary for the client" {...form.register('clientSummary')} />
        <TextAreaField label="Internal notes" {...form.register('internalNotes')} />
      </form>
    </Sheet>
  );
}

function TeamSheet({
  open,
  onClose,
  matter,
}: {
  open: boolean;
  onClose: () => void;
  matter: MatterDetailDto;
}) {
  const qc = useQueryClient();
  const members = useMembers();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<MatterStaffRole>('support');
  const refresh = (m?: MatterDetailDto) => {
    if (m) qc.setQueryData(['matter', m.id], m);
    void qc.invalidateQueries({ queryKey: ['matter', matter.id] });
    void qc.invalidateQueries({ queryKey: ['matters'] });
  };
  const add = useMutation({
    mutationFn: () => api.post<MatterDetailDto>(`/matters/${matter.id}/staff`, { userId, role }),
    onSuccess: (m) => {
      setUserId('');
      refresh(m);
    },
  });
  const remove = useMutation({
    mutationFn: (uid: string) => api.delete(`/matters/${matter.id}/staff/${uid}`),
    onSuccess: () => refresh(),
  });
  const assigned = new Set(matter.staff.map((s) => s.userId));
  const candidates = (members.data ?? []).filter((m) => m.status === 'active' && !assigned.has(m.userId));
  const error = add.error ?? remove.error;

  return (
    <Sheet open={open} onClose={onClose} title="Matter team">
      <div className="space-y-4">
        {error ? (
          <Alert tone="danger">{error instanceof ApiError ? error.message : 'Update failed.'}</Alert>
        ) : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {matter.staff.map((s) => (
            <li key={s.userId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {fullName(s)} <span className="text-muted">· {MATTER_STAFF_ROLE_LABELS[s.role]}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${fullName(s)}`}
                onClick={() => remove.mutate(s.userId)}
                className="grid size-9 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-danger-700"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
          {matter.staff.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">Nobody assigned.</li>
          ) : null}
        </ul>
        {candidates.length > 0 ? (
          <div className="space-y-3 rounded-lg bg-subtle p-3">
            <SelectField
              label="Add person"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              options={[
                { value: '', label: 'Choose…' },
                ...candidates.map((c) => ({ value: c.userId, label: fullName(c) })),
              ]}
            />
            <SelectField
              label="Role on this matter"
              value={role}
              onChange={(e) => setRole(e.target.value as MatterStaffRole)}
              options={MATTER_STAFF_ROLES.map((r) => ({ value: r, label: MATTER_STAFF_ROLE_LABELS[r] }))}
            />
            <Button block disabled={!userId} loading={add.isPending} onClick={() => add.mutate()}>
              Assign
            </Button>
            {role === 'lead' ? (
              <p className="text-xs text-muted">The current lead becomes an associate.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function MatterHearingsTab({ matter, onAdd }: { matter: MatterDetailDto; onAdd: (() => void) | undefined }) {
  const me = useSession();
  const today = todayIn(me.organization.timezone);
  const hearings = useQuery({
    queryKey: ['hearings', { matterId: matter.id }],
    queryFn: () => api.get<HearingDto[]>(`/hearings${qs({ matterId: matter.id })}`),
  });
  if (hearings.isPending) return <SkeletonList rows={3} />;
  if (hearings.isError) return <Alert tone="danger">Couldn’t load hearings.</Alert>;
  const upcoming = hearings.data.filter((h) => h.status === 'scheduled' && !h.pendingOutcome).reverse();
  const needsOutcome = hearings.data.filter((h) => h.pendingOutcome);
  const past = hearings.data.filter((h) => h.status !== 'scheduled');
  const section = (title: string, list: HearingDto[]) =>
    list.length ? (
      <Card>
        <CardHeader title={title} />
        <div className="divide-y divide-line">
          {list.map((h) => (
            <HearingRow key={h.id} hearing={h} today={today} showDate showMatter={false} />
          ))}
        </div>
      </Card>
    ) : null;
  return (
    <div className="space-y-4">
      {onAdd ? (
        <Button icon={<Plus className="size-4" />} onClick={onAdd}>
          Schedule hearing
        </Button>
      ) : null}
      {hearings.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarDays />}
            title="No hearings yet"
            description={
              matter.cases.length === 0 ? 'Add a court case first, then schedule its hearings.' : undefined
            }
          />
        </Card>
      ) : null}
      {section('Needs an outcome', needsOutcome)}
      {section('Upcoming', upcoming)}
      {section('Past', past)}
    </div>
  );
}

function MatterTasksTab({ matterId, onAdd }: { matterId: string; onAdd: (() => void) | undefined }) {
  const me = useSession();
  const today = todayIn(me.organization.timezone);
  const tasks = useQuery({
    queryKey: ['tasks', { matterId }],
    queryFn: () => api.getPage<TaskDto>(`/tasks${qs({ view: 'all', matterId, pageSize: 100 })}`),
  });
  if (tasks.isPending) return <SkeletonList rows={3} />;
  if (tasks.isError) return <Alert tone="danger">Couldn’t load tasks.</Alert>;
  const open = tasks.data.items.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const closed = tasks.data.items.filter((t) => t.status === 'done' || t.status === 'cancelled');
  const canComplete = (t: TaskDto) => can(me.role, 'tasks.manage') || t.assignee?.userId === me.user.id;
  return (
    <div className="space-y-4">
      {onAdd ? (
        <Button icon={<Plus className="size-4" />} onClick={onAdd}>
          New task
        </Button>
      ) : null}
      <Card>
        <CardHeader title={`Open (${open.length})`} />
        {open.length ? (
          <div className="divide-y divide-line">
            {open.map((t) => (
              <TaskRow key={t.id} task={t} today={today} canComplete={canComplete(t)} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CheckSquare />} title="No open tasks" />
        )}
      </Card>
      {closed.length ? (
        <Card>
          <CardHeader title={`Done (${closed.length})`} />
          <div className="divide-y divide-line">
            {closed.map((t) => (
              <TaskRow key={t.id} task={t} today={today} canComplete={false} />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function MatterHearingSheet({
  open,
  onClose,
  matter,
}: {
  open: boolean;
  onClose: () => void;
  matter: MatterDetailDto;
}) {
  const only = matter.cases.length === 1 ? matter.cases[0]! : null;
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);
  if (only) {
    return (
      <HearingFormSheet
        open={open}
        onClose={onClose}
        fixedCase={{ value: only.id, label: only.caseNumber ?? only.title }}
      />
    );
  }
  if (picked) return <HearingFormSheet open={open} onClose={onClose} fixedCase={picked} />;
  return (
    <Sheet open={open} onClose={onClose} title="Which case?">
      <CasePicker
        value={null}
        onChange={(o) => setPicked(o ? { value: o.value, label: o.label } : null)}
        matterId={matter.id}
      />
    </Sheet>
  );
}
