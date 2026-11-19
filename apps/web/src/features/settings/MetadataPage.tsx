import { METADATA_LISTS, metadataList, type MetadataListKey, type MetadataOptionDto } from '@legalops/types';
import { Alert, Button, Card, CardBody, CardHeader, PageHeader, SkeletonList, TextField } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { api, ApiError } from '../../lib/api.js';
import { useMetadataOptions } from '../../lib/metadata.js';

function Mover({
  name,
  first,
  last,
  onUp,
  onDown,
}: {
  name: string;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const btn =
    'grid size-8 place-items-center rounded-lg border border-line text-ink-soft hover:bg-subtle disabled:opacity-30';
  return (
    <span className="flex shrink-0 gap-1">
      <button type="button" aria-label={`Move ${name} up`} disabled={first} onClick={onUp} className={btn}>
        <ArrowUp className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label={`Move ${name} down`} disabled={last} onClick={onDown} className={btn}>
        <ArrowDown className="size-4" aria-hidden />
      </button>
    </span>
  );
}

function Row({
  o,
  first,
  last,
  busy,
  onRename,
  onToggle,
  onMove,
}: {
  o: MetadataOptionDto;
  first: boolean;
  last: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [value, setValue] = useState(o.name);
  useEffect(() => setValue(o.name), [o.name]);
  const commit = () => {
    const next = value.trim();
    if (!next) setValue(o.name);
    else if (next !== o.name) onRename(next);
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
      <input
        aria-label={`Name of ${o.name}`}
        className="h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-line focus:bg-surface focus:outline-2 focus:outline-brand-600 disabled:opacity-60"
        value={value}
        maxLength={100}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setValue(o.name);
        }}
      />
      <span className="text-xs text-muted tabular-nums">
        {o.inUse === 0 ? 'Not used yet' : `Used ${o.inUse} time${o.inUse === 1 ? '' : 's'}`}
      </span>
      {o.isActive ? (
        <Mover name={o.name} first={first} last={last} onUp={() => onMove(-1)} onDown={() => onMove(1)} />
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
        {o.isActive ? 'Archive' : 'Restore'}
      </Button>
    </li>
  );
}

/** One list: add, rename, reorder, archive. The forms elsewhere offer exactly the active entries. */
function ListEditor({ list }: { list: MetadataListKey }) {
  const meta = metadataList(list)!;
  const qc = useQueryClient();
  const q = useMetadataOptions(list);
  const [name, setName] = useState('');
  const [prev, setPrev] = useState(list);
  if (prev !== list) {
    setPrev(list);
    setName('');
  }
  const refresh = () => void qc.invalidateQueries({ queryKey: ['metadata', list] });
  const add = useMutation({
    mutationFn: (n: string) => api.post<MetadataOptionDto>(`/metadata/${list}`, { name: n }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; isActive?: boolean } }) =>
      api.patch<MetadataOptionDto>(`/metadata/${list}/${id}`, body),
    onSuccess: refresh,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post<MetadataOptionDto[]>(`/metadata/${list}/order`, { ids }),
    onSuccess: (rows) => qc.setQueryData(['metadata', list], rows),
  });

  if (q.isPending) return <SkeletonList rows={6} />;
  if (q.isError) return <Alert tone="danger">Couldn’t load this list. Refresh to try again.</Alert>;

  const active = q.data.filter((o) => o.isActive);
  const archived = q.data.filter((o) => !o.isActive);
  const err = [add.error, patch.error, reorder.error].find((e) => e instanceof ApiError) as
    ApiError | undefined;
  const busy = patch.isPending || reorder.isPending;
  const move = (i: number, by: -1 | 1) => {
    const ids = active.map((o) => o.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    reorder.mutate([...ids, ...archived.map((o) => o.id)]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  };

  return (
    <div className="space-y-4">
      {err ? <Alert tone="danger">{err.message}</Alert> : null}
      <Card>
        <CardHeader title={`Add a ${meta.singular}`} description={meta.description} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <TextField
                label="Name"
                value={name}
                maxLength={100}
                placeholder={meta.placeholder}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" loading={add.isPending} disabled={!name.trim()}>
              Add
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={meta.title}
          description="Click a name to rename it. Renaming also updates everything that already uses it."
        />
        {active.length === 0 ? (
          <CardBody className="text-sm text-muted">
            Nothing here yet. Add one above. Until you do, this field can be left empty.
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((o, i) => (
              <Row
                key={o.id}
                o={o}
                first={i === 0}
                last={i === active.length - 1}
                busy={busy}
                onRename={(n) => patch.mutate({ id: o.id, body: { name: n } })}
                onToggle={() => patch.mutate({ id: o.id, body: { isActive: false } })}
                onMove={(by) => move(i, by)}
              />
            ))}
          </ul>
        )}
      </Card>

      {archived.length ? (
        <details className="rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold sm:px-5">
            Archived ({archived.length})
          </summary>
          <p className="px-4 pb-2 text-sm text-muted sm:px-5">
            Hidden from forms. Records that already use one keep it.
          </p>
          <ul className="divide-y divide-line border-t border-line">
            {archived.map((o) => (
              <Row
                key={o.id}
                o={o}
                first
                last
                busy={busy}
                onRename={(n) => patch.mutate({ id: o.id, body: { name: n } })}
                onToggle={() => patch.mutate({ id: o.id, body: { isActive: true } })}
                onMove={() => undefined}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Settings → Metadata: the pick-lists a firm keeps for itself, one sub-option each. Only firm managers can open it; the
 * forms elsewhere (hearing, file upload, matter, expense) offer the active entries.
 */
export function MetadataPage() {
  const { list } = useParams();
  const current = metadataList(list ?? '');
  if (!current) return <Navigate to={`/settings/metadata/${METADATA_LISTS[0].key}`} replace />;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Metadata"
        description="The lists your team picks from. Add what your firm needs; only your firm’s managers can change them."
      />
      <nav aria-label="Lists" className="flex flex-wrap gap-2">
        {METADATA_LISTS.map((l) => (
          <NavLink
            key={l.key}
            to={`/settings/metadata/${l.key}`}
            className={({ isActive }) =>
              `rounded-lg border px-3 py-2 text-sm font-medium ${isActive ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-ink-soft hover:bg-subtle'}`
            }
          >
            {l.title}
          </NavLink>
        ))}
      </nav>
      <ListEditor list={current.key} />
    </div>
  );
}
