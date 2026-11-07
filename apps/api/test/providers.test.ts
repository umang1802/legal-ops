import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { parseFromAddress, SesEmailProvider, SmtpEmailProvider } from '../src/modules/notifications/providers.js';

describe('SES message building', () => {
  it('SES message includes CC and one attachment', async () => {
    const p = new SesEmailProvider('ap-south-1', 'LexForgeX <no-reply@lfx.test>');
    const send = vi.fn(async (_cmd: unknown) => ({ MessageId: 'ses-1' }));
    (p as unknown as { client: { send: typeof send } }).client = { send };
    const content = Buffer.from('%PDF-1.4 fake');
    const res = await p.send({
      to: 'raj@client.test',
      toName: 'Raj',
      subject: 'Invoice',
      html: '<p>hi</p>',
      text: 'hi',
      cc: ['a@client.test', 'b@client.test'],
      attachments: [{ filename: 'Invoice-1.pdf', contentType: 'application/pdf', content }],
    });
    expect(res.providerMessageId).toBe('ses-1');
    const cmd = send.mock.calls[0]![0] as SendEmailCommand;
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input.Destination).toMatchObject({ CcAddresses: ['a@client.test', 'b@client.test'] });
    const att = cmd.input.Content!.Simple!.Attachments!;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ FileName: 'Invoice-1.pdf', ContentType: 'application/pdf', ContentDisposition: 'ATTACHMENT', ContentTransferEncoding: 'BASE64' });
    expect(Buffer.from(att[0]!.RawContent!).equals(content)).toBe(true);
  });

  it('omits CC and Attachments when there are none', async () => {
    const p = new SesEmailProvider('ap-south-1', 'x@lfx.test');
    const send = vi.fn(async (_cmd: unknown) => ({ MessageId: 'ses-2' }));
    (p as unknown as { client: { send: typeof send } }).client = { send };
    await p.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
    const cmd = send.mock.calls[0]![0] as SendEmailCommand;
    expect(cmd.input.Destination).toEqual({ ToAddresses: ['a@b.test'] });
    expect(cmd.input.Content!.Simple!.Attachments).toBeUndefined();
  });
});

describe('sender display name (K2)', () => {
  const sesWith = (from: string) => {
    const p = new SesEmailProvider('ap-south-1', from);
    const send = vi.fn(async (_cmd: unknown) => ({ MessageId: 'ses-3' }));
    (p as unknown as { client: { send: typeof send } }).client = { send };
    return { p, from: () => (send.mock.calls[0]![0] as SendEmailCommand).input.FromEmailAddress };
  };
  const smtpWith = (from: string) => {
    const p = new SmtpEmailProvider('smtp://localhost:1025', from);
    const sendMail = vi.fn(async (_m: Record<string, unknown>) => ({ messageId: '<m1@test>' }));
    (p as unknown as { transport: { sendMail: typeof sendMail } }).transport = { sendMail };
    return { p, from: () => sendMail.mock.calls[0]![0].from };
  };
  const msg = (fromName?: string | null) => ({ to: 'a@b.test', subject: 's', html: 'h', text: 't', fromName });

  it('parses "Name <addr>" and a bare address', () => {
    expect(parseFromAddress('LexForgeX <notifications@lexforgex.com>')).toEqual({ name: 'LexForgeX', address: 'notifications@lexforgex.com' });
    expect(parseFromAddress('"Lex, Forge" <n@l.test>')).toEqual({ name: 'Lex, Forge', address: 'n@l.test' });
    expect(parseFromAddress('n@l.test')).toEqual({ name: null, address: 'n@l.test' });
  });

  it('SES: quoted display name with escapes, address from EMAIL_FROM', async () => {
    const t = sesWith('LexForgeX <notifications@lexforgex.com>');
    await t.p.send(msg('Shah & "Partners", Advocates via LexForgeX'));
    expect(t.from()).toBe('"Shah & \\"Partners\\", Advocates via LexForgeX" <notifications@lexforgex.com>');
  });

  it('SES: non-ASCII names are MIME encoded-words; CR/LF never reach the header', async () => {
    const t = sesWith('notifications@lexforgex.com');
    await t.p.send(msg('Rāo\r\nBcc: x@evil.test via LexForgeX'));
    const f = t.from()!;
    expect(f).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <notifications@lexforgex\.com>$/);
    const b64 = /\?B\?(.*)\?=/.exec(f)![1]!;
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Rāo Bcc: x@evil.test via LexForgeX');
  });

  it('SES: a long non-ASCII name is split into encoded-words of at most 75 characters', async () => {
    const t = sesWith('notifications@lexforgex.com');
    const name = 'श्री राम एंड एसोसिएट्स एडवोकेट्स via LexForgeX';
    await t.p.send(msg(name));
    const words = t.from()!.replace(/ <notifications@lexforgex\.com>$/, '').split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words.map((w) => Buffer.from(/\?B\?(.*)\?=/.exec(w)![1]!, 'base64').toString('utf8')).join('');
    expect(decoded).toBe(name);
  });

  it('SES: without fromName the configured EMAIL_FROM is used as-is', async () => {
    const t = sesWith('LexForgeX <notifications@lexforgex.com>');
    await t.p.send(msg());
    expect(t.from()).toBe('LexForgeX <notifications@lexforgex.com>');
  });

  it('SMTP: structured from with the firm name; default otherwise', async () => {
    const a = smtpWith('LexForgeX <notifications@lexforgex.com>');
    await a.p.send(msg('Shah & "Partners" via LexForgeX'));
    expect(a.from()).toEqual({ name: 'Shah & "Partners" via LexForgeX', address: 'notifications@lexforgex.com' });
    const b = smtpWith('LexForgeX <notifications@lexforgex.com>');
    await b.p.send(msg(null));
    expect(b.from()).toBe('LexForgeX <notifications@lexforgex.com>');
  });
});
