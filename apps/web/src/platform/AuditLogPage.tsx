import type { PlatformAuditEntry } from '@legalops/types';
import { EmptyState, PageHeader, SkeletonList } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { platformApi } from './api.js';

export function AuditLogPage() {
  const q = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => platformApi.page<PlatformAuditEntry>('/audit-logs?pageSize=100'),
  });
  return (
    <>
      <PageHeader title="Audit log" description="Every action taken in the platform console." />
      {q.isPending ? (
        <SkeletonList rows={6} />
      ) : !q.data?.items.length ? (
        <EmptyState title="Nothing yet" />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
          {q.data.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <span>
                <span className="font-medium">{a.action}</span>
                {a.organizationId ? (
                  <>
                    {' '}
                    ·{' '}
                    <Link
                      className="text-brand-700 hover:underline"
                      to={`/platform/firms/${a.organizationId}`}
                    >
                      {a.organizationName}
                    </Link>
                  </>
                ) : null}
              </span>
              <span className="text-muted">
                {a.adminName} ·{' '}
                {new Date(a.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
