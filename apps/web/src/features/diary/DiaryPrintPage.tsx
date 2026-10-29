import { HEARING_STATUS_LABELS, seesAllMatters, type DiaryDto, type DiaryRowDto } from '@legalops/types';
import { Alert } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PrintShell } from '../../components/print/PrintShell.js';
import { api, qs } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { addDays, formatDate, formatTime, fullName, todayIn } from '../../lib/format.js';

type Column = { key: string; header: string; className?: string; cell: (row: DiaryRowDto, index: number) => ReactNode };

/**
 * The diary's columns, in print order. To add a column (e.g. bench, opposing counsel), add one entry here; the diary API
 * already returns the full hearing record plus its previous hearing.
 */
export const DIARY_COLUMNS: Column[] = [
  { key: 'n', header: '#', className: 'w-6 text-right tabular-nums', cell: (_r, i) => i + 1 },
  { key: 'time', header: 'Time', className: 'w-16 whitespace-nowrap tabular-nums', cell: (r) => (r.startTime ? formatTime(r.startTime) : '—') },
  { key: 'room', header: 'Court room', className: 'w-14', cell: (r) => r.courtroom ?? '—' },
  {
    key: 'case',
    header: 'Case no. / CNR',
    className: 'w-36',
    cell: (r) => (
      <>
        <span className="font-semibold">{r.caseNumber ?? '—'}</span>
        {r.cnr ? <span className="block text-[10px] text-gray-600">{r.cnr}</span> : null}
      </>
    ),
  },
  { key: 'parties', header: 'Parties', cell: (r) => r.caseTitle },
  { key: 'client', header: 'Client', className: 'w-28', cell: (r) => r.clientName },
  { key: 'purpose', header: 'Purpose', className: 'w-24', cell: (r) => r.hearingType ?? '—' },
  { key: 'lead', header: 'Lead', className: 'w-24', cell: (r) => (r.lead ? fullName(r.lead) : '—') },
  {
    key: 'last',
    header: 'Last date · what happened',
    className: 'w-56',
    cell: (r) =>
      r.previous ? (
        <>
          <span className="font-medium">
            {formatDate(r.previous.date)} · {HEARING_STATUS_LABELS[r.previous.result]}
          </span>
          {r.previous.outcome ? <span className="block text-gray-700">{r.previous.outcome}</span> : null}
        </>
      ) : (
        <span className="text-gray-600">First listing</span>
      ),
  },
];

/** Printable daily hearings board (internal: includes team notes). /diary?date=YYYY-MM-DD&scope=all|mine */
export function DiaryPrintPage() {
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const tomorrow = addDays(todayIn(me.organization.timezone), 1);
  const date = params.get('date') ?? tomorrow;
  const canSeeAll = seesAllMatters(me.role);
  const scope = canSeeAll && params.get('scope') === 'mine' ? 'mine' : 'all';

  const q = useQuery({
    queryKey: ['diary', date, scope],
    queryFn: () => api.get<DiaryDto>(`/hearings/diary${qs({ date, scope })}`),
  });

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  const groups = new Map<string, DiaryRowDto[]>();
  for (const r of q.data?.rows ?? []) {
    const court = r.courtName ?? 'Court not set';
    groups.set(court, [...(groups.get(court) ?? []), r]);
  }
  const scopeLabel = scope === 'mine' ? 'My matters' : canSeeAll ? 'All firm matters' : 'My assigned matters';

  return (
    <PrintShell title="Hearings diary" ready={!q.isPending} wide>
      <div className="mb-6 flex flex-wrap items-end gap-3 print:hidden">
        <Link to="/calendar" className="mr-auto text-sm text-brand-700 hover:underline">
          ← Calendar
        </Link>
        <label className="text-sm">
          <span className="block text-xs text-gray-600">Date</span>
          <input type="date" value={date} onChange={(e) => e.target.value && set('date', e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5" />
        </label>
        {canSeeAll ? (
          <label className="text-sm">
            <span className="block text-xs text-gray-600">Show</span>
            <select value={scope} onChange={(e) => set('scope', e.target.value)} className="rounded-md border border-gray-300 px-2 py-1.5">
              <option value="all">All firm matters</option>
              <option value="mine">Only my matters</option>
            </select>
          </label>
        ) : null}
      </div>

      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-gray-400 pb-3">
        <div>
          <p className="text-base font-semibold">{me.organization.name}</p>
          <h1 className="text-xl font-semibold">Hearings diary · {formatDate(date, { weekday: true })}</h1>
        </div>
        <p className="text-xs text-gray-600">
          {scopeLabel} · {q.data?.rows.length ?? 0} hearing{q.data?.rows.length === 1 ? '' : 's'}
        </p>
      </header>

      {q.isError ? (
        <div className="mt-4">
          <Alert tone="danger">The diary couldn’t be loaded. Refresh to try again.</Alert>
        </div>
      ) : !q.data?.rows.length ? (
        <p className="py-10 text-center text-gray-600">No hearings listed for this day.</p>
      ) : (
        [...groups.entries()].map(([court, rows]) => (
          <section key={court} className="mt-5 break-inside-avoid-page">
            <h2 className="mb-1.5 text-sm font-semibold uppercase tracking-wide">
              {court} <span className="font-normal normal-case text-gray-600">({rows.length})</span>
            </h2>
            <table className="w-full border-collapse text-[11px] leading-snug">
              <thead>
                <tr className="border-y border-gray-400 text-left">
                  {DIARY_COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className={`px-1.5 py-1 font-semibold ${c.className ?? ''}`}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="break-inside-avoid border-b border-gray-200 align-top">
                    {DIARY_COLUMNS.map((c) => (
                      <td key={c.key} className={`px-1.5 py-1.5 ${c.className ?? ''}`}>
                        {c.cell(r, i)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}

      <footer className="mt-8 border-t border-gray-300 pt-2 text-[10px] text-gray-600">
        Internal: contains team notes, not for clients. Printed from LexForgeX on {new Date().toLocaleString('en-IN', { timeZone: me.organization.timezone })}.
      </footer>
    </PrintShell>
  );
}
