import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { toPaise } from '@legalops/validation';
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

/**
 * Shared PDF plumbing. Documents are described as a plain `DocModel` (text blocks and tables) by
 * `invoiceDocumentModel` / `receiptDocumentModel`; `renderDocument` only draws that model with the embedded Noto Sans.
 * Keeping the two apart lets tests assert on content without extracting text from subset-embedded fonts.
 */

export type ImageRef = { bytes: Buffer; mime: 'image/png' | 'image/jpeg' };
export type Align = 'left' | 'right';
export type Line = { text: string; bold?: boolean; size?: number; muted?: boolean };

export type Block =
  | { kind: 'header'; logo: ImageRef | null; lines: Line[]; title: string; number: string | null }
  | { kind: 'banner'; text: string }
  | { kind: 'columns'; left: { label: string; lines: string[] }; right: [label: string, value: string][] }
  | {
      kind: 'table';
      title?: string;
      /** Column widths are fractions of the table width and add up to 1. */
      columns: { header: string; width: number; align: Align }[];
      rows: { cells: string[]; note?: string }[];
    }
  | { kind: 'totals'; rows: { label: string; value: string; strong?: boolean }[] }
  | { kind: 'text'; text: string; size?: number; bold?: boolean; muted?: boolean }
  | { kind: 'box'; title: string; lines: string[] }
  | { kind: 'signature'; image: ImageRef | null; lines: string[] }
  | { kind: 'spacer'; h: number };

export type DocModel = { title: string; blocks: Block[] };

/** Every string in the model, one per line: what tests (and humans) read instead of extracting text from the PDF. */
export function modelText(model: DocModel): string {
  const out: string[] = [model.title];
  for (const b of model.blocks) {
    switch (b.kind) {
      case 'header':
        out.push(...b.lines.map((l) => l.text), b.title, b.number ?? '');
        break;
      case 'banner':
        out.push(b.text);
        break;
      case 'columns':
        out.push(b.left.label, ...b.left.lines, ...b.right.flat());
        break;
      case 'table':
        out.push(b.title ?? '', ...b.columns.map((c) => c.header));
        for (const r of b.rows) out.push(r.cells.join(' | '), r.note ?? '');
        break;
      case 'totals':
        out.push(...b.rows.map((r) => `${r.label} ${r.value}`));
        break;
      case 'text':
        out.push(b.text);
        break;
      case 'box':
        out.push(b.title, ...b.lines);
        break;
      case 'signature':
        out.push(...b.lines);
        break;
      case 'spacer':
        break;
    }
  }
  return out.filter(Boolean).join('\n');
}

// ---- Formatting ----

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** '50000.00' -> '₹50,000.00' (Indian grouping). */
export const formatINR = (amount: string | null | undefined): string => (amount == null ? '—' : inr.format(toPaise(amount) / 100));
export const isZero = (amount: string): boolean => toPaise(amount) === 0;

/** '2026-11-06' -> '6 Nov 2026' (the web's en-IN short date). */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  );
}

// ---- Fonts ----

const FONT_DIR_CANDIDATES = [
  // Built: tsup bundles into dist/*.js and copies assets/ to dist/assets/.
  join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts'),
  // Source (tests, tsx dev): src/modules/billing/pdf -> apps/api/assets/fonts.
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'assets', 'fonts'),
];

/** Absolute path of a bundled font file; resolves in both `src` and the built `dist`. */
export function fontPath(file: string): string {
  for (const dir of FONT_DIR_CANDIDATES) {
    const p = join(dir, file);
    if (existsSync(p)) return p;
  }
  throw new Error(`Font ${file} not found (looked in ${FONT_DIR_CANDIDATES.join(', ')})`);
}

type FontKit = { hasGlyphForCodePoint(cp: number): boolean };
type FontBytes = { bytes: Buffer; glyphs: FontKit };
const fontCache = new Map<string, FontBytes>();
function loadFontBytes(file: string): FontBytes {
  let f = fontCache.get(file);
  if (!f) {
    const bytes = readFileSync(fontPath(file));
    f = { bytes, glyphs: fontkit.create(bytes) as unknown as FontKit };
    fontCache.set(file, f);
  }
  return f;
}

// ---- Rendering ----

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 36;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const RULE = rgb(0.75, 0.75, 0.75);
const RED = rgb(0.7, 0.1, 0.1);
const SIZE = 9.5;

type Fonts = { regular: PDFFont; bold: PDFFont; glyphs: FontKit };

/** Characters the font can't draw become '?' (a missing glyph would otherwise abort the whole PDF); \n is kept. */
function clean(text: string, glyphs: FontKit): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    if (ch === '\n') out += ch;
    else if (ch === '\t') out += ' ';
    else {
      const cp = ch.codePointAt(0)!;
      out += cp < 0x20 || cp === 0x7f ? '' : glyphs.hasGlyphForCodePoint(cp) ? ch : '?';
    }
  }
  return out;
}

/** Greedy word wrap; words wider than the column are split by character. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

class Painter {
  page!: PDFPage;
  y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly f: Fonts,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  need(h: number) {
    if (this.y - h < BOTTOM) this.newPage();
  }
  font(bold?: boolean) {
    return bold ? this.f.bold : this.f.regular;
  }
  wrap(text: string, bold: boolean | undefined, size: number, width: number) {
    return wrapText(clean(text, this.f.glyphs), this.font(bold), size, width);
  }
  draw(text: string, x: number, y: number, o: { bold?: boolean; size?: number; muted?: boolean; red?: boolean; align?: Align; width?: number } = {}) {
    const size = o.size ?? SIZE;
    const font = this.font(o.bold);
    const t = clean(text, this.f.glyphs);
    const w = font.widthOfTextAtSize(t, size);
    const px = o.align === 'right' ? x + (o.width ?? 0) - w : x;
    this.page.drawText(t, { x: px, y, size, font, color: o.red ? RED : o.muted ? MUTED : INK });
  }
  rule(y = this.y, x1 = MARGIN, x2 = MARGIN + CONTENT_W) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: RULE });
  }
  /** Draws the image at (x, top-aligned y), scaled down to fit, and returns its height (0 when it can't be drawn). */
  async drawImage(img: ImageRef | null, x: number, top: number, maxW: number, maxH: number): Promise<number> {
    if (!img) return 0;
    let embedded: PDFImage;
    try {
      embedded = img.mime === 'image/png' ? await this.doc.embedPng(img.bytes) : await this.doc.embedJpg(img.bytes);
    } catch {
      return 0; // a corrupt logo/signature must not fail the document
    }
    const s = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
    const w = embedded.width * s;
    const h = embedded.height * s;
    this.page.drawImage(embedded, { x, y: top - h, width: w, height: h });
    return h;
  }
}

export async function renderDocument(model: DocModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(model.title);
  doc.setProducer('LexForgeX');
  doc.setCreator('LexForgeX');
  const reg = loadFontBytes('NotoSans-Regular.ttf');
  const bold = loadFontBytes('NotoSans-Bold.ttf');
  const fonts: Fonts = {
    regular: await doc.embedFont(reg.bytes, { subset: true }),
    bold: await doc.embedFont(bold.bytes, { subset: true }),
    glyphs: reg.glyphs,
  };
  const p = new Painter(doc, fonts);
  for (const b of model.blocks) await drawBlock(p, b);
  // Plain objects (no object streams) keep the font names greppable in the file.
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const LH = 1.35;

async function drawBlock(p: Painter, b: Block): Promise<void> {
  switch (b.kind) {
    case 'spacer':
      p.y -= b.h;
      return;
    case 'text': {
      const size = b.size ?? SIZE;
      for (const line of p.wrap(b.text, b.bold, size, CONTENT_W)) {
        p.need(size * LH);
        p.y -= size * LH;
        p.draw(line, MARGIN, p.y + size * 0.25, { bold: b.bold, size, muted: b.muted });
      }
      return;
    }
    case 'banner': {
      p.need(26);
      p.y -= 24;
      p.page.drawRectangle({ x: MARGIN, y: p.y, width: CONTENT_W, height: 20, borderColor: RED, borderWidth: 0.8 });
      p.draw(b.text, MARGIN + 8, p.y + 6, { bold: true, red: true });
      p.y -= 4;
      return;
    }
    case 'header': {
      const right = 190;
      const leftW = CONTENT_W - right - 12;
      const lines = b.lines.flatMap((l) => p.wrap(l.text, l.bold, l.size ?? SIZE, leftW).map((t) => ({ ...l, text: t })));
      const logoH = b.logo ? 46 : 0;
      const textH = lines.reduce((s, l) => s + (l.size ?? SIZE) * LH, 0);
      p.need(logoH + textH + 24);
      const top = p.y;
      let y = top;
      if (b.logo) {
        const h = await p.drawImage(b.logo, MARGIN, y, 150, 44);
        y -= h > 0 ? h + 6 : 0;
      }
      for (const l of lines) {
        const size = l.size ?? SIZE;
        y -= size * LH;
        p.draw(l.text, MARGIN, y + size * 0.25, { bold: l.bold, size, muted: l.muted });
      }
      p.draw(b.title, MARGIN + CONTENT_W - right, top - 16, { bold: true, size: 16, align: 'right', width: right });
      if (b.number) p.draw(b.number, MARGIN + CONTENT_W - right, top - 32, { size: 10, align: 'right', width: right });
      p.y = Math.min(y, top - 40) - 8;
      p.rule();
      p.y -= 10;
      return;
    }
    case 'columns': {
      const half = CONTENT_W / 2 - 10;
      const left = b.left.lines.flatMap((t, i) => p.wrap(t, i === 0, SIZE, half).map((x) => ({ x, bold: i === 0 })));
      const rows = b.right.map(([k, v]) => ({ k, lines: p.wrap(v, false, SIZE, half - 90) }));
      const leftH = 11 + left.length * SIZE * LH;
      const rightH = rows.reduce((s, r) => s + Math.max(1, r.lines.length) * SIZE * LH, 0);
      p.need(Math.max(leftH, rightH) + 6);
      const top = p.y;
      p.draw(b.left.label.toUpperCase(), MARGIN, top - 8, { size: 7.5, bold: true, muted: true });
      let ly = top - 11;
      for (const l of left) {
        ly -= SIZE * LH;
        p.draw(l.x, MARGIN, ly + 2.4, { bold: l.bold });
      }
      let ry = top;
      const rx = MARGIN + CONTENT_W / 2 + 10;
      for (const r of rows) {
        ry -= SIZE * LH;
        p.draw(r.k, rx, ry + 2.4, { muted: true });
        for (const [i, t] of r.lines.entries()) {
          if (i > 0) ry -= SIZE * LH;
          p.draw(t, rx + 90, ry + 2.4);
        }
      }
      p.y = Math.min(ly, ry) - 8;
      return;
    }
    case 'table': {
      if (b.title) {
        p.need(40);
        p.y -= 14;
        p.draw(b.title, MARGIN, p.y, { bold: true, size: 10 });
        p.y -= 4;
      }
      const xs: number[] = [];
      let acc = MARGIN;
      for (const c of b.columns) {
        xs.push(acc);
        acc += c.width * CONTENT_W;
      }
      const colW = (i: number) => b.columns[i]!.width * CONTENT_W - 6;
      const header = () => {
        p.need(40);
        p.y -= SIZE * LH + 4;
        b.columns.forEach((c, i) => p.draw(c.header, xs[i]!, p.y + 2, { bold: true, size: 8.5, align: c.align, width: colW(i) }));
        p.rule(p.y - 4);
        p.y -= 6;
      };
      header();
      for (const r of b.rows) {
        const cells = r.cells.map((t, i) => p.wrap(t, false, SIZE, colW(i)));
        const note = r.note ? p.wrap(r.note, false, 8.5, colW(0)) : [];
        const h = Math.max(...cells.map((c) => c.length)) * SIZE * LH + note.length * 8.5 * LH + 6;
        if (p.y - h < BOTTOM) {
          p.newPage();
          header();
        }
        const top = p.y;
        cells.forEach((lines, i) =>
          lines.forEach((t, li) =>
            p.draw(t, xs[i]!, top - (li + 1) * SIZE * LH + 2.4, { align: b.columns[i]!.align, width: colW(i) }),
          ),
        );
        const nTop = top - Math.max(...cells.map((c) => c.length)) * SIZE * LH;
        note.forEach((t, li) => p.draw(t, xs[0]!, nTop - (li + 1) * 8.5 * LH + 2, { size: 8.5, muted: true }));
        p.y = top - h;
        p.rule(p.y + 2);
      }
      p.y -= 4;
      return;
    }
    case 'totals': {
      const w = 230;
      const x = MARGIN + CONTENT_W - w;
      p.need(b.rows.length * SIZE * LH + 8);
      p.y -= 6;
      for (const r of b.rows) {
        if (p.y - SIZE * LH < BOTTOM) p.newPage();
        if (r.strong) p.rule(p.y - 1, x, x + w);
        p.y -= SIZE * LH + (r.strong ? 2 : 0);
        p.draw(r.label, x, p.y + 2.4, { bold: r.strong });
        p.draw(r.value, x, p.y + 2.4, { bold: r.strong, align: 'right', width: w });
      }
      p.y -= 4;
      return;
    }
    case 'box': {
      const w = CONTENT_W;
      const lines = b.lines.flatMap((t) => p.wrap(t, false, SIZE, w - 20));
      const h = 24 + lines.length * SIZE * LH;
      p.need(h + 10);
      p.y -= 8;
      p.page.drawRectangle({ x: MARGIN, y: p.y - h, width: w, height: h, borderColor: RULE, borderWidth: 0.8 });
      p.draw(b.title, MARGIN + 10, p.y - 14, { bold: true, size: 9 });
      lines.forEach((t, i) => p.draw(t, MARGIN + 10, p.y - 14 - (i + 1) * SIZE * LH, {}));
      p.y -= h + 4;
      return;
    }
    case 'signature': {
      const imgH = b.image ? 48 : 0;
      // Exact height of this block (gap, image or blank line, rule, text) plus the two footer lines that follow it.
      const h = 14 + (b.image ? imgH + 4 : 26) + b.lines.length * SIZE * LH + 6 + 6 + 2 * 8.5 * LH;
      p.need(h);
      p.y -= 14;
      const x = MARGIN + CONTENT_W - 200;
      let y = p.y;
      if (b.image) {
        const drawn = await p.drawImage(b.image, x, y, 160, 44);
        y -= drawn > 0 ? drawn + 4 : 0;
      } else {
        y -= 26;
      }
      p.rule(y, x, x + 200);
      for (const t of b.lines) {
        y -= SIZE * LH;
        p.draw(t, x, y + 2.4, { bold: t === b.lines[0] });
      }
      p.y = y - 6;
      return;
    }
  }
}
