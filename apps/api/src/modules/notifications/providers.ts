import { SendEmailCommand, SESv2Client, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import type { Env } from '../../config/env.js';

export type EmailMessage = { to: string; toName?: string | null; subject: string; html: string; text: string; replyTo?: string | null };
export type EmailDeliveryResult = { providerMessageId: string };

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
        from: this.from,
        to: m.toName ? { name: m.toName, address: m.to } : m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
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
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [m.toName ? `"${m.toName.replace(/"/g, '')}" <${m.to}>` : m.to] },
          ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: m.subject, Charset: 'UTF-8' },
              Body: { Html: { Data: m.html, Charset: 'UTF-8' }, Text: { Data: m.text, Charset: 'UTF-8' } },
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
