/**
 * Where document files live. The browser uploads straight to the store with signed part URLs, so large files never
 * pass through the API. Implementations: S3 (production; MinIO in development) and Disabled (not configured).
 */
export interface DocumentStorage {
  readonly name: string;
  startUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  /** Signed PUT URLs for parts 1..partCount. */
  signPartUrls(key: string, uploadId: string, partCount: number, expiresInSeconds: number): Promise<string[]>;
  completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  /** Stored size in bytes, or null if there's no object. */
  objectSize(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  signDownloadUrl(key: string, o: { fileName: string; contentType: string; inline: boolean; expiresInSeconds: number }): Promise<string>;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the full UTF-8 name. */
export function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
