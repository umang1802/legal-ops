import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../config/env.js';
import { decryptSecret, encryptSecret, platformKey } from './secrets.js';

const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), APP_URL: 'http://localhost:5190' };

describe('platform secrets', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const key = platformKey(loadEnv({ ...base, NODE_ENV: 'test' }));
    const a = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    const b = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const key = platformKey(loadEnv({ ...base, NODE_ENV: 'test' }));
    const payload = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    const [iv, tag, ct] = payload.split('.');
    const flipped = `${iv}.${tag}.${ct!.slice(0, -2)}${ct!.endsWith('AA') ? 'AB' : 'AA'}`;
    expect(() => decryptSecret(key, flipped)).toThrow();
  });

  it('an empty PLATFORM_SECRET_KEY (as in .env.example) counts as unset outside production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', PLATFORM_SECRET_KEY: '' })).not.toThrow();
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40), PLATFORM_SECRET_KEY: '' })).toThrow(/PLATFORM_SECRET_KEY/);
  });

  it('requires PLATFORM_SECRET_KEY in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40) })).toThrow(/PLATFORM_SECRET_KEY/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40), PLATFORM_SECRET_KEY: 'k'.repeat(40) })).not.toThrow();
  });
});
