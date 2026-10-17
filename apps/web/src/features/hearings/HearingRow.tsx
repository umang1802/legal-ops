import { HEARING_STATUS_LABELS, type HearingDto } from '@legalops/types';
import { Badge } from '@legalops/ui';
import { ChevronRight, Clock } from 'lucide-react';
import { Link } from 'react-router';
import { formatTime, fullName, relativeDay } from '../../lib/format.js';
import { hearingTone } from '../../lib/status.js';

/** One hearing in a list. `showDate` for mixed-date lists (dashboard upcoming, matter tab). */
export function HearingRow({
  hearing: h,
  today,
  showDate,
  showMatter = true,
}: {
  hearing: HearingDto;
  today: string;
  showDate?: boolean;
  showMatter?: boolean;
}) {
  return (
    <Link to={`/hearings/${h.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5">
      <div className="w-16 shrink-0 text-center">
        {showDate ? (
          <p className="text-xs font-semibold text-ink-soft">
            {relativeDay(h.scheduledDate, today, { short: true })}
          </p>
        ) : null}
        <p className="text-sm font-semibold text-brand-700">{h.startTime ? formatTime(h.startTime) : '—'}</p>
        {h.courtroom ? <p className="text-xs text-muted">Room {h.courtroom}</p> : null}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate text-sm font-semibold">{h.caseNumber ?? h.caseTitle}</p>
          {h.pendingOutcome ? (
            <Badge tone="warning">
              <Clock className="size-3" aria-hidden /> Outcome needed
            </Badge>
          ) : h.status !== 'scheduled' ? (
            <Badge tone={hearingTone(h)}>{HEARING_STATUS_LABELS[h.status]}</Badge>
          ) : null}
        </div>
        {showMatter ? <p className="truncate text-sm text-ink-soft">{h.matterTitle}</p> : null}
        <p className="truncate text-xs text-muted">
          {[h.courtName, h.hearingType, h.lead ? `Lead: ${fullName(h.lead)}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
    </Link>
  );
}
