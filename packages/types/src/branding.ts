/** Firm logo (spec 2026-10-30-firm-logo-design): PNG or JPG up to 1 MB, served publicly so email apps can load it. */
export const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' } as const;
export type LogoContentType = keyof typeof LOGO_TYPES;
export type LogoType = (typeof LOGO_TYPES)[LogoContentType];
export const MAX_LOGO_BYTES = 1_048_576;

/** Public path of a logo file. Each upload has its own id, so the path changes whenever the logo does. */
export const logoPath = (orgId: string, logoId: string, type: LogoType): string => `/api/v1/public/logos/${orgId}/${logoId}.${type}`;

/** Scanned signature printed on invoices: PNG or JPG up to 500 KB. */
export const MAX_SIGNATURE_BYTES = 512_000;
export const DEFAULT_DESIGNATION = 'Authorized Signatory';
