import { type DashboardDto } from '@legalops/types';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Clock,
  IndianRupee,
  Plus,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { fullName, greeting, longDate, relativeTime } from '../../lib/format.js';
import { formatINR, isZero } from '../../lib/money.js';
import { HearingRow } from '../hearings/HearingRow.js';
import { TaskRow } from '../tasks/TaskRow.js';

/** "What needs my attention today?" (PRD §12). One request; role-aware on the server. */
export function DashboardPage() {
  const me = useSession();
  const navigate = useNavigate();
  const tz = me.organization.timezone;
  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardDto>('/dashboard'),
    refetchInterval: 5 * 60_000,
  });
  const showMoney = canAct(me, 'finance.dashboard');
  const canComplete = (assigneeId?: string) => canAct(me, 'tasks.manage') || assigneeId === me.user.id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{longDate(tz)}</p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting(tz)}, {me.user.firstName}
          </h1>
        </div>
        {canAct(me, 'matters.create') ? (
          <Button icon={<Plus className="size-4" />} onClick={() => navigate('/matters/new')}>
            Add matter
          </Button>
        ) : null}
      </div>

      {dash.isError ? (
        <Alert tone="danger">Couldn’t load your dashboard. It will retry automatically.</Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          icon={<CalendarDays />}
          label="Hearings today"
          value={dash.data?.counts.hearingsToday}
          to="/calendar"
        />
        <Stat
          icon={<CalendarClock />}
          label="Outcome needed"
          value={dash.data?.counts.pendingOutcomes}
          tone={dash.data?.counts.pendingOutcomes ? 'warning' : undefined}
          to="#pending"
        />
        <Stat
          icon={<CheckSquare />}
          label={dash.data?.scope === 'firm' ? 'Tasks due today' : 'My tasks today'}
          value={dash.data?.counts.tasksDueToday}
          to="/tasks"
        />
        <Stat
          icon={<AlertTriangle />}
          label="Overdue tasks"
          value={dash.data?.counts.overdueTasks}
          tone={dash.data?.counts.overdueTasks ? 'danger' : undefined}
          to="/tasks?view=overdue"
        />
      </div>
      {showMoney ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MoneyStat
            icon={<IndianRupee />}
            label="Outstanding"
            value={dash.data?.counts.outstanding}
            to="/billing"
          />
          <MoneyStat
            icon={<Clock />}
            label="Overdue amount"
            value={dash.data?.counts.overdueAmount}
            to="/billing/collections"
            danger
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Today’s hearings"
              action={
                <Link to="/calendar" className="text-sm font-medium text-brand-700 hover:underline">
                  Calendar
                </Link>
              }
            />
            {dash.isPending ? (
              <ListSkeleton />
            ) : dash.data && dash.data.hearingsToday.length ? (
              <div className="divide-y divide-line">
                {dash.data.hearingsToday.map((h) => (
                  <HearingRow key={h.id} hearing={h} today={dash.data.today} />
                ))}
              </div>
            ) : (
              <EmptyState icon={<CalendarDays />} title="No hearings today" />
            )}
          </Card>

          {dash.data && dash.data.pendingOutcomes.length ? (
            <Card id="pending" className="border-warning-200">
              <CardHeader
                title="Needs an outcome"
                description="These hearings have passed. Record what happened and the next date."
              />
              <div className="divide-y divide-line">
                {dash.data.pendingOutcomes.map((h) => (
                  <HearingRow key={h.id} hearing={h} today={dash.data.today} showDate />
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title={
                dash.data?.scope === 'firm' ? 'Tasks: overdue & due today' : 'My tasks: overdue & due today'
              }
            />
            {dash.isPending ? (
              <ListSkeleton />
            ) : dash.data && dash.data.overdueTasks.length + dash.data.tasksDueToday.length > 0 ? (
              <div className="divide-y divide-line">
                {[...dash.data.overdueTasks, ...dash.data.tasksDueToday].map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    today={dash.data.today}
                    canComplete={canComplete(t.assignee?.userId)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState icon={<CheckCircle2 />} title="You’re all caught up" />
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Next 7 days" />
            {dash.isPending ? (
              <ListSkeleton />
            ) : dash.data && dash.data.upcomingHearings.length ? (
              <div className="divide-y divide-line">
                {dash.data.upcomingHearings.map((h) => (
                  <HearingRow key={h.id} hearing={h} today={dash.data.today} showDate showMatter={false} />
                ))}
              </div>
            ) : (
              <EmptyState title="No hearings in the next week" />
            )}
          </Card>
          <Card>
            <CardHeader title="Recent changes" />
            {dash.data && dash.data.recentChanges.length ? (
              <ul className="divide-y divide-line">
                {dash.data.recentChanges.map((e) => (
                  <li key={e.id} className="px-4 py-2.5 sm:px-5">
                    <Link to={e.matter ? `/matters/${e.matter.id}?tab=timeline` : '#'} className="block">
                      <p className="truncate text-sm font-medium">{e.title}</p>
                      <p className="truncate text-xs text-muted">
                        {e.matter?.title} · {relativeTime(e.createdAt)}
                        {e.actor ? ` · ${fullName(e.actor)}` : ''}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing yet" />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  to,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: number | null | undefined;
  tone?: 'warning' | 'danger' | undefined;
  to?: string;
  hint?: string;
}) {
  const body = (
    <Card className="h-full p-4 transition-colors hover:bg-subtle">
      <div className="flex items-center gap-2 text-muted [&_svg]:size-4">
        {icon}
        <span className="truncate text-xs font-medium">{label}</span>
      </div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-8 w-10" />
      ) : (
        <p
          className={
            'mt-2 text-2xl font-semibold ' +
            (value === null
              ? 'text-ink-soft'
              : tone === 'danger'
                ? 'text-danger-700'
                : tone === 'warning'
                  ? 'text-warning-800'
                  : 'text-ink')
          }
          aria-label={value === null ? `${label}: not available yet` : `${label}: ${value}`}
        >
          {value === null ? '—' : value}
        </p>
      )}
      {hint ? <Badge className="mt-1">{hint}</Badge> : null}
    </Card>
  );
  if (!to) return body;
  return to.startsWith('#') ? <a href={to}>{body}</a> : <Link to={to}>{body}</Link>;
}

function MoneyStat({
  icon,
  label,
  value,
  to,
  danger,
}: {
  icon: ReactNode;
  label: string;
  value: string | null | undefined;
  to: string;
  danger?: boolean;
}) {
  const hot = danger && value != null && !isZero(value);
  return (
    <Link to={to}>
      <Card className="h-full p-4 transition-colors hover:bg-subtle">
        <div className="flex items-center gap-2 text-muted [&_svg]:size-4">
          {icon}
          <span className="truncate text-xs font-medium">{label}</span>
        </div>
        {value === undefined ? (
          <Skeleton className="mt-2 h-8 w-24" />
        ) : (
          <p className={`mt-2 text-xl font-semibold tabular-nums ${hot ? 'text-danger-700' : 'text-ink'}`}>
            {value === null ? '—' : formatINR(value, { whole: true })}
          </p>
        )}
      </Card>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}
