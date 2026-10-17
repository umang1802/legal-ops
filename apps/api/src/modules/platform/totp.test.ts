import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, currentStep, otpauthUrl, totpCode, verifyTotp } from './totp.js';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; 6-digit codes are the last 6 digits.
const SEED = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp', () => {
  it('round-trips base32', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 vector at T=%i', (t, code) => {
    expect(totpCode(SEED, currentStep(t * 1000))).toBe(code);
  });

  it('accepts the previous, current and next step and returns the matched step', () => {
    const now = 1111111109 * 1000;
    const step = currentStep(now);
    expect(verifyTotp(SEED, totpCode(SEED, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(SEED, totpCode(SEED, step), now, null)).toBe(step);
    expect(verifyTotp(SEED, totpCode(SEED, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(SEED, totpCode(SEED, step + 2), now, null)).toBeNull();
  });

  it('replay: rejects a code whose step is not after the last accepted step', () => {
    const now = 1111111109 * 1000;
    const step = currentStep(now);
    expect(verifyTotp(SEED, totpCode(SEED, step), now, step)).toBeNull();
    expect(verifyTotp(SEED, totpCode(SEED, step - 1), now, step)).toBeNull();
  });

  it('rejects malformed codes without throwing', () => {
    expect(verifyTotp(SEED, '12345', Date.now(), null)).toBeNull();
    expect(verifyTotp(SEED, 'abcdef', Date.now(), null)).toBeNull();
  });

  it('builds an otpauth URL for authenticator apps', () => {
    expect(otpauthUrl('ABC', 'ops@x.test')).toBe(
      'otpauth://totp/LegalForgeX%20Platform:ops%40x.test?secret=ABC&issuer=LegalForgeX%20Platform&algorithm=SHA1&digits=6&period=30',
    );
  });
});
