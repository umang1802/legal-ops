/**
 * Structural check that a PDF carries a digital signature. Port of the old Vidhimeya invoice app's rule
 * (it does not verify the cryptography): the file starts `%PDF-`, has a `/ByteRange [` and a `/SubFilter`
 * starting `/adbe.pkcs7` or `/ETSI.CAdES`.
 */
export const MAX_SIGNED_PDF_BYTES = 10 * 1024 * 1024;

export const isPdf = (buf: Buffer): boolean => buf.subarray(0, 5).toString('latin1') === '%PDF-';

export function looksDigitallySigned(buf: Buffer): boolean {
  if (!isPdf(buf)) return false;
  const body = buf.toString('latin1');
  return /\/ByteRange\s*\[/.test(body) && /\/(adbe\.pkcs7|ETSI\.CAdES)/.test(body);
}
