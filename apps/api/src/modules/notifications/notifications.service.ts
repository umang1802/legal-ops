import { SKIP_REASON_LABELS, type NotificationDetailDto, type NotificationDto, type NotificationStatus } from '@legalops/types';
import type { listNotificationsSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso, pageClause } from '../../http/query-helpers.js';
import { matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { issueInvitationToken, issuePasswordResetToken } from '../auth/auth.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { varsForAudience, type Audience } from '../templates/audience.js';
import { emailLayout, htmlToText, renderTemplate, sanitizeTemplateHtml } from '../templates/render.js';
import { resolveTemplate } from '../templates/templates.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { EmailChannel, type NotificationChannel } from './channels.js';
import { buildContext, type ContextRefs } from './context.js';
import { ProviderError } from './providers.js';

export const MAX_ATTEMPTS = 5;
const SENSITIVE_PLACEHOLDER = '[link issued at send time, not stored]';

export type Recipient =
  | { type: 'client'; clientId: string }
  | { type: 'user'; userId: string }
  | { type: 'external'; email: string; name?: string | null };

export type CreateNotificationInput = {
  organizationId: string;
  templateKey: string;
  recipient: Recipient;
  refs: ContextRefs;
  now: Date;
  /** When it should go out (defaults to now). */
  scheduledAt?: Date;
  requiresApproval?: boolean;
  workflowId?: string | null;
  scheduledActionId?: string | null;
  sourceEventId?: string | null;
  createdBy?: string | null;
  idempotencyKey: string;
  extraVars?: Record<string, Record<string, unknown>>;
  /** Password reset / invite: the link is minted at send time and never stored. */
  sensitive?: { kind: 'password_reset'; userId: string } | { kind: 'member_invite'; invitationId: string };
};

/**
 * Creates exactly one notification record per idempotency key (PRD §16/§57: every automated
 * message has a record, even when it isn't sent). Consent and addresses are checked here.
 */
export async function createNotification(db: Db, appUrl: string, input: CreateNotificationInput): Promise<{ id: string; status: NotificationStatus; created: boolean }> {
  const existing = await queryOne<{ id: string; status: NotificationStatus }>(db, sql`SELECT id, status FROM notifications WHERE idempotency_key = ${input.idempotencyKey}`);
  if (existing) return { ...existing, created: false };

  const template = await resolveTemplate(db, input.organizationId, input.templateKey);
  if (!template) throw new Error(`Email template "${input.templateKey}" not found`);

  const context = await buildContext(db, input.organizationId, { ...input.refs, ...(input.recipient.type === 'client' ? { clientId: input.recipient.clientId } : {}) }, input.now, appUrl);
  // A client recipient is always rendered as client audience, whatever the template row says.
  const audience: Audience = input.recipient.type === 'client' ? 'client' : (template.audience as Audience);
  const vars: Record<string, Record<string, unknown>> = varsForAudience({ ...context.vars, ...(input.extraVars ?? {}) }, audience);

  // Recipient + consent.
  let destination: string | null = null;
  let recipientName: string | null = null;
  let skipReason: string | null = null;
  if (input.recipient.type === 'client') {
    const c = await queryOne<{ name: string; email: string | null; email_notifications_enabled: boolean }>(
      db,
      sql`SELECT name, email, email_notifications_enabled FROM clients WHERE id = ${input.recipient.clientId}`,
    );
    recipientName = c?.name ?? null;
    destination = c?.email ?? null;
    if (c && !c.email_notifications_enabled) skipReason = 'client_opted_out';
    else if (!destination) skipReason = 'no_destination';
  } else if (input.recipient.type === 'user') {
    const u = await queryOne<{ first_name: string; last_name: string | null; email: string; active: boolean }>(
      db,
      sql`SELECT u.first_name, u.last_name, u.email,
                 (u.is_active AND EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id AND m.organization_id = ${input.organizationId} AND m.status = 'active')) AS active
          FROM users u WHERE u.id = ${input.recipient.userId}`,
    );
    recipientName = u ? `${u.first_name} ${u.last_name ?? ''}`.trim() : null;
    destination = u?.email ?? null;
    vars.recipient = { first_name: u?.first_name ?? '', name: recipientName ?? '' };
    if (!u?.active) skipReason = 'user_inactive';
  } else {
    destination = input.recipient.email;
    recipientName = input.recipient.name ?? null;
    vars.recipient = { first_name: recipientName ?? '', name: recipientName ?? '' };
  }
  if (input.sensitive) vars.links = { ...(vars.links ?? {}), reset_password: SENSITIVE_PLACEHOLDER, accept_invite: SENSITIVE_PLACEHOLDER };

  const subject = renderTemplate(template.subject_template, vars, 'text');
  const bodyHtml = renderTemplate(sanitizeTemplateHtml(template.html_body), vars, 'html');
  const bodyText = template.text_body ? renderTemplate(template.text_body, vars, 'text') : htmlToText(bodyHtml);
  const status: NotificationStatus = skipReason ? 'skipped' : input.requiresApproval && input.recipient.type === 'client' ? 'awaiting_approval' : 'queued';
  const r = context.refs;

  const row = await queryOne<{ id: string }>(
    db,
    sql`INSERT INTO notifications (organization_id, channel, notification_type, recipient_type, recipient_user_id, client_id, matter_id,
                                   invoice_id, hearing_id, task_id, payment_id, template_id, workflow_id, scheduled_action_id,
                                   source_event_id, idempotency_key, destination, subject, body_html, body_text, status, skip_reason,
                                   scheduled_at, created_by, metadata)
        VALUES (${input.organizationId}, 'email', ${input.templateKey}, ${input.recipient.type},
                ${input.recipient.type === 'user' ? input.recipient.userId : null},
                ${input.recipient.type === 'client' ? input.recipient.clientId : r.clientId}, ${r.matterId},
                ${r.invoiceId}, ${r.hearingId}, ${r.taskId}, ${r.paymentId}, ${template.id}, ${input.workflowId ?? null},
                ${input.scheduledActionId ?? null}, ${input.sourceEventId ?? null}, ${input.idempotencyKey}, ${destination},
                ${subject}, ${bodyHtml}, ${bodyText}, ${status}, ${skipReason}, ${(input.scheduledAt ?? input.now).toISOString()},
                ${input.createdBy ?? null},
                ${JSON.stringify({ recipientName, ...(input.sensitive ? { sensitive: input.sensitive } : {}) })})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`,
  );
  if (!row) {
    const again = (await queryOne<{ id: string; status: NotificationStatus }>(db, sql`SELECT id, status FROM notifications WHERE idempotency_key = ${input.idempotencyKey}`))!;
    return { ...again, created: false };
  }
  if (skipReason && r.matterId && input.recipient.type === 'client') {
    await addTimelineEvent(db, {
      organizationId: input.organizationId,
      matterId: r.matterId,
      clientId: r.clientId,
      eventType: 'notification.skipped',
      title: `Email not sent: ${subject}`,
      description: SKIP_REASON_LABELS[skipReason] ?? skipReason,
      actorUserId: null,
      actorType: input.workflowId ? 'workflow' : 'system',
      sourceType: 'notification',
      sourceId: row.id,
    });
  }
  return { id: row.id, status, created: true };
}

/**
 * Sends one due notification (worker). The DB claim makes it safe to call concurrently or twice:
 * only one caller moves it from queued to sending.
 */
export async function sendNotification(deps: Deps & { channel?: NotificationChannel }, id: string, now: Date): Promise<'sent' | 'retry' | 'failed' | 'not_ready'> {
  const db = deps.pool;
  const n = await queryOne<{
    organization_id: string;
    destination: string;
    subject: string;
    body_html: string;
    body_text: string;
    attempts: number;
    matter_id: string | null;
    client_id: string | null;
    recipient_type: string;
    metadata: { recipientName?: string | null; sensitive?: CreateNotificationInput['sensitive'] };
    template_id: string;
  }>(
    db,
    sql`UPDATE notifications SET status = 'sending', attempts = attempts + 1
        WHERE id = ${id} AND status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ${now.toISOString()})
        RETURNING organization_id, destination, subject, body_html, body_text, attempts, matter_id, client_id, recipient_type, metadata, template_id`,
  );
  if (!n) return 'not_ready';
  const channel = deps.channel ?? new EmailChannel(deps.email);
  const firm = (await queryOne<{ name: string; email: string | null; phone: string | null }>(db, sql`SELECT name, email, phone FROM organizations WHERE id = ${n.organization_id}`))!;

  try {
    let html = n.body_html;
    let text = n.body_text;
    // Sensitive links are minted now and only ever exist in the outgoing message.
    if (n.metadata.sensitive) {
      const token =
        n.metadata.sensitive.kind === 'password_reset'
          ? await issuePasswordResetToken(deps, n.metadata.sensitive.userId)
          : await issueInvitationToken(deps, n.metadata.sensitive.invitationId);
      const url = `${deps.env.APP_URL.replace(/\/$/, '')}/${n.metadata.sensitive.kind === 'password_reset' ? 'reset-password' : 'accept-invite'}?token=${token}`;
      html = html.split(SENSITIVE_PLACEHOLDER).join(url);
      text = text.split(SENSITIVE_PLACEHOLDER).join(url);
    }
    const result = await channel.deliver({
      destination: n.destination,
      recipientName: n.metadata.recipientName ?? null,
      subject: n.subject,
      html: emailLayout(html, firm),
      text,
      replyTo: n.recipient_type === 'client' ? firm.email : null,
    });
    await withTransaction(db, async (tx) => {
      await query(
        tx,
        sql`UPDATE notifications SET status = 'sent', sent_at = now(), provider = ${channel.provider}, provider_message_id = ${result.providerMessageId},
              failure_reason = NULL WHERE id = ${id}`,
      );
      if (n.matter_id) {
        await addTimelineEvent(tx, {
          organizationId: n.organization_id,
          matterId: n.matter_id,
          clientId: n.client_id,
          eventType: 'notification.sent',
          title: `Email sent: ${n.subject}`,
          description: `To ${n.metadata.recipientName ?? n.destination}`,
          actorUserId: null,
          actorType: 'system',
          sourceType: 'notification',
          sourceId: id,
          visibility: n.recipient_type === 'client' ? 'client' : 'internal',
        });
      }
      await emitEvent(tx, { organizationId: n.organization_id, eventType: 'NOTIFICATION_SENT', aggregateType: 'notification', aggregateId: id, payload: { notificationId: id } });
    });
    return 'sent';
  } catch (err) {
    const permanent = err instanceof ProviderError ? err.permanent : false;
    const reason = (err as Error).message.slice(0, 500);
    if (!permanent && n.attempts < MAX_ATTEMPTS) {
      // Exponential backoff: 1, 2, 4, 8 minutes.
      const retryAt = new Date(now.getTime() + 60_000 * 2 ** (n.attempts - 1));
      await query(db, sql`UPDATE notifications SET status = 'queued', scheduled_at = ${retryAt.toISOString()}, failure_reason = ${reason} WHERE id = ${id}`);
      return 'retry';
    }
    await withTransaction(db, async (tx) => {
      await query(
        tx,
        sql`UPDATE notifications SET status = 'failed', failed_at = now(), failure_reason = ${reason}, is_permanent_failure = ${permanent} WHERE id = ${id}`,
      );
      if (n.matter_id) {
        await addTimelineEvent(tx, {
          organizationId: n.organization_id,
          matterId: n.matter_id,
          clientId: n.client_id,
          eventType: 'notification.failed',
          title: `Email failed: ${n.subject}`,
          description: reason,
          actorUserId: null,
          actorType: 'system',
          sourceType: 'notification',
          sourceId: id,
        });
      }
      await emitEvent(tx, { organizationId: n.organization_id, eventType: 'NOTIFICATION_FAILED', aggregateType: 'notification', aggregateId: id, payload: { notificationId: id, reason } });
    });
    return 'failed';
  }
}

/** Due queued notifications, oldest first. The worker enqueues these; tests/dev send them inline. */
export async function dueNotificationIds(db: Db, now: Date, limit = 50): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    sql`SELECT id FROM notifications WHERE status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ${now.toISOString()})
        ORDER BY scheduled_at NULLS FIRST LIMIT ${limit}`,
  );
  return rows.map((r) => r.id);
}

/**
 * A crash mid-send is ambiguous (the provider may have accepted it). Rather than risk a duplicate
 * email, such notifications are marked failed with an explanation; a person can retry deliberately.
 */
export async function failInterruptedSends(db: Db, olderThanMinutes = 10): Promise<number> {
  const rows = await query(
    db,
    sql`UPDATE notifications SET status = 'failed', failed_at = now(), failure_reason = 'Interrupted while sending; check the recipient before retrying'
        WHERE status = 'sending' AND updated_at < now() - ${`${olderThanMinutes} minutes`}::interval RETURNING id`,
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Communication center (reads + human actions)
// ---------------------------------------------------------------------------

type ListRow = {
  id: string;
  channel: NotificationDto['channel'];
  notification_type: string;
  recipient_type: NotificationDto['recipientType'];
  metadata: { recipientName?: string | null; sensitive?: unknown };
  destination: string | null;
  client_id: string | null;
  client_name: string | null;
  matter_id: string | null;
  matter_title: string | null;
  subject: string | null;
  status: NotificationStatus;
  skip_reason: string | null;
  scheduled_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  attempts: number;
  provider: string | null;
  provider_message_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  created_by: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: Date;
};

/**
 * Visibility: firm-wide roles see everything; others see messages on matters they can see, or
 * addressed to themselves. Security emails (reset/invite) are only visible to firm admins.
 */
function notificationVisible(ctx: TenantContext): SqlFragment {
  if (ctx.role === 'owner' || ctx.role === 'admin') return sql`TRUE`;
  return sql`(n.notification_type NOT IN ('password_reset', 'member_invite')
              AND ((n.matter_id IS NOT NULL AND ${matterVisible(ctx, sql.raw('n.matter_id'))}) OR n.recipient_user_id = ${ctx.userId}))`;
}

const toDto = (r: ListRow): NotificationDto => ({
  id: r.id,
  channel: r.channel,
  notificationType: r.notification_type,
  recipientType: r.recipient_type,
  recipientName: r.metadata?.recipientName ?? null,
  destination: r.destination,
  client: r.client_id ? { id: r.client_id, name: r.client_name ?? '' } : null,
  matter: r.matter_id ? { id: r.matter_id, title: r.matter_title ?? '' } : null,
  subject: r.subject,
  status: r.status,
  skipReason: r.skip_reason,
  scheduledAt: iso(r.scheduled_at),
  sentAt: iso(r.sent_at),
  failedAt: iso(r.failed_at),
  failureReason: r.failure_reason,
  attempts: r.attempts,
  provider: r.provider,
  providerMessageId: r.provider_message_id,
  workflow: r.workflow_id ? { id: r.workflow_id, name: r.workflow_name ?? '' } : null,
  createdBy: r.created_by ? { userId: r.created_by, firstName: r.first_name ?? '', lastName: r.last_name } : null,
  createdAt: iso(r.created_at)!,
});

const LIST_SELECT = sql`
  n.id, n.channel, n.notification_type, n.recipient_type, n.metadata, n.destination, n.client_id, c.name AS client_name,
  n.matter_id, m.title AS matter_title, n.subject, n.status, n.skip_reason, n.scheduled_at, n.sent_at, n.failed_at,
  n.failure_reason, n.attempts, n.provider, n.provider_message_id, n.workflow_id, w.name AS workflow_name,
  n.created_by, u.first_name, u.last_name, n.created_at`;
const LIST_FROM = sql`
  notifications n
  LEFT JOIN clients c ON c.id = n.client_id
  LEFT JOIN matters m ON m.id = n.matter_id
  LEFT JOIN workflows w ON w.id = n.workflow_id
  LEFT JOIN users u ON u.id = n.created_by`;

export async function listNotifications(deps: Deps, ctx: TenantContext, f: z.output<typeof listNotificationsSchema>) {
  const where: SqlFragment[] = [sql`n.organization_id = ${ctx.organizationId}`, notificationVisible(ctx)];
  if (f.status === 'scheduled') where.push(sql`n.status = 'queued'`);
  else if (f.status === 'problem') where.push(sql`n.status IN ('failed', 'bounced', 'complained')`);
  else if (f.status !== 'all') where.push(sql`n.status = ${f.status}`);
  if (f.clientId) where.push(sql`n.client_id = ${f.clientId}`);
  if (f.matterId) where.push(sql`n.matter_id = ${f.matterId}`);
  const rows = await query<ListRow & { total: number }>(
    deps.pool,
    sql`SELECT ${LIST_SELECT}, count(*) OVER ()::int AS total FROM ${LIST_FROM}
        WHERE ${sql.join(where, ' AND ')}
        ORDER BY COALESCE(n.sent_at, n.scheduled_at, n.created_at) DESC
        ${pageClause(f)}`,
  );
  return { items: rows.map(toDto), total: rows[0]?.total ?? 0 };
}

export async function getNotification(deps: Deps, ctx: TenantContext, id: string): Promise<NotificationDetailDto> {
  const row = await queryOne<ListRow & { body_html: string | null; body_text: string | null }>(
    deps.pool,
    sql`SELECT ${LIST_SELECT}, n.body_html, n.body_text FROM ${LIST_FROM}
        WHERE n.id = ${id} AND n.organization_id = ${ctx.organizationId} AND ${notificationVisible(ctx)}`,
  );
  if (!row) throw notFound('Message');
  return { ...toDto(row), bodyHtml: row.body_html, bodyText: row.body_text, sensitive: Boolean(row.metadata?.sensitive) };
}

async function transition(deps: Deps, ctx: TenantContext, id: string, from: NotificationStatus[], set: SqlFragment, action: string, meta: RequestMeta) {
  return withTransaction(deps.pool, async (tx) => {
    const row = await queryOne<{ status: NotificationStatus; matter_id: string | null; subject: string }>(
      tx,
      sql`SELECT n.status, n.matter_id, n.subject FROM notifications n
          WHERE n.id = ${id} AND n.organization_id = ${ctx.organizationId} AND ${notificationVisible(ctx)} FOR UPDATE OF n`,
    );
    if (!row) throw notFound('Message');
    if (!from.includes(row.status)) throw conflict(`This message is ${row.status.replace('_', ' ')}`);
    await query(tx, sql`UPDATE notifications SET ${set} WHERE id = ${id}`);
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action, entityType: 'notification', entityId: id, before: { status: row.status }, meta });
    return row;
  });
}

/** Approval mode (PRD Journey C step 8): a person releases a client message. */
export async function approveNotification(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  await transition(deps, ctx, id, ['awaiting_approval'], sql`status = 'queued', approved_by = ${ctx.userId}, approved_at = now(), scheduled_at = GREATEST(COALESCE(scheduled_at, now()), now())`, 'notification.approved', meta);
  return getNotification(deps, ctx, id);
}

export async function rejectNotification(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  await transition(deps, ctx, id, ['awaiting_approval', 'queued'], sql`status = 'cancelled', skip_reason = 'rejected'`, 'notification.cancelled', meta);
  return getNotification(deps, ctx, id);
}

/** Failed → queued again (a deliberate human retry; resets the attempt budget). */
export async function retryNotification(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  await transition(deps, ctx, id, ['failed'], sql`status = 'queued', attempts = 0, scheduled_at = now(), failed_at = NULL`, 'notification.retried', meta);
  return getNotification(deps, ctx, id);
}

/** "Send client update" (PRD §23): rendered and queued now, sent by the worker, never inside the request. */
export async function sendManualEmail(
  deps: Deps,
  ctx: TenantContext,
  input: { clientId: string; matterId?: string | null | undefined; templateKey: string; customNote?: string | null | undefined },
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const client = await queryOne(tx, sql`SELECT 1 FROM clients WHERE id = ${input.clientId} AND organization_id = ${ctx.organizationId}`);
    if (!client) throw notFound('Client');
    if (!(await resolveTemplate(tx, ctx.organizationId, input.templateKey))) {
      throw validationError('Unknown email template', [{ path: 'templateKey', message: `No template "${input.templateKey}"` }]);
    }
    if (input.matterId) {
      const m = await queryOne(tx, sql`SELECT 1 FROM matters m WHERE m.id = ${input.matterId} AND m.client_id = ${input.clientId} AND m.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('m.id'))}`);
      if (!m) throw notFound('Matter');
    }
    const n = await createNotification(tx, deps.env.APP_URL, {
      organizationId: ctx.organizationId,
      templateKey: input.templateKey,
      recipient: { type: 'client', clientId: input.clientId },
      refs: { clientId: input.clientId, matterId: input.matterId ?? null },
      now: new Date(),
      createdBy: ctx.userId,
      idempotencyKey: `manual:${meta.requestId}`,
      extraVars: { custom: { note: input.customNote ?? '' } },
    });
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'notification.manual_send', entityType: 'notification', entityId: n.id, after: input, meta });
    return n;
  }).then((n) => getNotification(deps, ctx, n.id));
}

export async function awaitingApprovalCount(db: Db, ctx: TenantContext): Promise<number> {
  const r = await queryOne<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM notifications n WHERE n.organization_id = ${ctx.organizationId} AND n.status = 'awaiting_approval' AND ${notificationVisible(ctx)}`,
  );
  return r?.n ?? 0;
}
