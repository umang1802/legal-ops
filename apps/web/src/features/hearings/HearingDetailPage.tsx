import { can, HEARING_STATUS_LABELS, type HearingDto, type TaskDto } from '@legalops/types';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, SkeletonList } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Pencil, Plus, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, formatTime, fullName, relativeDay, todayIn } from '../../lib/format.js';
import { hearingTone } from '../../lib/status.js';
import { NotFound } from '../common/NotFound.js';
import { TaskFormSheet } from '../tasks/TaskFormSheet.js';
import { TaskRow } from '../tasks/TaskRow.js';
import { CancelHearingSheet, CompleteHearingSheet } from './CompleteHearingSheet.js';
import { HearingFormSheet } from './HearingFormSheet.js';

export function HearingDetailPage() {
  const { hearingId = '' } = useParams();
  const me = useSession();
  const [sheet, setSheet] = useState<'edit' | 'complete' | 'cancel' | 'task' | null>(null);
  const today = todayIn(me.organization.timezone);
  const hearing = useQuery({
    queryKey: ['hearing', hearingId],
    queryFn: () => api.get<HearingDto>(`/hearings/${hearingId}`),
  });
  const tasks = useQuery({
    queryKey: ['tasks', { hearingId }],
    queryFn: () => api.getPage<TaskDto>(`/tasks${qs({ view: 'all', hearingId })}`),
  });

  if (hearing.isPending) return <SkeletonList rows={4} />;
  if (hearing.isError) {
    return hearing.error instanceof ApiError && hearing.error.status === 404 ? (
      <NotFound />
    ) : (
      <Alert tone="danger">Couldn’t load this hearing.</Alert>
    );
  }
  const h = hearing.data;
  const manage = can(me.role, 'hearings.manage');
  const scheduled = h.status === 'scheduled';
  const canRecord = manage && scheduled && h.scheduledDate <= today;

  return (
    <div className="space-y-4">
      <div>
        <Link to="/calendar" className="text-sm text-muted hover:text-ink">
          ← Calendar
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
          {relativeDay(h.scheduledDate, today)}
          {h.startTime ? `, ${formatTime(h.startTime)}` : ''}
        </h1>
        <p className="mt-0.5 text-sm text-ink-soft">
          <Link to={`/cases/${h.caseId}`} className="font-medium text-brand-700 hover:underline">
            {h.caseNumber ?? h.caseTitle}
          </Link>{' '}
          ·{' '}
          <Link to={`/matters/${h.matterId}`} className="hover:underline">
            {h.matterTitle}
          </Link>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={hearingTone(h)}>
            {h.pendingOutcome ? 'Outcome needed' : HEARING_STATUS_LABELS[h.status]}
          </Badge>
          {h.hearingType ? <Badge>{h.hearingType}</Badge> : null}
        </div>
      </div>

      {h.pendingOutcome && manage ? (
        <Alert tone="warning" title="This hearing has passed">
          Record what happened and the next date so the matter, team and client stay up to date.
        </Alert>
      ) : null}

      {manage && scheduled ? (
        <div className="flex flex-wrap gap-2">
          {canRecord ? (
            <Button
              size="lg"
              icon={<CalendarCheck className="size-4" />}
              onClick={() => setSheet('complete')}
            >
              Record outcome
            </Button>
          ) : null}
          <Button variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setSheet('edit')}>
            Edit / reschedule
          </Button>
          <Button
            variant="ghost"
            className="text-danger-700"
            icon={<XCircle className="size-4" />}
            onClick={() => setSheet('cancel')}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {h.status === 'completed' || h.status === 'adjourned' ? (
            <Card>
              <CardHeader title="Outcome" />
              <CardBody className="space-y-3 text-sm">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Internal note</p>
                  <p className="whitespace-pre-wrap">{h.outcome}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Update for client</p>
                  <p className="whitespace-pre-wrap">
                    {h.clientSummary ?? <span className="text-muted">None. Client emails use a neutral line.</span>}
                  </p>
                </div>
                {h.nextHearingId ? (
                  <p>
                    Next date:{' '}
                    <Link
                      to={`/hearings/${h.nextHearingId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {formatDate(h.nextHearingDate)}
                    </Link>
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
          {h.status === 'cancelled' ? (
            <Alert tone="info" title="Cancelled">
              {h.cancelReason}
            </Alert>
          ) : null}
          <Card>
            <CardHeader
              title="Follow-up tasks"
              action={
                can(me.role, 'tasks.manage') ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus className="size-4" />}
                    onClick={() => setSheet('task')}
                  >
                    Add
                  </Button>
                ) : null
              }
            />
            {tasks.data && tasks.data.items.length > 0 ? (
              <div className="divide-y divide-line">
                {tasks.data.items.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    today={today}
                    canComplete={can(me.role, 'tasks.manage') || t.assignee?.userId === me.user.id}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No follow-up tasks"
                description="Add them here or while recording the outcome."
              />
            )}
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <D label="Date">{formatDate(h.scheduledDate, { weekday: true })}</D>
              <D label="Time">
                {h.startTime
                  ? `${formatTime(h.startTime)}${h.endTime ? ` – ${formatTime(h.endTime)}` : ''}`
                  : null}
              </D>
              <D label="Court">{h.courtName}</D>
              <D label="Court room">{h.courtroom}</D>
              <D label="Judge / bench" wide>
                {h.benchJudge}
              </D>
              <D label="Client">{h.clientName}</D>
              <D label="Lead">{h.lead ? fullName(h.lead) : null}</D>
              {h.previousHearingId ? (
                <D label="Previous hearing" wide>
                  <Link to={`/hearings/${h.previousHearingId}`} className="text-brand-700 hover:underline">
                    View
                  </Link>
                </D>
              ) : null}
              {h.notes ? (
                <D label="Notes" wide>
                  <span className="whitespace-pre-wrap">{h.notes}</span>
                </D>
              ) : null}
            </dl>
          </CardBody>
        </Card>
      </div>

      {manage ? (
        <>
          <HearingFormSheet open={sheet === 'edit'} onClose={() => setSheet(null)} existing={h} />
          <CompleteHearingSheet open={sheet === 'complete'} onClose={() => setSheet(null)} hearing={h} />
          <CancelHearingSheet open={sheet === 'cancel'} onClose={() => setSheet(null)} hearing={h} />
        </>
      ) : null}
      <TaskFormSheet
        open={sheet === 'task'}
        onClose={() => setSheet(null)}
        fixedMatter={{ value: h.matterId, label: h.matterTitle }}
        hearingId={h.id}
      />
    </div>
  );
}

function D({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-words">{children ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}
