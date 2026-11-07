import type { DocBlock, DocLine, WireDocModel, WireImage } from '@legalops/types';
import type { CSSProperties, ReactNode } from 'react';

type Block = DocBlock<WireImage>;

const INK = '#1a1a1a';
const MUTED = '#666666';
const RULE_GREY = '#9ea3ad';
const WM_TOP = { top: '28%', center: '50%', bottom: '72%' } as const;

/** Sizes are in points, like the PDF, so the screen, the print and the PDF read the same. */
const lineStyle = (l: DocLine, accent: string, extra?: CSSProperties): CSSProperties => ({
  fontSize: `${l.size ?? 9.5}pt`,
  fontWeight: l.bold ? 700 : 400,
  color: l.accent ? accent : l.muted ? MUTED : INK,
  lineHeight: 1.35,
  ...extra,
});

function Text({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', ...style }}>{children}</p>;
}

function BlockView({ b, accent, rule }: { b: Block; accent: string; rule: string }) {
  switch (b.kind) {
    case 'spacer':
      return <div style={{ height: `${b.h}pt` }} />;
    case 'text':
      return (
        <Text
          style={{
            fontSize: `${b.size ?? 9.5}pt`,
            fontWeight: b.bold ? 700 : 400,
            color: b.muted ? MUTED : INK,
            lineHeight: 1.35,
            marginTop: '3pt',
          }}
        >
          {b.text}
        </Text>
      );
    case 'banner':
      return (
        <Text
          style={{
            margin: '8pt 0',
            border: '0.8pt solid #b31b1b',
            color: '#b31b1b',
            fontWeight: 700,
            padding: '4pt 8pt',
            fontSize: '9.5pt',
          }}
        >
          {b.text}
        </Text>
      );
    case 'letterhead':
      return (
        <header style={{ textAlign: b.align }}>
          {b.logo ? (
            <img
              src={b.logo.src}
              alt=""
              style={{
                maxHeight: `${b.logoHeight}pt`,
                maxWidth: '100%',
                margin: b.align === 'center' ? '0 auto 8pt' : '0 0 8pt',
                display: 'block',
                objectFit: 'contain',
              }}
            />
          ) : null}
          {b.lines.map((l, n) => (
            <Text key={n} style={lineStyle(l, accent)}>
              {l.text}
            </Text>
          ))}
          {b.rule ? (
            <div style={{ height: 0, borderTop: `1.6pt solid ${rule}`, margin: '10pt 0 0' }} />
          ) : null}
        </header>
      );
    case 'title':
      return (
        <h1
          style={{
            margin: '14pt 0 4pt',
            fontSize: '24pt',
            lineHeight: 1.15,
            fontWeight: 700,
            color: accent,
            textAlign: b.align,
          }}
        >
          {b.text}
        </h1>
      );
    case 'parties': {
      const billed = (
        <div key="billed" style={{ flex: '0 0 54%', minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '8pt', fontWeight: 700, color: MUTED }}>{b.left.label}</p>
          <p
            style={{
              margin: '3pt 0 0',
              fontSize: '12pt',
              fontWeight: 700,
              lineHeight: 1.3,
              overflowWrap: 'anywhere',
            }}
          >
            {b.left.name}
          </p>
          {b.left.lines.map((t, n) => (
            <Text key={n} style={{ fontSize: '9.5pt', color: MUTED, lineHeight: 1.4 }}>
              {t}
            </Text>
          ))}
        </div>
      );
      const details = (
        <div key="details" style={{ flex: '0 0 40%', minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '8pt', fontWeight: 700, color: MUTED }}>{b.right.label}</p>
          <div style={{ marginTop: '3pt' }}>
            {b.right.rows.map((r) => (
              <div
                key={r.label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '8pt',
                  fontSize: '9.5pt',
                  lineHeight: 1.7,
                }}
              >
                <span style={{ color: MUTED }}>{r.label}</span>
                <span style={{ fontWeight: 700, textAlign: 'right', overflowWrap: 'anywhere' }}>
                  {r.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
      return (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6%', margin: '14pt 0 10pt' }}>
          {b.detailsSide === 'right' ? [billed, details] : [details, billed]}
        </div>
      );
    }
    case 'subject':
      return (
        <p style={{ margin: '10pt 0 6pt', fontSize: '10.5pt', lineHeight: 1.35 }}>
          {b.label ? <strong style={{ marginRight: '6pt' }}>{b.label}</strong> : null}
          {b.text}
        </p>
      );
    case 'table': {
      const filled = Boolean(b.filled);
      const nc = b.noteColumn ?? 0;
      return (
        <div style={{ margin: '8pt 0 4pt' }}>
          {b.title ? (
            <p
              style={{
                margin: '8pt 0 4pt',
                fontSize: filled ? '8pt' : '10pt',
                fontWeight: 700,
                color: filled ? MUTED : INK,
              }}
            >
              {b.title}
            </p>
          ) : null}
          <table
            style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '9.5pt' }}
          >
            <colgroup>
              {b.columns.map((c, i) => (
                <col key={i} style={{ width: `${c.width * 100}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr
                style={
                  filled
                    ? { background: accent, color: '#fff' }
                    : { borderBottom: `0.6pt solid ${RULE_GREY}` }
                }
              >
                {b.columns.map((c, i) => (
                  <th
                    key={i}
                    style={{
                      textAlign: c.align,
                      padding: filled ? '6pt 8pt' : '3pt 4pt 3pt 0',
                      fontSize: filled ? '9pt' : '8.5pt',
                      fontWeight: 700,
                      ...(filled ? { background: accent, boxShadow: `0 0 0 0.5px ${accent}` } : {}),
                    }}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr
                  key={ri}
                  style={{ verticalAlign: 'top', borderBottom: filled ? undefined : '0.6pt solid #d5d5d5' }}
                >
                  {r.cells.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        textAlign: b.columns[ci]!.align,
                        padding: filled ? '6pt 8pt' : '3pt 4pt 3pt 0',
                        overflowWrap: 'anywhere',
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.35,
                      }}
                    >
                      {cell}
                      {r.note && ci === nc ? (
                        <span style={{ display: 'block', fontSize: '8.5pt', color: MUTED }}>{r.note}</span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {filled ? <div style={{ borderTop: `1.2pt solid ${RULE_GREY}` }} /> : null}
        </div>
      );
    }
    case 'totals': {
      return (
        <div
          style={{
            marginLeft: b.accent ? '60%' : 'auto',
            width: b.accent ? '40%' : '230pt',
            maxWidth: '100%',
            padding: '8pt 0 0',
          }}
        >
          {b.rows.map((r) => {
            const big = Boolean(b.accent && r.strong);
            return (
              <div
                key={r.label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '8pt',
                  fontSize: big ? '12pt' : '9.5pt',
                  fontWeight: r.strong ? 700 : 400,
                  color: big ? accent : INK,
                  lineHeight: 1.5,
                  paddingRight: b.accent ? '14pt' : 0,
                  borderTop: r.strong && !b.accent ? `0.6pt solid ${RULE_GREY}` : undefined,
                }}
              >
                <span>{r.label}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
              </div>
            );
          })}
        </div>
      );
    }
    case 'labeled':
      return (
        <section style={{ margin: '12pt 0 4pt' }}>
          <p style={{ margin: 0, fontSize: '8pt', fontWeight: 700, color: MUTED }}>{b.label}</p>
          <div style={{ marginTop: '4pt' }}>
            {b.lines.map((l, n) => (
              <Text
                key={n}
                style={{
                  fontSize: '9.5pt',
                  lineHeight: 1.4,
                  paddingLeft: l.indent ? '14pt' : 0,
                  color: l.indent ? MUTED : INK,
                }}
              >
                {l.text}
              </Text>
            ))}
          </div>
        </section>
      );
    case 'box':
      return (
        <section style={{ margin: '10pt 0', border: `0.8pt solid ${RULE_GREY}`, padding: '8pt 10pt' }}>
          <p style={{ margin: 0, fontSize: '9pt', fontWeight: 700 }}>{b.title}</p>
          {b.lines.map((t, n) => (
            <Text key={n} style={{ fontSize: '9.5pt', lineHeight: 1.4 }}>
              {t}
            </Text>
          ))}
        </section>
      );
    case 'signature': {
      const justify = b.align === 'left' ? 'flex-start' : b.align === 'center' ? 'center' : 'flex-end';
      return (
        <div style={{ display: 'flex', justifyContent: justify, margin: '22pt 0 0', breakInside: 'avoid' }}>
          <div style={{ minWidth: '200pt', maxWidth: '100%' }}>
            {b.heading ? <p style={{ margin: 0, fontSize: '9.5pt' }}>{b.heading}</p> : null}
            <div
              style={{
                height: b.image ? 'auto' : '26pt',
                minHeight: '26pt',
                display: 'flex',
                alignItems: 'flex-end',
              }}
            >
              {b.image ? (
                <img
                  src={b.image.src}
                  alt="Signature"
                  style={{ maxHeight: '44pt', maxWidth: '160pt', objectFit: 'contain' }}
                />
              ) : null}
            </div>
            <div style={{ borderTop: `0.8pt solid ${RULE_GREY}`, paddingTop: '3pt' }}>
              {b.lines.map((t, n) => (
                <Text
                  key={n}
                  style={{
                    fontSize: '9.5pt',
                    fontWeight: n === 0 ? 700 : 400,
                    color: n === 0 && b.accentName ? accent : n === 0 ? INK : MUTED,
                  }}
                >
                  {t}
                </Text>
              ))}
            </div>
          </div>
        </div>
      );
    }
    case 'header':
    case 'columns':
      return null; // receipts only; they have their own page
  }
}

/**
 * Draws the server's invoice document model as an A4 sheet, for the print page and the invoice-format preview. It is
 * the same model the PDF is made from, so what is on screen is what is downloaded and emailed.
 */
export function InvoiceDocument({ model, forPrint = false }: { model: WireDocModel; forPrint?: boolean }) {
  const accent = model.theme?.accent ?? INK;
  const rule = model.theme?.rule ?? RULE_GREY;
  const f = model.footer;
  const wm = model.watermark;
  return (
    <div
      className="invoice-sheet"
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        width: '210mm',
        minHeight: '297mm',
        margin: '0 auto',
        padding: '14mm 14mm 10mm',
        background: '#fff',
        color: INK,
        fontFamily: '"Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {forPrint ? (
        <style>{`@page { size: A4; margin: 0 } @media print { body { background: #fff !important } .invoice-sheet { box-shadow: none !important; min-height: 296mm !important } }`}</style>
      ) : null}
      {wm ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: WM_TOP[wm.position],
            transform: `translateY(-50%)`,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          {wm.kind === 'image' ? (
            <img
              src={wm.image.src}
              alt=""
              style={{
                width: `${wm.scale * 100}%`,
                maxHeight: '60%',
                objectFit: 'contain',
                opacity: wm.opacity,
                transform: `rotate(${wm.rotation}deg)`,
              }}
            />
          ) : (
            // Sized so the text is about `scale` of the page wide (bold capitals average roughly 0.64 em per letter), like the PDF.
            <span
              style={{
                fontSize: `${Math.min(160, (wm.scale * 595) / Math.max(1, wm.text.length * 0.64))}pt`,
                whiteSpace: 'nowrap',
                fontWeight: 700,
                color: '#595959',
                opacity: wm.opacity,
                transform: `rotate(${wm.rotation}deg)`,
                lineHeight: 1,
              }}
            >
              {wm.text}
            </span>
          )}
        </div>
      ) : null}
      <div style={{ position: 'relative', zIndex: 1, flex: '1 0 auto' }}>
        {model.blocks.map((b, i) => (
          <BlockView key={i} b={b} accent={accent} rule={rule} />
        ))}
      </div>
      {f ? (
        <footer
          style={{
            position: 'relative',
            zIndex: 1,
            marginTop: '18pt',
            textAlign: 'center',
            color: MUTED,
            breakInside: 'avoid',
          }}
        >
          {f.thankYou ? (
            <p style={{ margin: '0 0 6pt', fontSize: '8pt', fontWeight: 700 }}>{f.thankYou}</p>
          ) : null}
          {f.rule && (f.thankYou || f.contact || f.tagline) ? (
            <div style={{ borderTop: `1.4pt solid ${rule}`, marginBottom: '6pt' }} />
          ) : null}
          {f.contact ? <p style={{ margin: 0, fontSize: '8pt' }}>{f.contact}</p> : null}
          {f.tagline ? (
            <p
              style={{
                margin: '4pt 0 0',
                fontSize: '7.5pt',
                fontWeight: 700,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
              }}
            >
              {f.tagline}
            </p>
          ) : null}
          {f.poweredBy ? <p style={{ margin: '6pt 0 0', fontSize: '7pt' }}>Powered by LexForgeX</p> : null}
        </footer>
      ) : null}
    </div>
  );
}
