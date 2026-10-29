import { DOCUMENT_CATEGORY_LABELS, type DocumentDto } from '@legalops/types';
import { Alert, Badge, Button, EmptyState, Sheet, SkeletonList } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { formatDate, fullName } from '../../lib/format.js';
import { formatBytes } from '../../lib/upload.js';

/** Opens a document in a new tab (inline) or downloads it, via a short-lived signed link. */
export async function openDocument(doc: DocumentDto, inline: boolean) {
  // Open the tab now, while the click still counts as a user action; fill in the URL once it's signed.
  const win = inline ? window.open('', '_blank') : null;
  try {
    const { url } = await api.get<{ url: string }>(`/documents/${doc.id}/download?inline=${inline ? 1 : 0}`);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

const VIEWABLE = /^(application\/pdf|image\/(jpeg|png)|text\/plain)$/;

export function DocumentList({ docs, loading, emptyHint }: { docs: DocumentDto[] | undefined; loading: boolean; emptyHint: string }) {
  const me = useSession();
  const qc = useQueryClient();
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const canUpload = canAct(me, 'documents.upload');
  const [confirming, setConfirming] = useState<DocumentDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['documents'] });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/documents/${id}`),
    onSuccess: () => (setConfirming(null), refresh()),
  });
  const restore = useMutation({ mutationFn: (id: string) => api.post<DocumentDto>(`/documents/${id}/restore`), onSuccess: refresh });
  const open = useMutation({ mutationFn: ({ doc, inline }: { doc: DocumentDto; inline: boolean }) => openDocument(doc, inline) });
  const error = [restore.error, open.error].find((e) => e instanceof ApiError) as ApiError | undefined;

  if (loading) return <SkeletonList rows={4} />;
  if (!docs?.length) return <EmptyState icon={<FileText />} title="No documents yet" description={emptyHint} className="py-10" />;
  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error.message}</Alert> : null}
      <ul className="divide-y divide-line">
        {docs.map((d) => {
          const deleted = d.status === 'deleted';
          return (
            <li key={d.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5 ${deleted ? 'opacity-60' : ''}`}>
              <FileText className="size-5 shrink-0 text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={deleted}
                  onClick={() => open.mutate({ doc: d, inline: VIEWABLE.test(d.mimeType) })}
                  className="block max-w-full truncate text-left text-sm font-medium text-brand-700 hover:underline disabled:text-ink disabled:no-underline"
                >
                  {d.name}
                </button>
                <p className="text-xs text-muted">
                  {[
                    d.caseNumber,
                    d.hearingDate ? `Hearing ${formatDate(d.hearingDate)}` : null,
                    formatBytes(d.sizeBytes),
                    d.uploadedBy ? `${fullName(d.uploadedBy)}${d.uploadedAt ? `, ${formatDate(d.uploadedAt.slice(0, 10))}` : ''}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <Badge>{DOCUMENT_CATEGORY_LABELS[d.category]}</Badge>
              {deleted ? (
                <>
                  <Badge tone="danger">Deleted</Badge>
                  {isAdmin ? (
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => restore.mutate(d.id)}>
                      Restore
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" icon={<Download className="size-4" />} aria-label={`Download ${d.name}`} onClick={() => open.mutate({ doc: d, inline: false })} />
                  {canUpload && (isAdmin || d.uploadedBy?.userId === me.user.id) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="size-4" />}
                      aria-label={`Delete ${d.name}`}
                      onClick={() => (remove.reset(), setConfirming(d))}
                    />
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <Sheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Delete this document?"
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button variant="secondary" block className="sm:w-auto" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" block className="sm:w-auto" loading={remove.isPending} onClick={() => confirming && remove.mutate(confirming.id)}>
              Delete
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-soft">
          <p>“{confirming?.name}” will be removed from this matter. A partner or admin can restore it later.</p>
          {remove.error ? <Alert tone="danger">{remove.error instanceof ApiError ? remove.error.message : 'Could not delete.'}</Alert> : null}
        </div>
      </Sheet>
    </div>
  );
}
