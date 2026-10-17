import { createHmac, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/** 256-bit opaque token for cookies and emailed links. Only its HMAC is ever stored. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

// @node-rs/argon2 defaults to Argon2id (m=19456 KiB, t=2, p=1), the OWASP baseline.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

let dummyHash: Promise<string> | undefined;

/** Verifies a password; when there's no stored hash, burns equivalent time so timing doesn't reveal accounts. */
export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!storedHash) {
    dummyHash ??= hash('legalops-timing-equaliser');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(storedHash, password).catch(() => false);
}
