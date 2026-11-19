import type { UserRef } from './dtos.js';

/** The starting list of file categories every firm gets. From then on each firm manages its own (Settings → Metadata). */
export const DOCUMENT_CATEGORY_DEFAULTS = [
  'Pleadings',
  'Orders & judgments',
  'Evidence',
  'Correspondence',
  'Vakalatnama & authority',
  'Client documents',
  'Other',
] as const;

/** Allowed file types, by extension (browsers report MIME types unreliably). */
export const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  txt: 'text/plain',
};

export const MAX_DOCUMENT_BYTES = 500 * 1024 * 1024;
/** Multipart chunk size. S3 needs ≥ 5 MiB for every part but the last. */
export const DOCUMENT_PART_BYTES = 16 * 1024 * 1024;

export function documentExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export type DocumentDto = {
  id: string;
  matterId: string;
  caseId: string | null;
  caseNumber: string | null;
  hearingId: string | null;
  hearingDate: string | null;
  name: string;
  /** A name from the firm's file categories, or null when none was chosen. */
  category: string | null;
  mimeType: string;
  sizeBytes: number;
  status: 'pending' | 'available' | 'failed' | 'deleted';
  uploadedBy: UserRef | null;
  uploadedAt: string | null;
  deletedAt: string | null;
};

/** Where the browser sends each 16 MiB part (signed URLs, part 1 first). */
export type DocumentUploadTicket = { documentId: string; partSize: number; partUrls: string[] };
