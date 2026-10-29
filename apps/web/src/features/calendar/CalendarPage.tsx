import { seesAllMatters, type HearingDto } from '@legalops/types';
import { Alert, Button, Card, cn, EmptyState, SkeletonList } from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Printer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { canAct, hasFeature, useSession } from '../../lib/auth.js';
import { addDays, formatTime, fullName, relativeDay, todayIn } from '../../lib/format.js';
import { useMembers } from '../../lib/hooks.js';
import { HearingFormSheet } from '../hearings/HearingFormSheet.js';
import { HearingRow } from '../hearings/HearingRow.js';

type View = 'agenda' | 'month';

const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
const startOfWeek = (d: string) => addDays(d, -weekday(d));
const startOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
const monthLabel = (d: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${d}T00:00:00Z`),
  );
const shiftMonth = (d: string, n: number) => {
  const x = new Date(`${startOfMonth(d)}T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x.toISOString().slice(0, 10);
};

/** PRD Screen 10. Mobile defaults to an agenda list; month grid on wider screens. */
export function CalendarPage() {
  const me = useSession();
  const today = todayIn(me.organization.timezone);
  const members = useMembers();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches ? 'month' : 'agenda',
  );
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [lawyerId, setLawyerId] = useState('');
  const [scheduling, setScheduling] = useState(params.get('new') === '1');
  // Quick add can target the page you're already on: react to ?new=1, not just the first render.
  useEffect(() => {
    if (params.get('new') === '1') setScheduling(true);
  }, [params]);

  const range = useMemo(() => {
    // Agenda is a rolling 7 days from the anchor (opens on today), so today is always at the top.
    if (view === 'agenda') return { from: anchor, until: addDays(anchor, 6) };
    const from = startOfWeek(startOfMonth(anchor));
    return { from, until: addDays(from, 41) };
  }, [view, anchor]);

  const hearings = useQuery({
    queryKey: ['hearings', 'calendar', range, lawyerId],
    queryFn: () => api.get<HearingDto[]>(`/hearings${qs({ ...range, status: 'active', lawyerId })}`),
    placeholderData: keepPreviousData,
  });
  const byDate = useMemo(() => {
    const map = new Map<string, HearingDto[]>();
    for (const h of hearings.data ?? []) map.set(h.scheduledDate, [...(map.get(h.scheduledDate) ?? []), h]);
    return map;
  }, [hearings.data]);

  const days = Array.from({ length: view === 'agenda' ? 7 : 42 }, (_, i) => addDays(range.from, i));
  const step = (n: number) => setAnchor((a) => (view === 'agenda' ? addDays(a, 7 * n) : shiftMonth(a, n)));
  const shortDate = (d: string) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${d}T00:00:00Z`),
    );
  const title =
    view === 'agenda'
      ? range.from === today
        ? 'Next 7 days'
        : `${shortDate(range.from)} – ${shortDate(range.until)}`
      : monthLabel(anchor);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Calendar</h1>
        <div className="flex flex-wrap gap-2">
          {/* Reading, not editing: available to everyone who can see the calendar, including suspended firms. */}
          {hasFeature(me, 'diary') ? (
            <Link to="/diary" target="_blank">
              <Button variant="secondary" icon={<Printer className="size-4" />}>
                Print diary
              </Button>
            </Link>
          ) : null}
          {canAct(me, 'hearings.manage') ? (
            <Button icon={<Plus className="size-4" />} onClick={() => setScheduling(true)}>
              Schedule hearing
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-line bg-surface">
          <button
            type="button"
            aria-label="Previous"
            onClick={() => step(-1)}
            className="grid size-10 place-items-center text-ink-soft hover:bg-subtle"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-36 px-2 text-center text-sm font-semibold">{title}</span>
          <button
            type="button"
            aria-label="Next"
            onClick={() => step(1)}
            className="grid size-10 place-items-center text-ink-soft hover:bg-subtle"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setAnchor(today);
            setSelected(today);
          }}
        >
          Today
        </Button>
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="View">
          {(['agenda', 'month'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                'h-9 rounded-md px-3 text-sm font-medium capitalize',
                view === v ? 'bg-brand-700 text-white' : 'text-ink-soft',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        {seesAllMatters(me.role) ? (
          <select
            aria-label="Lawyer"
            value={lawyerId}
            onChange={(e) => setLawyerId(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface px-2 text-sm"
          >
            <option value="">All lawyers</option>
            {(members.data ?? [])
              .filter((m) => m.status === 'active' && ['owner', 'admin', 'lawyer'].includes(m.role))
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {fullName(m)}
                </option>
              ))}
          </select>
        ) : null}
      </div>

      {hearings.isPending ? (
        <SkeletonList rows={5} />
      ) : hearings.isError ? (
        <Alert tone="danger">Couldn’t load hearings.</Alert>
      ) : view === 'agenda' ? (
        <div className={cn('space-y-4', hearings.isFetching && 'opacity-70')}>
          {days.map((d) => {
            const list = byDate.get(d) ?? [];
            return (
              <section key={d} aria-label={relativeDay(d, today)}>
                <h2
                  className={cn(
                    'mb-1.5 text-sm font-semibold',
                    d === today ? 'text-brand-700' : 'text-ink-soft',
                  )}
                >
                  {relativeDay(d, today)}
                  {list.length ? (
                    <span className="ml-2 font-normal text-muted">
                      {list.length} hearing{list.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </h2>
                {list.length ? (
                  <Card className="divide-y divide-line">
                    {list.map((h) => (
                      <HearingRow key={h.id} hearing={h} today={today} />
                    ))}
                  </Card>
                ) : (
                  <p className="rounded-lg border border-dashed border-line px-4 py-2.5 text-sm text-muted">
                    No hearings
                  </p>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className={cn('space-y-4', hearings.isFetching && 'opacity-70')}>
          <Card className="overflow-hidden">
            <div className="grid grid-cols-7 border-b border-line bg-subtle text-center text-xs font-medium text-muted">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const list = byDate.get(d) ?? [];
                const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
                const pending = list.some((h) => h.pendingOutcome);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSelected(d)}
                    aria-label={`${relativeDay(d, today)}: ${list.length} hearings`}
                    aria-pressed={selected === d}
                    className={cn(
                      'flex min-h-14 min-w-0 flex-col items-stretch gap-0.5 border-r border-b border-line p-1 text-left last:border-r-0 sm:min-h-24 sm:p-1.5',
                      !inMonth && 'bg-subtle/60 text-muted',
                      selected === d && 'ring-2 ring-brand-600 ring-inset',
                    )}
                  >
                    <span
                      className={cn(
                        'grid size-6 place-items-center self-start rounded-full text-xs font-medium',
                        d === today && 'bg-brand-700 text-white',
                      )}
                    >
                      {Number(d.slice(8))}
                    </span>
                    {/* Phones: a count chip. Larger screens: the first hearings by time. */}
                    {list.length ? (
                      <span
                        className={cn(
                          'self-start rounded px-1 text-[11px] font-semibold sm:hidden',
                          pending ? 'bg-warning-50 text-warning-800' : 'bg-brand-50 text-brand-800',
                        )}
                      >
                        {list.length}
                      </span>
                    ) : null}
                    <span className="hidden space-y-0.5 sm:block">
                      {list.slice(0, 2).map((h) => (
                        <span
                          key={h.id}
                          className={cn(
                            'block truncate rounded px-1 text-[11px]',
                            h.pendingOutcome
                              ? 'bg-warning-50 text-warning-800'
                              : 'bg-brand-50 text-brand-800',
                          )}
                        >
                          {h.startTime ? `${formatTime(h.startTime)} ` : ''}
                          {h.caseNumber ?? h.matterTitle}
                        </span>
                      ))}
                      {list.length > 2 ? (
                        <span className="block px-1 text-[11px] text-muted">+{list.length - 2} more</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
          <section>
            <h2 className="mb-2 text-sm font-semibold">{relativeDay(selected, today)}</h2>
            {(byDate.get(selected) ?? []).length ? (
              <Card className="divide-y divide-line">
                {(byDate.get(selected) ?? []).map((h) => (
                  <HearingRow key={h.id} hearing={h} today={today} />
                ))}
              </Card>
            ) : (
              <Card>
                <EmptyState icon={<CalendarDays />} title="No hearings this day" />
              </Card>
            )}
          </section>
        </div>
      )}

      <HearingFormSheet
        open={scheduling}
        onClose={() => {
          setScheduling(false);
          if (params.has('new')) setParams({}, { replace: true });
        }}
        defaultDate={view === 'month' ? selected : today}
      />
    </>
  );
}
