import type { HearingTypeDto } from '@legalops/types';
import { Alert, Button, Card, CardBody, CardHeader, PageHeader, SkeletonList, TextField } from '@legalops/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api.js';

const KEY = ['hearing-types'];

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

function TypeRow({
  t,
  first,
  last,
  busy,
  onRename,
  onToggle,
  onMove,
}: {
  t: HearingTypeDto;
  first: boolean;
  last: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [value, setValue] = useState(t.name);
  useEffect(() => setValue(t.name), [t.name]);
  const commit = () => {
    const next = value.trim();
    if (!next) setValue(t.name);
    else if (next !== t.name) onRename(next);
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
      <input
        aria-label={`Name of ${t.name}`}
        className="h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-line focus:bg-surface focus:outline-2 focus:outline-brand-600 disabled:opacity-60"
        value={value}
        maxLength={100}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setValue(t.name);
        }}
      />
      <span className="text-xs text-muted tabular-nums">
        {t.inUse === 0 ? 'Not used yet' : `${t.inUse} hearing${t.inUse === 1 ? '' : 's'}`}
      </span>
      {t.isActive ? (
        <Mover name={t.name} first={first} last={last} onUp={() => onMove(-1)} onDown={() => onMove(1)} />
      ) : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
        {t.isActive ? 'Archive' : 'Restore'}
      </Button>
    </li>
  );
}

/** The firm's list of hearing types. Only firm managers can open this page; the hearing form offers exactly the active ones. */
export function HearingTypesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<HearingTypeDto[]>('/hearing-types') });
  const [name, setName] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: (n: string) => api.post<HearingTypeDto>('/hearing-types', { name: n }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; isActive?: boolean } }) =>
      api.patch<HearingTypeDto>(`/hearing-types/${id}`, body),
    onSuccess: refresh,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post<HearingTypeDto[]>('/hearing-types/order', { ids }),
    onSuccess: (rows) => qc.setQueryData(KEY, rows),
  });

  if (list.isPending) return <SkeletonList rows={6} />;
  if (list.isError)
    return <Alert tone="danger">Couldn’t load your hearing types. Refresh to try again.</Alert>;

  const active = list.data.filter((t) => t.isActive);
  const archived = list.data.filter((t) => !t.isActive);
  const err = [add.error, patch.error, reorder.error].find((e) => e instanceof ApiError) as
    ApiError | undefined;
  const busy = patch.isPending || reorder.isPending;
  const move = (i: number, by: -1 | 1) => {
    const ids = active.map((t) => t.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    reorder.mutate([...ids, ...archived.map((t) => t.id)]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Hearing types"
        description="The types your team can choose when scheduling a hearing. Only your firm’s managers can add or change them."
      />
      {err ? <Alert tone="danger">{err.message}</Alert> : null}

      <Card>
        <CardHeader title="Add a hearing type" />
        <CardBody>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <TextField
                label="Name"
                value={name}
                maxLength={100}
                placeholder="e.g. Pronouncement of judgment"
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
          title="Your hearing types"
          description="Click a name to rename it. Renaming also updates the hearings that use it."
        />
        {active.length === 0 ? (
          <CardBody className="text-sm text-muted">
            No hearing types yet. Add one above; until you do, hearings can be saved without a type.
          </CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((t, i) => (
              <TypeRow
                key={t.id}
                t={t}
                first={i === 0}
                last={i === active.length - 1}
                busy={busy}
                onRename={(n) => patch.mutate({ id: t.id, body: { name: n } })}
                onToggle={() => patch.mutate({ id: t.id, body: { isActive: false } })}
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
            Hidden from the hearing form. Hearings that already use one keep it.
          </p>
          <ul className="divide-y divide-line border-t border-line">
            {archived.map((t) => (
              <TypeRow
                key={t.id}
                t={t}
                first
                last
                busy={busy}
                onRename={(n) => patch.mutate({ id: t.id, body: { name: n } })}
                onToggle={() => patch.mutate({ id: t.id, body: { isActive: true } })}
                onMove={() => undefined}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
