import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_TYPES,
  documentExtension,
  MAX_DOCUMENT_BYTES,
  type CaseSummaryDto,
  type DocumentCategory,
} from '@legalops/types';
import { Button, cn } from '@legalops/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FolderUp, RotateCw, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api.js';
import { formatBytes, UploadCancelled, uploadDocument } from '../../lib/upload.js';

type Item = {
  id: number;
  file: File;
  category: DocumentCategory;
  caseId: string;
  state: 'invalid' | 'queued' | 'uploading' | 'done' | 'failed';
  progress: number;
  error?: string;
  controller?: AbortController;
};

const PARALLEL_FILES = 2;
const ACCEPT = Object.keys(DOCUMENT_TYPES).map((e) => `.${e}`).join(',');

function check(file: File): string | undefined {
  if (!(documentExtension(file.name) in DOCUMENT_TYPES)) return 'This file type isn’t allowed';
  if (file.size === 0) return 'The file is empty';
  if (file.size > MAX_DOCUMENT_BYTES) return 'Over the 500 MB limit';
  return undefined;
}

/**
 * Bulk uploader: add files or a whole folder, set a category (and case) for the batch or per file, upload two files at a
 * time. A failed file can be retried on its own; it never stops the rest.
 */
export function DocumentUploader({
  matterId,
  cases,
  hearingId,
  defaultCategory = 'other',
  onDone,
}: {
  matterId: string;
  cases: CaseSummaryDto[];
  hearingId?: string;
  defaultCategory?: DocumentCategory;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Item[]>([]);
  const [batchCategory, setBatchCategory] = useState<DocumentCategory>(defaultCategory);
  const [batchCase, setBatchCase] = useState(cases.length === 1 ? cases[0]!.id : '');
  const [dragging, setDragging] = useState(false);
  const seq = useRef(0);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const running = items.filter((i) => i.state === 'uploading').length;

  const update = (id: number, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const add = (files: FileList | File[]) => {
    const list = [...files].filter((f) => !f.name.startsWith('.')); // skip .DS_Store and other hidden files from folders
    setItems((xs) => [
      ...xs,
      ...list.map((file) => {
        const error = check(file);
        return { id: ++seq.current, file, category: batchCategory, caseId: batchCase, state: error ? ('invalid' as const) : ('queued' as const), progress: 0, error };
      }),
    ]);
  };

  // Start queued files whenever a slot is free.
  useEffect(() => {
    const slots = PARALLEL_FILES - running;
    if (slots <= 0) return;
    for (const item of items.filter((i) => i.state === 'queued').slice(0, slots)) {
      const controller = new AbortController();
      update(item.id, { state: 'uploading', progress: 0, error: undefined, controller });
      uploadDocument(
        item.file,
        { matterId, caseId: hearingId ? null : item.caseId || null, hearingId: hearingId ?? null, category: item.category },
        (p) => update(item.id, { progress: p }),
        controller.signal,
      )
        .then(() => {
          update(item.id, { state: 'done', progress: 1 });
          void qc.invalidateQueries({ queryKey: ['documents'] });
          void qc.invalidateQueries({ queryKey: ['matter', matterId, 'timeline'] });
        })
        .catch((err: unknown) =>
          update(item.id, {
            state: 'failed',
            error: err instanceof UploadCancelled ? 'Cancelled' : err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed',
          }),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the queue changes
  }, [items]);

  const done = items.filter((i) => i.state === 'done').length;
  const pending = items.filter((i) => i.state === 'queued' || i.state === 'uploading').length;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={cn('rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm', dragging ? 'border-brand-700 bg-brand-50' : 'border-line')}
      >
        <p className="font-medium">Drop files here</p>
        <p className="mt-1 text-muted">PDF, Word, Excel, images or text · up to 500 MB each</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button variant="secondary" icon={<Upload className="size-4" />} onClick={() => filesInput.current?.click()}>
            Choose files
          </Button>
          {hearingId ? null : (
            <Button variant="secondary" icon={<FolderUp className="size-4" />} onClick={() => folderInput.current?.click()}>
              Choose a folder
            </Button>
          )}
        </div>
        <input ref={filesInput} type="file" multiple={!hearingId} accept={ACCEPT} hidden onChange={(e) => (e.target.files && add(e.target.files), (e.target.value = ''))} />
        <input
          ref={folderInput}
          type="file"
          hidden
          // @ts-expect-error webkitdirectory is supported by all current browsers but missing from React's types
          webkitdirectory=""
          onChange={(e) => (e.target.files && add(e.target.files), (e.target.value = ''))}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Category for new files</span>
          <select value={batchCategory} onChange={(e) => setBatchCategory(e.target.value as DocumentCategory)} className="h-10 w-full rounded-lg border border-line bg-surface px-3">
            {DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DOCUMENT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        {hearingId || cases.length === 0 ? null : (
          <label className="text-sm">
            <span className="mb-1 block font-medium">Case for new files</span>
            <select value={batchCase} onChange={(e) => setBatchCase(e.target.value)} className="h-10 w-full rounded-lg border border-line bg-surface px-3">
              <option value="">Whole matter (no specific case)</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.caseNumber ?? c.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {items.length ? (
        <>
          <p className="text-sm text-muted" aria-live="polite">
            {done} of {items.filter((i) => i.state !== 'invalid').length} uploaded{pending ? ` · ${pending} in progress` : ''}
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((i) => (
              <li key={i.id} className="space-y-1.5 px-3 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={i.file.webkitRelativePath || i.file.name}>
                    {i.file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{formatBytes(i.file.size)}</span>
                  {i.state === 'queued' || i.state === 'invalid' ? (
                    <select
                      aria-label={`Category for ${i.file.name}`}
                      value={i.category}
                      disabled={i.state === 'invalid'}
                      onChange={(e) => update(i.id, { category: e.target.value as DocumentCategory })}
                      className="h-8 max-w-40 rounded-md border border-line bg-surface px-2 text-xs"
                    >
                      {DOCUMENT_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {DOCUMENT_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {i.state === 'done' ? <CheckCircle2 className="size-4 shrink-0 text-success-600" aria-label="Uploaded" /> : null}
                  {i.state === 'failed' ? (
                    <Button size="sm" variant="secondary" icon={<RotateCw className="size-3.5" />} onClick={() => update(i.id, { state: 'queued', error: undefined })}>
                      Retry
                    </Button>
                  ) : null}
                  {i.state === 'uploading' ? (
                    <button type="button" aria-label={`Cancel ${i.file.name}`} onClick={() => i.controller?.abort()} className="grid size-8 place-items-center rounded-md text-muted hover:bg-subtle">
                      <X className="size-4" />
                    </button>
                  ) : i.state !== 'done' ? (
                    <button type="button" aria-label={`Remove ${i.file.name}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== i.id))} className="grid size-8 place-items-center rounded-md text-muted hover:bg-subtle">
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                {i.state === 'uploading' ? (
                  <div className="h-1.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={Math.round(i.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${i.file.name}`}>
                    <div className="h-full bg-brand-700 transition-[width]" style={{ width: `${Math.round(i.progress * 100)}%` }} />
                  </div>
                ) : null}
                {i.error ? <p className="text-xs text-danger-700">{i.error}</p> : null}
              </li>
            ))}
          </ul>
          {onDone && pending === 0 && done > 0 ? (
            <Button variant="secondary" onClick={onDone}>
              Done
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
