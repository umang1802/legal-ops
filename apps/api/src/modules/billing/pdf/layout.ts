import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { toPaise } from '@legalops/validation';
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import type { DocAlign, DocBlock, DocLine, DocModel as GenericDocModel, DocWatermark } from '@legalops/types';

/**
 * Shared PDF plumbing. Documents are described as a plain `DocModel` (text blocks and tables) by
 * `invoiceDocumentModel` / `receiptDocumentModel`; `renderDocument` only draws that model with the embedded Noto Sans.
 * Keeping the two apart lets tests assert on content without extracting text from subset-embedded fonts. The same model
 * (images as data URIs) is what the browser's print page and the invoice-format preview draw.
 */

export type ImageRef = { bytes: Buffer; mime: 'image/png' | 'image/jpeg' };
export type Align = DocAlign;
export type Line = DocLine;
export type Block = DocBlock<ImageRef>;
export type DocModel = GenericDocModel<ImageRef>;

/** Every string in the model, one per line: what tests (and humans) read instead of extracting text from the PDF. */
export function modelText(model: DocModel): string {
  const out: string[] = [model.title];
  for (const b of model.blocks) {
    switch (b.kind) {
      case 'header':
        out.push(...b.lines.map((l) => l.text), b.title, b.number ?? '');
        break;
      case 'letterhead':
        out.push(...b.lines.map((l) => l.text));
        break;
      case 'title':
        out.push(b.text);
        break;
      case 'parties':
        out.push(b.left.label, b.left.name, ...b.left.lines, b.right.label, ...b.right.rows.flatMap((r) => [r.label, r.value]));
        break;
      case 'subject':
        out.push(`${b.label} ${b.text}`);
        break;
      case 'labeled':
        out.push(b.label, ...b.lines.map((l) => l.text));
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
        out.push(b.heading ?? '', ...b.lines);
        break;
      case 'spacer':
        break;
    }
  }
  if (model.footer) out.push(model.footer.thankYou ?? '', model.footer.contact ?? '', model.footer.tagline ?? '', model.footer.poweredBy ? 'Powered by LexForgeX' : '');
  if (model.watermark?.kind === 'text') out.push(model.watermark.text);
  return out.filter(Boolean).join('\n');
}

// ---- Formatting ----

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** '50000.00' -> '₹50,000.00' (Indian grouping). */
export const formatINR = (amount: string | null | undefined): string => (amount == null ? '—' : inr.format(toPaise(amount) / 100));
export const isZero = (amount: string): boolean => toPaise(amount) === 0;

const plain = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** '15000.00' -> 'Rs. 15,000.00' or '₹15,000.00', per the firm's invoice format. */
export function formatMoney(amount: string | null | undefined, style: 'rs' | 'symbol'): string {
  if (amount == null) return '—';
  return style === 'symbol' ? formatINR(amount) : `Rs. ${plain.format(toPaise(amount) / 100)}`;
}

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
const WHITE = rgb(1, 1, 1);
const SIZE = 9.5;

type Rgb = ReturnType<typeof rgb>;
type Fonts = { regular: PDFFont; bold: PDFFont; glyphs: FontKit };

/** '#2F4E7B' -> pdf-lib colour. The schema guarantees the shape; anything else falls back to ink. */
function hexColor(hex: string | undefined, fallback: Rgb = INK): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  return m ? rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255) : fallback;
}

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
  /** The lowest y the body may reach; raised to make room for a footer. */
  bottom = BOTTOM;
  accent: Rgb = INK;
  rule_: Rgb = RULE;
  private readonly images = new Map<Buffer, PDFImage | null>();
  constructor(
    private readonly doc: PDFDocument,
    private readonly f: Fonts,
    private readonly underlay: ((page: PDFPage) => void) | null = null,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.underlay?.(this.page); // the watermark goes down first, so everything else is drawn over it
    this.y = PAGE_H - MARGIN;
  }
  need(h: number) {
    if (this.y - h < this.bottom) this.newPage();
  }
  font(bold?: boolean) {
    return bold ? this.f.bold : this.f.regular;
  }
  wrap(text: string, bold: boolean | undefined, size: number, width: number) {
    return wrapText(clean(text, this.f.glyphs), this.font(bold), size, width);
  }
  width(text: string, bold: boolean | undefined, size: number) {
    return this.font(bold).widthOfTextAtSize(clean(text, this.f.glyphs), size);
  }
  draw(
    text: string,
    x: number,
    y: number,
    o: { bold?: boolean; size?: number; muted?: boolean; red?: boolean; accent?: boolean; color?: Rgb; align?: Align | 'center'; width?: number } = {},
  ) {
    const size = o.size ?? SIZE;
    const font = this.font(o.bold);
    const t = clean(text, this.f.glyphs);
    const w = font.widthOfTextAtSize(t, size);
    const px = o.align === 'right' ? x + (o.width ?? 0) - w : o.align === 'center' ? x + ((o.width ?? 0) - w) / 2 : x;
    const color = o.color ?? (o.red ? RED : o.accent ? this.accent : o.muted ? MUTED : INK);
    this.page.drawText(t, { x: px, y, size, font, color });
  }
  /** Small caps-style text with extra space between the letters (pdf-lib has no letter-spacing). Centred on `cx`. */
  drawSpaced(text: string, cx: number, y: number, size: number, spacing: number, color: Rgb, bold = false) {
    const t = clean(text, this.f.glyphs);
    const font = this.font(bold);
    const chars = [...t];
    const total = chars.reduce((s, ch) => s + font.widthOfTextAtSize(ch, size) + spacing, -spacing);
    let x = cx - total / 2;
    for (const ch of chars) {
      this.page.drawText(ch, { x, y, size, font, color });
      x += font.widthOfTextAtSize(ch, size) + spacing;
    }
  }
  rule(y = this.y, x1 = MARGIN, x2 = MARGIN + CONTENT_W, color: Rgb = RULE, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }
  async embed(img: ImageRef): Promise<PDFImage | null> {
    if (this.images.has(img.bytes)) return this.images.get(img.bytes)!;
    let embedded: PDFImage | null = null;
    try {
      embedded = img.mime === 'image/png' ? await this.doc.embedPng(img.bytes) : await this.doc.embedJpg(img.bytes);
    } catch {
      embedded = null; // a corrupt logo/signature must not fail the document
    }
    this.images.set(img.bytes, embedded);
    return embedded;
  }
  /** Draws the image top-aligned at y, scaled down to fit, and returns its height (0 when it can't be drawn). */
  async drawImage(img: ImageRef | null, x: number, top: number, maxW: number, maxH: number, centerIn?: { x: number; w: number }): Promise<number> {
    if (!img) return 0;
    const embedded = await this.embed(img);
    if (!embedded) return 0;
    const s = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
    const w = embedded.width * s;
    const h = embedded.height * s;
    const px = centerIn ? centerIn.x + (centerIn.w - w) / 2 : x;
    this.page.drawImage(embedded, { x: px, y: top - h, width: w, height: h });
    return h;
  }
}

/** Where a rotated box's bottom-left corner goes so that the box is rotated about its own centre (cx, cy). */
function rotatedOrigin(cx: number, cy: number, w: number, h: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  return { x: cx - ((w / 2) * Math.cos(t) - (h / 2) * Math.sin(t)), y: cy - ((w / 2) * Math.sin(t) + (h / 2) * Math.cos(t)) };
}
const WM_CENTER_Y = { top: PAGE_H * 0.72, center: PAGE_H * 0.5, bottom: PAGE_H * 0.28 } as const;

async function buildWatermark(doc: PDFDocument, wm: DocWatermark<ImageRef> | undefined, fonts: Fonts): Promise<((page: PDFPage) => void) | null> {
  if (!wm) return null;
  const cx = PAGE_W / 2;
  const cy = WM_CENTER_Y[wm.position];
  if (wm.kind === 'image') {
    let img: PDFImage;
    try {
      img = wm.image.mime === 'image/png' ? await doc.embedPng(wm.image.bytes) : await doc.embedJpg(wm.image.bytes);
    } catch {
      return null;
    }
    const w = PAGE_W * wm.scale;
    const h = Math.min((img.height / img.width) * w, PAGE_H * 0.6);
    const w2 = (img.width / img.height) * h;
    const o = rotatedOrigin(cx, cy, w2, h, wm.rotation);
    return (page) => page.drawImage(img, { x: o.x, y: o.y, width: w2, height: h, opacity: wm.opacity, rotate: degrees(wm.rotation) });
  }
  const text = clean(wm.text, fonts.glyphs);
  if (!text.trim()) return null;
  const unit = fonts.bold.widthOfTextAtSize(text, 1);
  const size = Math.min((PAGE_W * wm.scale) / unit, 160);
  const w = unit * size;
  const o = rotatedOrigin(cx, cy, w, size * 0.7, wm.rotation);
  return (page) => page.drawText(text, { x: o.x, y: o.y, size, font: fonts.bold, color: rgb(0.35, 0.35, 0.35), opacity: wm.opacity, rotate: degrees(wm.rotation) });
}

/** Footer lines from the bottom up: tagline, contact, rule, thank-you. Returns the height it needs. */
function footerParts(model: DocModel) {
  const f = model.footer;
  if (!f) return { height: 0, parts: [] as ('tagline' | 'contact' | 'rule' | 'thanks' | 'powered')[] };
  const parts: ('tagline' | 'contact' | 'rule' | 'thanks' | 'powered')[] = [];
  if (f.poweredBy) parts.push('powered');
  if (f.tagline) parts.push('tagline');
  if (f.contact) parts.push('contact');
  if (f.rule && (f.thankYou || f.contact || f.tagline)) parts.push('rule');
  if (f.thankYou) parts.push('thanks');
  const height = parts.reduce((s, k) => s + (k === 'rule' ? 8 : k === 'tagline' ? 13 : 14), 0) + 14;
  return { height, parts };
}

function drawFooter(p: Painter, page: PDFPage, model: DocModel) {
  const f = model.footer;
  if (!f) return;
  const { parts } = footerParts(model);
  const cx = PAGE_W / 2;
  const prev = p.page;
  p.page = page;
  let y = 22;
  for (const k of parts) {
    if (k === 'powered') {
      p.draw('Powered by LexForgeX', MARGIN, y, { size: 7, muted: true, align: 'center', width: CONTENT_W });
      y += 14;
    } else if (k === 'tagline') {
      p.drawSpaced(f.tagline!.toUpperCase(), cx, y, 7.5, 1.6, MUTED, true);
      y += 13;
    } else if (k === 'contact') {
      p.draw(f.contact!, MARGIN, y, { size: 8, muted: true, align: 'center', width: CONTENT_W });
      y += 14;
    } else if (k === 'rule') {
      p.rule(y + 2, MARGIN, MARGIN + CONTENT_W, p.rule_, 1.4);
      y += 12;
    } else {
      p.draw(f.thankYou!, MARGIN, y, { size: 8, bold: true, muted: true, align: 'center', width: CONTENT_W });
      y += 14;
    }
  }
  p.page = prev;
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
  const underlay = await buildWatermark(doc, model.watermark, fonts);
  const p = new Painter(doc, fonts, underlay);
  if (model.theme) {
    p.accent = hexColor(model.theme.accent);
    p.rule_ = hexColor(model.theme.rule, RULE);
  }
  const footer = footerParts(model);
  if (footer.height) p.bottom = Math.max(BOTTOM, footer.height + 6);
  for (const b of model.blocks) await drawBlock(p, b);
  if (model.footer) for (const page of doc.getPages()) drawFooter(p, page, model);
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
    case 'letterhead': {
      const lines = b.lines.flatMap((l) => p.wrap(l.text, l.bold, l.size ?? SIZE, CONTENT_W).map((t) => ({ ...l, text: t })));
      const textH = lines.reduce((s, l) => s + (l.size ?? SIZE) * LH, 0);
      p.need((b.logo ? b.logoHeight + 8 : 0) + textH + 24);
      let y = p.y;
      if (b.logo) {
        const h = await p.drawImage(b.logo, MARGIN, y, CONTENT_W, b.logoHeight, b.align === 'center' ? { x: MARGIN, w: CONTENT_W } : undefined);
        y -= h > 0 ? h + 8 : 0;
      }
      for (const l of lines) {
        const size = l.size ?? SIZE;
        y -= size * LH;
        p.draw(l.text, MARGIN, y + size * 0.25, { bold: l.bold, size, muted: l.muted, accent: l.accent, align: b.align === 'center' ? 'center' : 'left', width: CONTENT_W });
      }
      y -= 10;
      if (b.rule) {
        p.rule(y, MARGIN, MARGIN + CONTENT_W, p.rule_, 1.6);
        y -= 4;
      }
      p.y = y - 12;
      return;
    }
    case 'title': {
      p.need(40);
      p.y -= 26;
      p.draw(b.text, MARGIN, p.y, { bold: true, size: 24, accent: true, align: b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left', width: CONTENT_W });
      p.y -= 18;
      return;
    }
    case 'parties': {
      const leftW = CONTENT_W * 0.54;
      const rightX = MARGIN + CONTENT_W * 0.6;
      const rightW = CONTENT_W * 0.4;
      const billed = { x: b.detailsSide === 'right' ? MARGIN : rightX, w: b.detailsSide === 'right' ? leftW : rightW };
      const details = { x: b.detailsSide === 'right' ? rightX : MARGIN, w: b.detailsSide === 'right' ? rightW : leftW };
      const name = p.wrap(b.left.name, true, 12, billed.w);
      const rest = b.left.lines.flatMap((t) => p.wrap(t, false, SIZE, billed.w));
      const rows = b.right.rows.map((r) => ({ ...r, lines: p.wrap(r.value, true, SIZE, details.w * 0.55) }));
      const leftH = 16 + name.length * 12 * LH + rest.length * SIZE * LH;
      const rightH = 16 + rows.reduce((s, r) => s + Math.max(1, r.lines.length) * SIZE * 1.6, 0);
      p.need(Math.max(leftH, rightH) + 8);
      const top = p.y;
      p.draw(b.left.label, billed.x, top - 12, { size: 8, bold: true, muted: true });
      let ly = top - 16;
      for (const t of name) {
        ly -= 12 * LH;
        p.draw(t, billed.x, ly + 3, { bold: true, size: 12 });
      }
      for (const t of rest) {
        ly -= SIZE * LH;
        p.draw(t, billed.x, ly + 2.4, { muted: true });
      }
      p.draw(b.right.label, details.x, top - 12, { size: 8, bold: true, muted: true });
      let ry = top - 16;
      for (const r of rows) {
        ry -= SIZE * 1.6;
        p.draw(r.label, details.x, ry + 3, { muted: true });
        for (const [i, t] of r.lines.entries()) {
          if (i > 0) ry -= SIZE * 1.6;
          p.draw(t, details.x + details.w * 0.45, ry + 3, { bold: true, align: 'right', width: details.w * 0.55 });
        }
      }
      p.y = Math.min(ly, ry) - 12;
      return;
    }
    case 'subject': {
      const label = b.label ? `${b.label} ` : '';
      const labelW = label ? p.width(label, true, 10.5) + 6 : 0;
      const lines = p.wrap(b.text, false, 10.5, CONTENT_W - labelW);
      p.need(lines.length * 10.5 * LH + 6);
      p.y -= 6;
      lines.forEach((t, i) => {
        p.y -= 10.5 * LH;
        if (i === 0 && label) p.draw(label.trim(), MARGIN, p.y + 3, { bold: true, size: 10.5 });
        p.draw(t, MARGIN + labelW, p.y + 3, { size: 10.5 });
      });
      p.y -= 8;
      return;
    }
    case 'labeled': {
      p.need(36);
      p.y -= 12;
      p.draw(b.label, MARGIN, p.y, { size: 8, bold: true, muted: true });
      p.y -= 4;
      for (const l of b.lines) {
        const indent = l.indent ? 14 : 0;
        for (const t of p.wrap(l.text, false, SIZE, CONTENT_W - indent)) {
          p.need(SIZE * LH);
          p.y -= SIZE * LH;
          p.draw(t, MARGIN + indent, p.y + 2.4, { muted: Boolean(l.indent) });
        }
      }
      p.y -= 6;
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
        p.draw(b.title, MARGIN, p.y, b.filled ? { bold: true, size: 8, muted: true } : { bold: true, size: 10 });
        p.y -= 4;
      }
      const xs: number[] = [];
      let acc = MARGIN;
      for (const c of b.columns) {
        xs.push(acc);
        acc += c.width * CONTENT_W;
      }
      const colW = (i: number) => b.columns[i]!.width * CONTENT_W - 6;
      const padX = b.filled ? 8 : 0;
      const header = () => {
        p.need(40);
        if (b.filled) {
          p.y -= 8;
          p.page.drawRectangle({ x: MARGIN, y: p.y - 22, width: CONTENT_W, height: 22, color: p.accent });
          b.columns.forEach((c, i) =>
            p.draw(c.header, xs[i]! + (c.align === 'left' ? padX : 0), p.y - 15, { bold: true, size: 9, color: WHITE, align: c.align, width: colW(i) - (c.align === 'right' ? padX : 0) }),
          );
          p.y -= 22 + 6;
          return;
        }
        p.y -= SIZE * LH + 4;
        b.columns.forEach((c, i) => p.draw(c.header, xs[i]!, p.y + 2, { bold: true, size: 8.5, align: c.align, width: colW(i) }));
        p.rule(p.y - 4);
        p.y -= 6;
      };
      header();
      for (const r of b.rows) {
        const pad = (i: number) => (b.filled && i === 0 ? padX : 0);
        const cells = r.cells.map((t, i) => p.wrap(t, false, SIZE, colW(i) - pad(i) - (b.filled && b.columns[i]!.align === 'right' ? padX : 0)));
        const nc = b.noteColumn ?? 0;
        const note = r.note ? p.wrap(r.note, false, 8.5, colW(nc) - (nc === 0 ? padX : 0)) : [];
        const h = Math.max(...cells.map((c) => c.length)) * SIZE * LH + note.length * 8.5 * LH + (b.filled ? 10 : 6);
        if (p.y - h < p.bottom) {
          p.newPage();
          header();
        }
        const top = p.y - (b.filled ? 3 : 0);
        cells.forEach((lines, i) =>
          lines.forEach((t, li) => {
            const left = b.columns[i]!.align === 'left';
            p.draw(t, xs[i]! + (left ? pad(i) : 0), top - (li + 1) * SIZE * LH + 2.4, {
              align: b.columns[i]!.align,
              width: colW(i) - (left ? pad(i) : b.filled ? padX : 0),
            });
          }),
        );
        const nTop = top - Math.max(...cells.map((c) => c.length)) * SIZE * LH;
        note.forEach((t, li) => p.draw(t, xs[nc]! + (nc === 0 ? padX : 0), nTop - (li + 1) * 8.5 * LH + 2, { size: 8.5, muted: true }));
        p.y = p.y - h;
        if (!b.filled) p.rule(p.y + 2);
      }
      if (b.filled) p.rule(p.y + 2, MARGIN, MARGIN + CONTENT_W, rgb(0.62, 0.64, 0.68), 1.2);
      p.y -= 4;
      return;
    }
    case 'totals': {
      const w = b.accent ? CONTENT_W * 0.4 : 230;
      const x = MARGIN + CONTENT_W - w;
      p.need(b.rows.length * SIZE * LH + 8);
      p.y -= 6;
      for (const r of b.rows) {
        const big = b.accent && r.strong;
        const size = big ? 12 : SIZE;
        if (p.y - size * LH < p.bottom) p.newPage();
        if (r.strong && !b.accent) p.rule(p.y - 1, x, x + w);
        p.y -= size * LH + (r.strong ? 4 : 0);
        p.draw(r.label, x, p.y + 2.4, { bold: r.strong, size, accent: big });
        p.draw(r.value, x, p.y + 2.4, { bold: r.strong, size, accent: big, align: 'right', width: w - (b.accent ? 14 : 0) });
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
      const heading = b.heading ?? null;
      const blockW = Math.min(CONTENT_W, Math.max(200, heading ? p.width(heading, false, SIZE) + 4 : 200));
      const x = b.align === 'left' ? MARGIN : b.align === 'center' ? MARGIN + (CONTENT_W - blockW) / 2 : MARGIN + CONTENT_W - blockW;
      // Exact height of this block (gap, heading, image or blank line, rule, text) plus the two footer lines that follow it.
      const trailing = b.align ? 0 : 2 * 8.5 * LH; // the older layout follows a signature with two footer lines
      const h = 14 + (heading ? SIZE * LH + 2 : 0) + (b.image ? imgH + 4 : 26) + b.lines.length * SIZE * LH + 6 + 6 + trailing;
      p.need(h);
      p.y -= 14;
      let y = p.y;
      if (heading) {
        y -= SIZE * LH;
        p.draw(heading, x, y + 2.4, {});
        y -= 2;
      }
      if (b.image) {
        const drawn = await p.drawImage(b.image, x, y, 160, 44);
        y -= drawn > 0 ? drawn + 4 : 0;
      } else {
        y -= 26;
      }
      p.rule(y, x, x + blockW, b.accentName ? hexAwareRule(p) : RULE);
      b.lines.forEach((t, i) => {
        y -= SIZE * LH;
        p.draw(t, x, y + 2.4, i === 0 ? { bold: true, accent: b.accentName === true } : { muted: Boolean(heading) });
      });
      p.y = y - 6;
      return;
    }
  }
}

/** The grey rule above a signer's name; kept separate so the accent-coloured name doesn't recolour it. */
function hexAwareRule(_p: Painter): Rgb {
  return rgb(0.62, 0.64, 0.68);
}
