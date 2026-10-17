import { describe, expect, it } from 'vitest';
import { emailLayout, htmlToText, renderTemplate, sanitizeTemplateHtml, unknownVariables } from './render.js';

describe('template rendering', () => {
  it('escapes every substituted value in HTML mode', () => {
    const out = renderTemplate('<p>Dear {{client.name}}</p>', { client: { name: '<script>alert(1)</script> & Co' } }, 'html');
    expect(out).toBe('<p>Dear &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co</p>');
  });

  it('renders text mode without escaping and missing variables as empty', () => {
    expect(renderTemplate('Hi {{ recipient.first_name }} {{nope.x}}!', { recipient: { first_name: 'Meera & co' } }, 'text')).toBe('Hi Meera & co !');
  });

  it('sanitises bodies: strips scripts, handlers and javascript: links but keeps {{variables}} in hrefs', () => {
    const dirty = '<p onclick="x()">Hi</p><script>steal()</script><a href="javascript:evil()">bad</a><a href="{{links.task}}">ok</a><img src=x onerror=y>';
    const clean = sanitizeTemplateHtml(dirty);
    expect(clean).toBe('<p>Hi</p><a>bad</a><a href="{{links.task}}">ok</a>');
  });

  it('reports unknown variables for the editor', () => {
    expect(unknownVariables('{{client.name}} {{clinet.name}}', new Set(['client.name']))).toEqual(['clinet.name']);
  });

  it('builds a plain-text alternative and an escaped layout', () => {
    expect(htmlToText('<p>Hello</p><p><a href="https://x.test/t">Open</a></p>')).toBe('Hello\nOpen (https://x.test/t)');
    expect(emailLayout('<p>x</p>', { name: 'A & B', email: null, phone: null })).toContain('A &amp; B');
  });
});
