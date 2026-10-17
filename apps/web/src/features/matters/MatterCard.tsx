import { MATTER_STATUS_LABELS, PRIORITY_LABELS, type MatterListItemDto } from '@legalops/types';
import { Badge } from '@legalops/ui';
import { CalendarDays, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { formatDate, fullName } from '../../lib/format.js';
import { MATTER_STATUS_TONE, PRIORITY_TONE } from '../../lib/status.js';

/** One matter row. Card on phones, aligned columns from sm up (PRD Screen 6 card fields). */
export function MatterCard({ matter: m, hideClient }: { matter: MatterListItemDto; hideClient?: boolean }) {
  const identifiers = m.primaryCase
    ? [m.primaryCase.caseNumber, m.primaryCase.cnr, m.primaryCase.courtName].filter(Boolean).join(' · ')
    : 'No case added yet';
  return (
    <Link to={`/matters/${m.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-semibold">{m.title}</p>
          {m.status !== 'active' ? (
            <Badge tone={MATTER_STATUS_TONE[m.status]}>{MATTER_STATUS_LABELS[m.status]}</Badge>
          ) : null}
          {m.priority === 'high' || m.priority === 'urgent' ? (
            <Badge tone={PRIORITY_TONE[m.priority]}>{PRIORITY_LABELS[m.priority]}</Badge>
          ) : null}
        </div>
        {!hideClient ? <p className="truncate text-sm text-ink-soft">{m.client.name}</p> : null}
        <p className="truncate text-xs text-muted">
          {identifiers}
          {m.caseCount > 1 ? ` · +${m.caseCount - 1} more` : ''}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3.5" aria-hidden />
            {m.nextHearingDate ? `Next hearing ${formatDate(m.nextHearingDate)}` : 'No upcoming hearing'}
          </span>
          {m.lead ? (
            <span>Lead: {fullName(m.lead)}</span>
          ) : (
            <span className="text-warning-800">No lead lawyer</span>
          )}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
    </Link>
  );
}
