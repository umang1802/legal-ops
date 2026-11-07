/**
 * The printable-document model. The server builds it once (`invoiceDocumentModel`) and then draws it twice: as a PDF
 * (downloads and emails) and, serialised, in the browser (print page and the invoice-format preview). `I` is the image
 * type: raw bytes on the server, a `{ src }` data URI on the wire.
 */

export type DocAlign = 'left' | 'right';
export type DocLine = { text: string; bold?: boolean; size?: number; muted?: boolean; accent?: boolean };

/** Colours and look shared by a whole document. Hex colours; absent for receipts, which keep the plain look. */
export type DocTheme = { accent: string; rule: string };

export type DocFooter = {
  thankYou: string | null;
  contact: string | null;
  tagline: string | null;
  poweredBy: boolean;
  rule: boolean;
};

export type DocWatermark<I> =
  | {
      kind: 'image';
      image: I;
      opacity: number;
      scale: number;
      rotation: number;
      position: 'top' | 'center' | 'bottom';
    }
  | {
      kind: 'text';
      text: string;
      opacity: number;
      scale: number;
      rotation: number;
      position: 'top' | 'center' | 'bottom';
    };

export type DocBlock<I> =
  // ---- plain blocks (receipts, and parts of invoices) ----
  | { kind: 'header'; logo: I | null; lines: DocLine[]; title: string; number: string | null }
  | { kind: 'banner'; text: string }
  | { kind: 'columns'; left: { label: string; lines: string[] }; right: [label: string, value: string][] }
  | {
      kind: 'table';
      title?: string;
      /** Column widths are fractions of the table width and add up to 1. */
      columns: { header: string; width: number; align: DocAlign }[];
      rows: { cells: string[]; note?: string }[];
      /** Invoice look: a filled header bar in the accent colour, and a single rule under the last row. */
      filled?: boolean;
      /** The column a row's small note sits under (the description); the first column by default. */
      noteColumn?: number;
    }
  | { kind: 'totals'; rows: { label: string; value: string; strong?: boolean }[]; accent?: boolean }
  | { kind: 'text'; text: string; size?: number; bold?: boolean; muted?: boolean }
  | { kind: 'box'; title: string; lines: string[] }
  | {
      kind: 'signature';
      image: I | null;
      lines: string[];
      align?: 'left' | 'center' | 'right';
      heading?: string | null;
      accentName?: boolean;
    }
  | { kind: 'spacer'; h: number }
  // ---- invoice look ----
  | {
      kind: 'letterhead';
      align: 'left' | 'center';
      logo: I | null;
      logoHeight: number;
      lines: DocLine[];
      rule: boolean;
    }
  | { kind: 'title'; text: string; align: 'left' | 'center' | 'right' }
  | {
      kind: 'parties';
      left: { label: string; name: string; lines: string[] };
      right: { label: string; rows: { label: string; value: string }[] };
      /** Which side the invoice-details column sits on. */
      detailsSide: 'left' | 'right';
    }
  | { kind: 'subject'; label: string; text: string }
  | { kind: 'labeled'; label: string; lines: { text: string; indent?: boolean }[] };

export type DocModel<I> = {
  title: string;
  blocks: DocBlock<I>[];
  theme?: DocTheme;
  footer?: DocFooter;
  watermark?: DocWatermark<I>;
};

/** The wire form of an image in a serialised model. */
export type WireImage = { src: string };
export type WireDocModel = DocModel<WireImage>;
