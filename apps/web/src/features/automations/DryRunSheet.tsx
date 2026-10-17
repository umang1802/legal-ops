import { OPERATOR_LABELS, type WorkflowDryRunDto, type WorkflowDto } from '@legalops/types';
import { Alert, Badge, Sheet, Skeleton } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';

/** "Test this automation" against the most recent real record, without sending anything. */
export function DryRunSheet({ workflow, onClose }: { workflow: WorkflowDto | null; onClose: () => void }) {
  const me = useSession();
  const q = useQuery({
    queryKey: ['workflows', workflow?.id, 'dry-run'],
    queryFn: () => api.post<WorkflowDryRunDto>(`/workflows/${workflow!.id}/dry-run`),
    enabled: Boolean(workflow),
    staleTime: 0,
    gcTime: 0,
  });
  const d = q.data;
  return (
    <Sheet open={Boolean(workflow)} onClose={onClose} title="Test automation">
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          What <strong>{workflow?.name}</strong> would do for your latest matching record. Nothing is sent.
        </p>
        {q.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : q.isError || !d ? (
          <Alert tone="danger">Couldn’t run the test.</Alert>
        ) : (
          <>
            {d.target ? (
              <p className="text-sm">
                Tested with: <strong>{d.target.label}</strong>
              </p>
            ) : null}
            {d.conditionResults.length ? (
              <ul className="space-y-1 text-sm">
                {d.conditionResults.map((c, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Badge tone={c.passed ? 'success' : 'danger'}>{c.passed ? 'Met' : 'Not met'}</Badge>
                    <span className="min-w-0 break-words">
                      {c.field} {OPERATOR_LABELS[c.operator]} {c.expected === null ? '' : String(c.expected)}
                      <span className="text-muted"> (is “{String(c.actual ?? '')}”)</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {d.plan.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {d.plan.map((p, i) => (
                  <li key={i} className={`px-3 py-2 text-sm ${p.inPast ? 'text-muted line-through' : ''}`}>
                    <p className="font-medium">{p.action}</p>
                    <p className="text-xs text-muted">
                      {formatDateTime(p.runAt, me.organization.timezone)} · {p.detail}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            {d.note ? <Alert tone="info">{d.note}</Alert> : null}
            {d.target && d.conditionsMet && d.plan.length && !d.note ? <Alert tone="success">This would run as planned.</Alert> : null}
            {d.target && !d.conditionsMet ? <Alert tone="warning">The conditions aren’t met for this record, so nothing would happen.</Alert> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}
