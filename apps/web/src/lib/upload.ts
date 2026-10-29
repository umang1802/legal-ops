import type { DocumentCategory, DocumentDto, DocumentUploadTicket } from '@legalops/types';
import { api } from './api.js';

export type UploadTarget = { matterId: string; caseId?: string | null; hearingId?: string | null; category: DocumentCategory };
export class UploadCancelled extends Error {}

const PARALLEL_PARTS = 3;
const PART_ATTEMPTS = 3;

/** PUTs one part straight to storage; resolves with its ETag. Credentials and app headers never go to storage. */
function putPart(url: string, body: Blob, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(xhr.status >= 200 && xhr.status < 300 ? 'Storage didn’t return an ETag (check the bucket’s CORS settings)' : `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    const abort = () => {
      xhr.abort();
      reject(new UploadCancelled('Cancelled'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uploads one file as a multipart upload: the API hands out signed part URLs, the browser sends 16 MB parts straight to
 * storage (3 at a time, each retried up to 3 times), then the API completes and verifies it.
 */
export async function uploadDocument(
  file: File,
  target: UploadTarget,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<DocumentDto> {
  const ticket = await api.post<DocumentUploadTicket>('/documents/uploads', {
    matterId: target.matterId,
    caseId: target.caseId ?? null,
    hearingId: target.hearingId ?? null,
    category: target.category,
    name: file.name,
    sizeBytes: file.size,
  });
  const loaded = new Array<number>(ticket.partUrls.length).fill(0);
  const report = () => onProgress(Math.min(0.99, loaded.reduce((a, b) => a + b, 0) / file.size));
  const etags = new Array<string>(ticket.partUrls.length);
  let next = 0;

  const worker = async () => {
    while (next < ticket.partUrls.length) {
      const i = next++;
      const blob = file.slice(i * ticket.partSize, Math.min(file.size, (i + 1) * ticket.partSize));
      for (let attempt = 1; ; attempt++) {
        try {
          etags[i] = await putPart(ticket.partUrls[i]!, blob, (b) => ((loaded[i] = b), report()), signal);
          loaded[i] = blob.size;
          report();
          break;
        } catch (err) {
          if (err instanceof UploadCancelled || attempt >= PART_ATTEMPTS) throw err;
          loaded[i] = 0;
          await wait(1000 * attempt);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, ticket.partUrls.length) }, worker));
    const doc = await api.post<DocumentDto>(`/documents/${ticket.documentId}/complete`, {
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
    });
    onProgress(1);
    return doc;
  } catch (err) {
    void api.post(`/documents/${ticket.documentId}/abort`).catch(() => undefined);
    throw err;
  }
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
