import type { NotificationDetailDto } from '@legalops/types';
import { Alert, Button, Sheet, Skeleton } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useCan, useSession } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';
import { recipientLabel, statusLine, StatusBadge } from './shared.js';

/** One message: exactly what was (or will be) sent, why, and the human actions on it. */
export function NotificationSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const me = useSession();
  const tz = me.organization.timezone;
  const canAct = useCan('matters.edit');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', 'detail', id],
    queryFn: () => api.get<NotificationDetailDto>(`/notifications/${id}`),
    enabled: Boolean(id),
  });
  const act = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'retry') => api.post<NotificationDetailDto>(`/notifications/${id}/${action}`),
    onSuccess: (n) => {
      qc.setQueryData(['notifications', 'detail', id], n);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const n = q.data;

  const footer =
    n && canAct ? (
      n.status === 'awaiting_approval' ? (
        <div className="flex gap-2 sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" loading={act.isPending && act.variables === 'reject'} onClick={() => act.mutate('reject')}>
            Don’t send
          </Button>
          <Button block className="sm:w-auto" loading={act.isPending && act.variables === 'approve'} onClick={() => act.mutate('approve')}>
            Approve and send
          </Button>
        </div>
      ) : n.status === 'failed' ? (
        <div className="flex sm:justify-end">
          <Button block className="sm:w-auto" loading={act.isPending} onClick={() => act.mutate('retry')}>
            Try again
          </Button>
        </div>
      ) : n.status === 'queued' && new Date(n.scheduledAt ?? 0) > new Date() ? (
        <div className="flex sm:justify-end">
          <Button variant="secondary" block className="sm:w-auto" loading={act.isPending} onClick={() => act.mutate('reject')}>
            Cancel this message
          </Button>
        </div>
      ) : undefined
    ) : undefined;

  return (
    <Sheet open={Boolean(id)} onClose={onClose} title="Message" footer={footer}>
      {q.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.isError || !n ? (
        <Alert tone="danger">Couldn’t load this message.</Alert>
      ) : (
        <div className="space-y-4">
          {act.error ? <Alert tone="danger">{act.error instanceof ApiError ? act.error.message : 'Something went wrong.'}</Alert> : null}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={n.status} />
              <span className="text-sm text-ink-soft">{statusLine(n, tz)}</span>
            </div>
            <p className="text-base font-semibold">{n.subject}</p>
          </div>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted">To</dt>
            <dd className="min-w-0 break-words">
              {recipientLabel(n)}
              {n.destination ? <span className="block text-xs text-muted">{n.destination}</span> : null}
            </dd>
            {n.matter ? (
              <>
                <dt className="text-muted">Matter</dt>
                <dd className="min-w-0 truncate">
                  <Link className="text-brand-700 hover:underline" to={`/matters/${n.matter.id}`} onClick={onClose}>
                    {n.matter.title}
                  </Link>
                </dd>
              </>
            ) : null}
            <dt className="text-muted">Sent by</dt>
            <dd>{n.workflow ? `Automation: ${n.workflow.name}` : n.createdBy ? `${n.createdBy.firstName} ${n.createdBy.lastName ?? ''}` : 'System'}</dd>
            <dt className="text-muted">Created</dt>
            <dd>{formatDateTime(n.createdAt, tz)}</dd>
            {n.attempts > 0 ? (
              <>
                <dt className="text-muted">Attempts</dt>
                <dd>{n.attempts}</dd>
              </>
            ) : null}
          </dl>
          {n.sensitive ? (
            <Alert tone="info">This is a security email. Its link is created when it is sent and is never stored, so it isn’t shown here.</Alert>
          ) : null}
          {n.bodyHtml ? (
            // Sandboxed: no scripts, no same-origin access. The HTML was sanitised server-side too.
            <iframe title="Message content" sandbox="" srcDoc={n.bodyHtml} className="h-72 w-full rounded-lg border border-line bg-white" />
          ) : (
            <pre className="whitespace-pre-wrap rounded-lg border border-line p-3 text-sm">{n.bodyText}</pre>
          )}
        </div>
      )}
    </Sheet>
  );
}
