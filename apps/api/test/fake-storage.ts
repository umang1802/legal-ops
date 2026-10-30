import type { DocumentStorage } from '../src/integrations/storage/document-storage.js';

/** In-memory document store for tests. `simulateBrowserUpload` stands in for the browser PUTting the parts. */
export class FakeDocumentStorage implements DocumentStorage {
  readonly name = 'fake';
  uploads = new Map<string, { key: string; contentType: string; parts: number; done: boolean; aborted: boolean }>();
  objects = new Map<string, number>();
  /** Single-PUT objects (logos) with their bytes. */
  data = new Map<string, Buffer>();
  removed: string[] = [];
  lastUploadId: string | null = null;
  private n = 0;

  async startUpload(key: string, contentType: string) {
    const uploadId = `up-${++this.n}`;
    this.uploads.set(uploadId, { key, contentType, parts: 0, done: false, aborted: false });
    this.lastUploadId = uploadId;
    return { uploadId };
  }
  async signPartUrls(key: string, uploadId: string, partCount: number) {
    this.uploads.get(uploadId)!.parts = partCount;
    return Array.from({ length: partCount }, (_, i) => `https://fake-storage/${key}?uploadId=${uploadId}&partNumber=${i + 1}`);
  }
  /** Pretend the browser uploaded `size` bytes for the most recent upload. */
  simulateBrowserUpload(size: number, uploadId = this.lastUploadId!) {
    (this.uploads.get(uploadId) as { size?: number }).size = size;
  }
  async completeUpload(key: string, uploadId: string) {
    const u = this.uploads.get(uploadId) as { done: boolean; size?: number } | undefined;
    if (!u || u.size === undefined) throw new Error('no parts uploaded');
    u.done = true;
    this.objects.set(key, u.size);
  }
  async abortUpload(_key: string, uploadId: string) {
    const u = this.uploads.get(uploadId);
    if (u) u.aborted = true;
  }
  async objectSize(key: string) {
    return this.objects.get(key) ?? this.data.get(key)?.length ?? null;
  }
  async remove(key: string) {
    this.objects.delete(key);
    this.data.delete(key);
    this.removed.push(key);
  }
  /** Stands in for the browser PUTting a file to a signed URL. */
  putDirect(key: string, body: Buffer) {
    this.data.set(key, body);
  }
  async putObject(key: string, body: Buffer) {
    this.data.set(key, body);
  }
  async signPutUrl(key: string) {
    return `https://fake-storage/put/${key}`;
  }
  async readObject(key: string, maxBytes: number) {
    const b = this.data.get(key);
    return b ? b.subarray(0, maxBytes + 1) : null;
  }
  async signDownloadUrl(key: string, o: { fileName: string; inline: boolean }) {
    return `https://fake-storage/${key}?download=1&inline=${o.inline}&name=${encodeURIComponent(o.fileName)}`;
  }
}
