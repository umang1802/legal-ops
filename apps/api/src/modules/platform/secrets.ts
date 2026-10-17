import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';

/** 32-byte AES key: PLATFORM_SECRET_KEY in production; derived from SESSION_SECRET in dev/test. */
export function platformKey(env: Env): Buffer {
  return createHash('sha256').update(env.PLATFORM_SECRET_KEY ?? `${env.SESSION_SECRET}:platform-totp`).digest();
}

/** AES-256-GCM; output is `iv.tag.ciphertext`, each base64url. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(key: Buffer, payload: string): string {
  const [iv, tag, ct] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('Malformed secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
