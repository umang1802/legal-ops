import {
  CASE_STATUS_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  type DocumentDto,
  HEARING_STATUS_LABELS,
  MATTER_STAFF_ROLE_LABELS,
  MATTER_STATUS_LABELS,
  type HearingDto,
  type MatterDetailDto,
  type TimelineEventDto,
} from '@legalops/types';
import { Alert } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { PrintShell } from '../../components/print/PrintShell.js';
import { api, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { formatDate, formatTime, fullName } from '../../lib/format.js';

/** Every timeline entry for a matter (the API pages at 100; a long matter's history must still print in full). */
async function fetchAllTimeline(matterId: string): Promise<TimelineEventDto[]> {
  const all: TimelineEventDto[] = [];
  for (let page = 1; page <= 50; page++) {
    const { items, meta } = await api.getPage<TimelineEventDto>(`/matters/${matterId}/timeline${qs({ page, pageSize: 100 })}`);
    all.push(...items);
    if (page * meta.pageSize >= meta.total) break;
  }
  return all;
}

/** Printable matter history (internal: includes team notes). /matters/:matterId/history */
export function MatterHistoryPrintPage() {
  const { matterId = '' } = useParams();
  const me = useSession();
  const tz = me.organization.timezone;
  const matter = useQuery({ queryKey: ['matter', matterId], queryFn: () => api.get<MatterDetailDto>(`/matters/${matterId}`) });
  const hearings = useQuery({
    queryKey: ['hearings', 'matter', matterId, 'all'],
    queryFn: () => api.get<HearingDto[]>(`/hearings${qs({ matterId })}`),
  });
  const docs = useQuery({
    queryKey: ['documents', 'matter', matterId, 'print'],
    queryFn: () => api.get<DocumentDto[]>(`/documents${qs({ matterId })}`),
    retry: false, // users without documents.view get a 403: just leave the section out
    enabled: canAct(me, 'documents.view'), // and when the firm's Documents feature is off
  });
  const timeline = useQuery({ queryKey: ['matter', matterId, 'timeline', 'all'], queryFn: () => fetchAllTimeline(matterId) });

  // A disabled query stays pending, so it only holds up printing when it's actually loading.
  const ready = !matter.isPending && !hearings.isPending && !timeline.isPending && !docs.isLoading;
  const m = matter.data;
  const record = [...(hearings.data ?? [])].filter((h) => h.status !== 'scheduled' || h.pendingOutcome).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  const upcoming = (hearings.data ?? []).filter((h) => h.status === 'scheduled' && !h.pendingOutcome).sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  const events = [...(timeline.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <PrintShell title="Matter history" ready={ready} wide>
      <div className="mb-6 print:hidden">
        <Link to={`/matters/${matterId}`} className="text-sm text-brand-700 hover:underline">
          ← Back to the matter
        </Link>
      </div>

      {matter.isError || !m ? (
        <Alert tone="danger">This matter couldn’t be loaded.</Alert>
      ) : (
        <>
          <header className="border-b border-gray-400 pb-3">
            <p className="text-base font-semibold">{me.organization.name}</p>
            <h1 className="text-xl font-semibold">Matter history · {m.title}</h1>
            <p className="mt-1 text-xs text-gray-700">
              {[m.referenceCode, `Client: ${m.client.name}`, m.practiceArea, MATTER_STATUS_LABELS[m.status]].filter(Boolean).join(' · ')}
            </p>
            <p className="text-xs text-gray-700">
              Team: {m.staff.map((s) => `${fullName(s)} (${MATTER_STAFF_ROLE_LABELS[s.role]})`).join(', ') || '—'}
              {m.startDate ? ` · Opened ${formatDate(m.startDate)}` : ''}
              {m.closeDate ? ` · Closed ${formatDate(m.closeDate)}` : ''}
            </p>
          </header>

          <Section title={`Cases (${m.cases.length})`}>
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <Row head cells={['Case no.', 'CNR', 'Court', 'Parties', 'Status', 'Next hearing']} />
              </thead>
              <tbody>
                {m.cases.map((c) => (
                  <Row
                    key={c.id}
                    cells={[c.caseNumber ?? '—', c.cnr ?? '—', c.court?.name ?? '—', c.title, CASE_STATUS_LABELS[c.status], c.nextHearingDate ? formatDate(c.nextHearingDate) : '—']}
                  />
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={`Hearing record (${record.length})`}>
            {record.length === 0 ? (
              <p className="text-gray-600">No hearings held yet.</p>
            ) : (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <Row head cells={['Date', 'Case', 'Result', 'Internal note', 'Update for client', 'Next date']} />
                </thead>
                <tbody>
                  {record.map((h) => (
                    <Row
                      key={h.id}
                      cells={[
                        `${formatDate(h.scheduledDate)}${h.startTime ? ` ${formatTime(h.startTime)}` : ''}`,
                        h.caseNumber ?? h.caseTitle,
                        h.pendingOutcome ? 'Outcome not recorded' : HEARING_STATUS_LABELS[h.status],
                        h.status === 'cancelled' ? (h.cancelReason ?? '—') : (h.outcome ?? '—'),
                        h.clientSummary ?? (h.status === 'completed' || h.status === 'adjourned' ? '(neutral update)' : '—'),
                        h.nextHearingDate ? formatDate(h.nextHearingDate) : '—',
                      ]}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {upcoming.length ? (
              <p className="mt-2 text-xs text-gray-700">
                Upcoming: {upcoming.map((h) => `${formatDate(h.scheduledDate)} (${h.caseNumber ?? h.caseTitle})`).join(', ')}
              </p>
            ) : null}
          </Section>

          {docs.data ? (
            <Section title={`Documents (${docs.data.length})`}>
              {docs.data.length === 0 ? (
                <p className="text-gray-600">No documents uploaded.</p>
              ) : (
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <Row head cells={['Document', 'Category', 'Case / hearing', 'Uploaded']} />
                  </thead>
                  <tbody>
                    {docs.data.map((d) => (
                      <Row
                        key={d.id}
                        cells={[
                          d.name,
                          DOCUMENT_CATEGORY_LABELS[d.category],
                          [d.caseNumber, d.hearingDate ? `hearing ${formatDate(d.hearingDate)}` : null].filter(Boolean).join(' · ') || '—',
                          `${d.uploadedAt ? formatDate(d.uploadedAt.slice(0, 10)) : '—'}${d.uploadedBy ? ` · ${fullName(d.uploadedBy)}` : ''}`,
                        ]}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          ) : null}

          <Section title={`Activity (${events.length})`}>
            {events.length === 0 ? (
              <p className="text-gray-600">No activity yet.</p>
            ) : (
              <ol className="space-y-1.5 text-[11px]">
                {events.map((e) => (
                  <li key={e.id} className="grid break-inside-avoid grid-cols-[9.5rem_1fr] gap-3 border-b border-gray-100 pb-1.5">
                    <span className="text-gray-600 tabular-nums">
                      {new Date(e.createdAt).toLocaleString('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span>
                      <span className="font-medium">{e.title}</span>
                      {e.description ? <span className="text-gray-700"> · {e.description}</span> : null}
                      <span className="text-gray-500"> · {e.actor ? fullName(e.actor) : e.actorType === 'workflow' ? 'Automation' : 'System'}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <footer className="mt-8 border-t border-gray-300 pt-2 text-[10px] text-gray-600">
            Internal: contains team notes, not for clients. Printed from LexForgeX on {new Date().toLocaleString('en-IN', { timeZone: tz })}.
          </footer>
        </>
      )}
    </PrintShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

function Row({ cells, head = false }: { cells: ReactNode[]; head?: boolean }) {
  const Cell = head ? 'th' : 'td';
  return (
    <tr className={`break-inside-avoid align-top ${head ? 'border-y border-gray-400 text-left' : 'border-b border-gray-200'}`}>
      {cells.map((c, i) => (
        <Cell key={i} scope={head ? 'col' : undefined} className={`px-1.5 py-1 ${head ? 'font-semibold' : ''}`}>
          {c}
        </Cell>
      ))}
    </tr>
  );
}
