import { HEARING_STATUS_LABELS, seesAllMatters, type DiaryMonthDto, type HearingDto } from '@legalops/types';
import { Alert } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { FirmLogo } from '../../components/branding/FirmLogo.js';
import { PrintShell } from '../../components/print/PrintShell.js';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDate, formatTime, fullName, todayIn } from '../../lib/format.js';

const monthTitle = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, m! - 1, 1)),
  );
};

/** Printable month diary (internal): every hearing in the month, day by day. /diary/month?month=YYYY-MM&scope=all|mine */
export function DiaryMonthPrintPage() {
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month') ?? '')
    ? params.get('month')!
    : todayIn(me.organization.timezone).slice(0, 7);
  const canSeeAll = seesAllMatters(me.role);
  const scope = canSeeAll && params.get('scope') === 'mine' ? 'mine' : 'all';

  const q = useQuery({
    queryKey: ['diary-month', month, scope],
    queryFn: () => api.get<DiaryMonthDto>(`/hearings/diary/month${qs({ month, scope })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  const days = new Map<string, HearingDto[]>();
  for (const h of q.data?.rows ?? []) days.set(h.scheduledDate, [...(days.get(h.scheduledDate) ?? []), h]);
  const total = q.data?.rows.length ?? 0;
  const scopeLabel = scope === 'mine' ? 'My matters' : canSeeAll ? 'All firm matters' : 'My assigned matters';

  return (
    <PrintShell title="Month diary" ready={!q.isPending} wide>
      {/* A month is a wide table: print it sideways. */}
      <style>{`@page { size: A4 landscape; margin: 10mm }`}</style>
      <div className="mb-6 flex flex-wrap items-end gap-3 print:hidden">
        <Link to="/calendar" className="mr-auto text-sm text-brand-700 hover:underline">
          ← Calendar
        </Link>
        <Link to={`/diary?date=${month}-01`} className="text-sm text-brand-700 hover:underline">
          Day view
        </Link>
        <label className="text-sm">
          <span className="block text-xs text-gray-600">Month</span>
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && set('month', e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5"
          />
        </label>
        {canSeeAll ? (
          <label className="text-sm">
            <span className="block text-xs text-gray-600">Show</span>
            <select
              value={scope}
              onChange={(e) => set('scope', e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1.5"
            >
              <option value="all">All firm matters</option>
              <option value="mine">Only my matters</option>
            </select>
          </label>
        ) : null}
      </div>

      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-gray-400 pb-3">
        <div>
          <FirmLogo
            name={me.organization.name}
            logoUrl={me.organization.logoUrl}
            className="mb-1 max-h-10 max-w-48"
          />
          <p className="text-base font-semibold">{me.organization.name}</p>
          <h1 className="text-xl font-semibold">Hearings diary · {monthTitle(month)}</h1>
        </div>
        <p className="text-xs text-gray-600">
          {scopeLabel} · {total} hearing{total === 1 ? '' : 's'} on {days.size} day
          {days.size === 1 ? '' : 's'}
        </p>
      </header>

      {q.isError ? (
        <div className="mt-4">
          <Alert tone="danger">The diary couldn’t be loaded. Refresh to try again.</Alert>
        </div>
      ) : total === 0 ? (
        <p className="py-10 text-center text-gray-600">No hearings listed for {monthTitle(month)}.</p>
      ) : (
        <table className="mt-4 w-full border-collapse text-[11px] leading-snug">
          <thead>
            <tr className="border-y border-gray-400 text-left">
              {[
                'Time',
                'Court / room',
                'Case no. / CNR',
                'Parties',
                'Client',
                'Purpose',
                'Lead',
                'Status',
              ].map((h) => (
                <th key={h} scope="col" className="px-1.5 py-1 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          {[...days.entries()].map(([date, rows]) => (
            <tbody key={date} className="break-inside-avoid-page">
              <tr className="bg-gray-100 print:bg-gray-100">
                <th colSpan={8} scope="colgroup" className="px-1.5 py-1 text-left text-xs font-semibold">
                  {formatDate(date, { weekday: true })}{' '}
                  <span className="font-normal text-gray-600">({rows.length})</span>
                </th>
              </tr>
              {rows.map((h) => (
                <tr key={h.id} className="break-inside-avoid border-b border-gray-200 align-top">
                  <td className="w-16 px-1.5 py-1.5 whitespace-nowrap tabular-nums">
                    {h.startTime ? formatTime(h.startTime) : '—'}
                  </td>
                  <td className="w-36 px-1.5 py-1.5">
                    {h.courtName ?? '—'}
                    {h.courtroom ? <span className="block text-gray-600">Room {h.courtroom}</span> : null}
                  </td>
                  <td className="w-36 px-1.5 py-1.5">
                    <span className="font-semibold">{h.caseNumber ?? '—'}</span>
                    {h.cnr ? <span className="block text-[10px] text-gray-600">{h.cnr}</span> : null}
                  </td>
                  <td className="px-1.5 py-1.5">{h.caseTitle}</td>
                  <td className="w-32 px-1.5 py-1.5">{h.clientName}</td>
                  <td className="w-28 px-1.5 py-1.5">{h.hearingType ?? '—'}</td>
                  <td className="w-28 px-1.5 py-1.5">{h.lead ? fullName(h.lead) : '—'}</td>
                  <td className="w-20 px-1.5 py-1.5">{HEARING_STATUS_LABELS[h.status]}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}

      <footer className="mt-8 border-t border-gray-300 pt-2 text-[10px] text-gray-600">
        Internal: not for clients. Printed from LexForgeX on{' '}
        {new Date().toLocaleString('en-IN', { timeZone: me.organization.timezone })}.
      </footer>
    </PrintShell>
  );
}
