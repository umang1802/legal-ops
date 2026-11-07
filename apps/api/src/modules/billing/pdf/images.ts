import type { DocumentStorage } from '../../../integrations/storage/document-storage.js';
import type { ImageRef } from './layout.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPG = Buffer.from('ffd8ff', 'hex');
const MAX_IMAGE_BYTES = 1024 * 1024;

/** A stored PNG/JPG for embedding, or null when the key is missing, unreadable, oversize or not an image. Never throws. */
export async function readImage(storage: DocumentStorage, key: string | null): Promise<ImageRef | null> {
  if (!key) return null;
  try {
    const bytes = await storage.readObject(key, MAX_IMAGE_BYTES);
    if (!bytes || bytes.length > MAX_IMAGE_BYTES) return null;
    if (bytes.subarray(0, PNG.length).equals(PNG)) return { bytes, mime: 'image/png' };
    if (bytes.subarray(0, JPG.length).equals(JPG)) return { bytes, mime: 'image/jpeg' };
    return null;
  } catch {
    return null;
  }
}
