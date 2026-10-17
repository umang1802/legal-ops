import type { SearchResultsDto } from '@legalops/types';
import { Alert, Card, EmptyState, PageHeader, SearchInput, SkeletonList } from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Briefcase, ChevronRight, Receipt, Scale, Search, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, qs } from '../../lib/api.js';
import { useDebounced } from '../../lib/hooks.js';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('q') ?? '');
  const q = useDebounced(input.trim(), 300);

  useEffect(() => {
    setParams(q ? { q } : {}, { replace: true });
  }, [q, setParams]);

  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<SearchResultsDto>(`/search${qs({ q })}`),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
  const r = results.data;
  const empty = r && r.clients.length + r.matters.length + r.cases.length + r.invoices.length === 0;

  return (
    <>
      <PageHeader title="Search" />
      <SearchInput
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Client, matter, case no., CNR, invoice, phone or email"
        aria-label="Search everything"
        className="mb-5"
      />
      {q.length < 2 ? (
        <EmptyState
          icon={<Search />}
          title="Type at least 2 characters"
          description="Search covers only your firm, and only matters you can access."
        />
      ) : results.isPending ? (
        <SkeletonList rows={4} />
      ) : results.isError ? (
        <Alert tone="danger">Search failed. Try again.</Alert>
      ) : empty ? (
        <EmptyState icon={<Search />} title={`No results for “${q}”`} />
      ) : (
        <div className="space-y-4">
          <Group
            title="Clients"
            items={r!.clients.map((c) => ({
              key: c.id,
              to: `/clients/${c.id}`,
              icon: <User />,
              title: c.name,
              sub: [c.phone, c.email].filter(Boolean).join(' · '),
            }))}
          />
          <Group
            title="Matters"
            items={r!.matters.map((m) => ({
              key: m.id,
              to: `/matters/${m.id}`,
              icon: <Briefcase />,
              title: m.title,
              sub: [m.clientName, m.referenceCode].filter(Boolean).join(' · '),
            }))}
          />
          <Group
            title="Cases"
            items={r!.cases.map((c) => ({
              key: c.id,
              to: `/cases/${c.id}`,
              icon: <Scale />,
              title: c.caseNumber ?? c.title,
              sub: [c.caseNumber ? c.title : null, c.cnr].filter(Boolean).join(' · '),
            }))}
          />
          <Group
            title="Invoices"
            items={r!.invoices.map((i) => ({
              key: i.id,
              to: `/matters/${i.matterId}?tab=billing`,
              icon: <Receipt />,
              title: i.invoiceNumber,
              sub: i.clientName,
            }))}
          />
        </div>
      )}
    </>
  );
}

function Group({
  title,
  items,
}: {
  title: string;
  items: { key: string; to: string; icon: ReactNode; title: string; sub: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <Card className="divide-y divide-line">
        {items.map((i) => (
          <Link key={i.key} to={i.to} className="flex items-center gap-3 px-4 py-3 hover:bg-subtle sm:px-5">
            <span className="text-muted [&_svg]:size-4.5">{i.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{i.title}</span>
              {i.sub ? <span className="block truncate text-xs text-muted">{i.sub}</span> : null}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
          </Link>
        ))}
      </Card>
    </section>
  );
}
