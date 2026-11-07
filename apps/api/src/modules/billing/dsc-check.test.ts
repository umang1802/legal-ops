import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { looksDigitallySigned } from './dsc-check.js';

const fx = (n: string) => readFileSync(new URL(`../../../test/fixtures/${n}`, import.meta.url));

describe('looksDigitallySigned', () => {
  it('is true for signed.pdf, false for unsigned.pdf and for plain text', () => {
    expect(looksDigitallySigned(fx('signed.pdf'))).toBe(true);
    expect(looksDigitallySigned(fx('unsigned.pdf'))).toBe(false);
    expect(looksDigitallySigned(Buffer.from('hello'))).toBe(false);
  });
  it('accepts ETSI.CAdES prefixes; needs the %PDF- header, a ByteRange and an adbe.pkcs7 or ETSI.CAdES marker', () => {
    expect(looksDigitallySigned(Buffer.from('%PDF-1.7 /ByteRange [0 1 2 3] /SubFilter /ETSI.CAdES.detached'))).toBe(true);
    expect(looksDigitallySigned(Buffer.from('%PDF-1.7 /SubFilter /adbe.pkcs7.detached'))).toBe(false);
    expect(looksDigitallySigned(Buffer.from('%PDF-1.7 /ByteRange [0 1 2 3]'))).toBe(false);
    expect(looksDigitallySigned(Buffer.from('xPDF-1.7 /ByteRange [0 1 2 3] /SubFilter /adbe.pkcs7.detached'))).toBe(false);
  });
});
