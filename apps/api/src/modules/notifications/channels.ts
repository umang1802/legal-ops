import type { EmailProvider } from './providers.js';

/**
 * PRD §46: workflows and the notification service talk to channels, never to a provider directly.
 * WhatsApp/SMS/push become new channel implementations without touching domain logic.
 */
export type ChannelMessage = {
  destination: string;
  recipientName: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
};

export interface NotificationChannel {
  readonly channel: 'email' | 'whatsapp' | 'sms' | 'push';
  readonly provider: string;
  deliver(message: ChannelMessage): Promise<{ providerMessageId: string }>;
}

export class EmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  constructor(private readonly email: EmailProvider) {}
  get provider() {
    return this.email.name;
  }
  deliver(m: ChannelMessage) {
    return this.email.send({ to: m.destination, toName: m.recipientName, subject: m.subject, html: m.html, text: m.text, replyTo: m.replyTo });
  }
}
