import { describe, expect, it } from 'vitest';
import { LOGO_TYPES, logoPath, MAX_LOGO_BYTES } from './branding.js';

describe('firm logo', () => {
  it('builds the public logo path', () => {
    expect(logoPath('o1', 'l1', 'png')).toBe('/api/v1/public/logos/o1/l1.png');
  });
  it('allows PNG and JPG up to 1 MB', () => {
    expect(MAX_LOGO_BYTES).toBe(1048576);
    expect(LOGO_TYPES['image/jpeg']).toBe('jpg');
    expect(LOGO_TYPES['image/png']).toBe('png');
  });
});
