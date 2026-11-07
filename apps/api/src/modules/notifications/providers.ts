import { SendEmailCommand, SESv2Client, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import type { Env } from '../../config/env.js';

export type EmailAttachment = { filename: string; contentType: string; content: Buffer };
export type EmailMessage = {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  cc?: string[];
  attachments?: EmailAttachment[];
  /** Display name for the sender; the address always comes from EMAIL_FROM. Unset: EMAIL_FROM as configured. */
  fromName?: string | null;
};
export type EmailDeliveryResult = { providerMessageId: string };

/** Splits EMAIL_FROM (`Name <addr>`, `"Name" <addr>` or a bare address) into its display name and address. */
export function parseFromAddress(from: string): { name: string | null; address: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  if (!m) return { name: null, address: from.trim() };
  let name = m[1]!.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return { name: name || null, address: m[2]! };
}

/** Header-safe display name: no CR/LF (header injection), surrounding space trimmed. */
const cleanName = (name: string) => name.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * RFC 5322 mailbox for a raw header string (SES): ASCII names as a quoted-string with `\` and `"` escaped; anything
 * else as an RFC 2047 UTF-8 encoded-word, which SES requires for non-ASCII display names.
 */
export function formatMailbox(name: string, address: string): string {
  const n = cleanName(name);
  if (!n) return address;
  if (/^[\x20-\x7e]*$/.test(n)) return `"${n.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  // Encoded-words stay within 75 characters (RFC 2047): at most 45 bytes each, split on character boundaries.
  const words: string[] = [];
  let chunk = '';
  for (const ch of n) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return `${words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ')} <${address}>`;
}

/** Transient errors are retried with backoff; permanent ones fail immediately (PRD §8.3). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** PRD §8.1. Providers report what actually happened; they never invent delivery states. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/** Dev: real SMTP delivery to Mailpit (http://localhost:8025). Also usable for any SMTP relay. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: EmailMessage): Promise<EmailDeliveryResult> {
    try {
      const info = await this.transport.sendMail({
        // nodemailer quotes/encodes a structured name itself.
        from: m.fromName ? { name: cleanName(m.fromName), address: parseFromAddress(this.from).address } : this.from,
        to: m.toName ? { name: m.toName, address: m.to } : m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        ...(m.cc?.length ? { cc: m.cc } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })) } : {}),
      });
      if (!info.messageId) throw new ProviderError('SMTP server returned no message id', false);
      return { providerMessageId: info.messageId };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const code = (err as { responseCode?: number }).responseCode;
      // 5xx SMTP replies are permanent (bad recipient etc.); connection problems and 4xx are transient.
      throw new ProviderError((err as Error).message, typeof code === 'number' && code >= 500);
    }
  }
}

/**
 * Production: Amazon SES v2. NOT yet exercised against real SES (no credentials in this environment).
 * Delivery/bounce events need an SES configuration set + SNS webhook (deferred); until then the best
 * honest status is "sent".
 */
export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';
  private readonly client: SESv2Client;
  constructor(
    region: string,
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {
    this.client = new SESv2Client({ region });
  }
  async send(m: EmailMessage): Promise<EmailDeliveryResult> {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: m.fromName ? formatMailbox(m.fromName, parseFromAddress(this.from).address) : this.from,
          Destination: {
            ToAddresses: [m.toName ? `"${m.toName.replace(/"/g, '')}" <${m.to}>` : m.to],
            ...(m.cc?.length ? { CcAddresses: m.cc } : {}),
          },
          ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: m.subject, Charset: 'UTF-8' },
              Body: { Html: { Data: m.html, Charset: 'UTF-8' }, Text: { Data: m.text, Charset: 'UTF-8' } },
              // SESv2 Simple content takes attachments natively (SDK 3.1145), so no hand-built MIME is needed.
              ...(m.attachments?.length
                ? {
                    Attachments: m.attachments.map((a) => ({
                      FileName: a.filename,
                      ContentType: a.contentType,
                      RawContent: a.content,
                      ContentDisposition: 'ATTACHMENT' as const,
                      ContentTransferEncoding: 'BASE64' as const,
                    })),
                  }
                : {}),
            },
          },
          ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
        }),
      );
      if (!out.MessageId) throw new ProviderError('SES returned no MessageId', false);
      return { providerMessageId: out.MessageId };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof SESv2ServiceException) {
        const permanent = ['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'BadRequestException', 'SendingPausedException'].includes(err.name);
        throw new ProviderError(`${err.name}: ${err.message}`, permanent);
      }
      throw new ProviderError((err as Error).message, false);
    }
  }
}

/** Email switched off: sending is refused as a transient error so nothing is falsely marked sent. */
export class DisabledEmailProvider implements EmailProvider {
  readonly name = 'disabled';
  async send(): Promise<EmailDeliveryResult> {
    throw new ProviderError('Email sending is disabled (EMAIL_PROVIDER=disabled)', false);
  }
}

export function createEmailProvider(env: Env): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'smtp':
      return new SmtpEmailProvider(env.SMTP_URL, env.EMAIL_FROM);
    case 'ses':
      return new SesEmailProvider(env.AWS_REGION, env.EMAIL_FROM, env.SES_CONFIGURATION_SET);
    default:
      return new DisabledEmailProvider();
  }
}
