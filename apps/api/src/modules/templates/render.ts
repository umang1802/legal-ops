import sanitizeHtml from 'sanitize-html';

/** Allow-list for template bodies (PRD §8.2 / Screen 23: no scripts, no arbitrary HTML). */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'],
  allowedAttributes: { a: ['href'], td: ['colspan'], th: ['colspan'] },
  allowedSchemes: ['https', 'http', 'mailto', 'tel'],
  // Variables may sit in hrefs ({{links.task}}); keep them as text for the renderer.
  allowedSchemesAppliedToAttributes: ['href'],
  disallowedTagsMode: 'discard',
};

export function sanitizeTemplateHtml(html: string): string {
  // {{var}} inside href would be dropped as an invalid scheme; protect it during sanitising.
  const protectedHtml = html.replace(/href="\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}"/g, 'href="https://__var__/$1"');
  return sanitizeHtml(protectedHtml, SANITIZE).replace(/href="https:\/\/__var__\/([a-z_]+\.[a-z_]+)"/g, 'href="{{$1}}"');
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const VAR = /\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}/g;

type Vars = Record<string, unknown>;
const lookup = (vars: Vars, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Vars)[k] : undefined), vars);

/**
 * Mustache-style {{path}} substitution. HTML mode escapes every value, so user data can never inject
 * markup. Unknown variables render as empty strings; `unknownVariables` reports them for the editor.
 */
export function renderTemplate(template: string, vars: Vars, mode: 'html' | 'text'): string {
  return template.replace(VAR, (_m, path: string) => {
    const v = lookup(vars, path);
    const s = v === null || v === undefined ? '' : String(v);
    return mode === 'html' ? escapeHtml(s) : s;
  });
}

export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VAR)].map((m) => m[1]!))];
}

export function unknownVariables(template: string, known: Set<string>): string[] {
  return templateVariables(template).filter((v) => !known.has(v));
}

/** Plain-text fallback from the rendered HTML (multipart emails). */
export function htmlToText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h2|h3|li|tr|blockquote)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Minimal, client-safe email layout (inline styles only). */
export function emailLayout(bodyHtml: string, firm: { name: string; email: string | null; phone: string | null }): string {
  const contact = [firm.email, firm.phone].filter(Boolean).map((s) => escapeHtml(s!)).join(' · ');
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6eb;border-radius:12px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e3e6eb;font-weight:600;font-size:16px;color:#1e3a8a">${escapeHtml(firm.name)}</td></tr>
<tr><td style="padding:20px 24px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e3e6eb;font-size:12px;color:#6b7280">${escapeHtml(firm.name)}${contact ? ` · ${contact}` : ''}<br>Sent via LegalOps</td></tr>
</table></td></tr></table></body></html>`;
}
