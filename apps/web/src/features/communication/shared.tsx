import { NOTIFICATION_STATUS_LABELS, SKIP_REASON_LABELS, type NotificationDto, type NotificationStatus } from '@legalops/types';
import { Badge, type Tone } from '@legalops/ui';
import { ChevronRight, Mail } from 'lucide-react';
import { formatDateTime, relativeTime } from '../../lib/format.js';

const TONE: Record<NotificationStatus, Tone> = {
  pending: 'neutral',
  awaiting_approval: 'warning',
  queued: 'info',
  sending: 'info',
  sent: 'success',
  delivered: 'success',
  bounced: 'danger',
  complained: 'danger',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
};

export function StatusBadge({ status }: { status: NotificationStatus }) {
  return <Badge tone={TONE[status]}>{NOTIFICATION_STATUS_LABELS[status]}</Badge>;
}

/** The one line that says what happened (or will) to this message. */
export function statusLine(n: NotificationDto, timeZone: string): string {
  if (n.status === 'sent' || n.status === 'delivered') return n.sentAt ? `Sent ${relativeTime(n.sentAt)}` : 'Sent';
  if (n.status === 'queued') {
    if (!n.scheduledAt || new Date(n.scheduledAt) <= new Date()) return n.attempts > 0 ? `Retrying (attempt ${n.attempts + 1})` : 'Sending shortly';
    return `Goes out ${formatDateTime(n.scheduledAt, timeZone)}`;
  }
  if (n.status === 'skipped') return SKIP_REASON_LABELS[n.skipReason ?? ''] ?? 'Not sent';
  if (n.status === 'cancelled') return n.skipReason ? (SKIP_REASON_LABELS[n.skipReason] ?? 'Cancelled') : 'Cancelled';
  if (n.status === 'failed' || n.status === 'bounced') return n.failureReason ?? 'Could not be delivered';
  if (n.status === 'awaiting_approval') return 'Waiting for someone to approve it';
  return NOTIFICATION_STATUS_LABELS[n.status];
}

export function recipientLabel(n: NotificationDto): string {
  const who = n.recipientName ?? n.client?.name ?? n.destination ?? 'Unknown';
  return n.recipientType === 'client' ? who : `${who} (team)`;
}

export function NotificationRow({ n, timeZone, onOpen, showMatter = true }: { n: NotificationDto; timeZone: string; onOpen: () => void; showMatter?: boolean }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-subtle sm:px-5">
      <Mail className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-medium">{n.subject ?? n.notificationType}</p>
          <StatusBadge status={n.status} />
        </div>
        <p className="truncate text-xs text-muted">
          To {recipientLabel(n)}
          {showMatter && n.matter ? ` · ${n.matter.title}` : ''}
        </p>
        <p className={`truncate text-xs ${n.status === 'failed' || n.status === 'bounced' ? 'text-danger-700' : 'text-muted'}`}>{statusLine(n, timeZone)}</p>
      </div>
      <ChevronRight className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
    </button>
  );
}
