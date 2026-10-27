import type { OrganizationStatus, PlatformFirmSummary } from '@legalops/types';
import { Badge, Button, EmptyState, PageHeader, SearchInput, SkeletonList, type Tone } from '@legalops/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { qs } from '../lib/api.js';
import { platformApi } from './api.js';
import { InviteFirmSheet } from './InviteFirmSheet.js';

export const STATUS: Record<OrganizationStatus, { label: string; tone: Tone }> = {
  invited: { label: 'Invited', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'danger' },
};
const when = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export function FirmsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<OrganizationStatus | ''>('');
  const [inviting, setInviting] = useState(false);
  const q = useQuery({
    queryKey: ['platform', 'firms', search, status],
    queryFn: () => platformApi.page<PlatformFirmSummary>(`/firms${qs({ search, status, pageSize: 100 })}`),
  });
  return (
    <>
      <PageHeader
        title="Firms"
        description="Every firm on LexForgeX."
        actions={<Button onClick={() => setInviting(true)}>Invite firm</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <SearchInput
          className="min-w-0 flex-1"
          placeholder="Search firms"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="rounded-lg border border-line bg-surface px-3 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as OrganizationStatus | '')}
        >
          <option value="">All statuses</option>
          <option value="invited">Invited</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      {q.isPending ? (
        <SkeletonList rows={5} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No firms yet" description="Invite a firm once their payment is settled." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2">Firm</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2 text-right">Users</th>
                <th className="px-4 py-2 text-right">Cases</th>
                <th className="px-4 py-2">Last active</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((f) => (
                <tr key={f.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <Link
                      className="font-medium text-brand-700 hover:underline"
                      to={`/platform/firms/${f.id}`}
                    >
                      {f.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {f.ownerEmail ??
                      (f.inviteEmail ? <span className="text-muted">Invited: {f.inviteEmail}</span> : '—')}
                  </td>
                  <td className="px-4 py-3 text-right">{f.userCount}</td>
                  <td className="px-4 py-3 text-right">{f.caseCount}</td>
                  <td className="px-4 py-3">{when(f.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <InviteFirmSheet open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}
