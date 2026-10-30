import { TEMPLATE_VARIABLES, type EmailTemplateDto } from '@legalops/types';
import type { templateSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound, validationError } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { recordAudit } from '../audit/audit.service.js';
import { buildContext } from '../notifications/context.js';
import { firmBranding } from '../organizations/organizations.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { internalOnlyUsed, varsForAudience, type Audience } from './audience.js';
import { emailLayout, htmlToText, renderTemplate, sanitizeTemplateHtml, unknownVariables } from './render.js';

/** Variables a template may use: the documented catalogue plus internal helpers used by system templates. */
const KNOWN = new Set([
  ...TEMPLATE_VARIABLES.flatMap((g) => g.vars.map((v) => v.name)),
  ...['hearing.time_phrase', 'hearing.courtroom_phrase', 'hearing.when', 'hearing.result', 'hearing.hearing_type', 'invoice.reminder_phrase', 'payment.balance_phrase', 'task.due_phrase', 'task.matter_phrase', 'task.priority', 'recipient.name', 'case.title', 'case.status', 'matter.status', 'matter.priority', 'matter.practice_area', 'client.client_type', 'invite.role'],
  ...['links.hearing', 'links.invoice', 'links.task', 'links.matter', 'links.accept_invite', 'links.reset_password'],
]);

type Row = {
  id: string;
  organization_id: string | null;
  template_key: string;
  name: string;
  event_type: string | null;
  audience: 'client' | 'internal';
  subject_template: string;
  html_body: string;
  text_body: string | null;
  is_active: boolean;
  updated_at: Date;
  overridden: boolean;
};

const toDto = (r: Row): EmailTemplateDto => ({
  id: r.id,
  templateKey: r.template_key,
  name: r.name,
  eventType: r.event_type,
  audience: r.audience,
  subjectTemplate: r.subject_template,
  htmlBody: r.html_body,
  textBody: r.text_body,
  isActive: r.is_active,
  isSystem: r.organization_id === null,
  overridden: r.overridden,
  updatedAt: iso(r.updated_at)!,
});

/** The firm's own version wins over the system default with the same key. */
export async function resolveTemplate(db: Db, organizationId: string, templateKey: string) {
  return queryOne<{ id: string; subject_template: string; html_body: string; text_body: string | null; audience: string; is_active: boolean }>(
    db,
    sql`SELECT id, subject_template, html_body, text_body, audience, is_active FROM email_templates
        WHERE template_key = ${templateKey} AND (organization_id = ${organizationId} OR organization_id IS NULL)
        ORDER BY organization_id NULLS LAST LIMIT 1`,
  );
}

export async function listTemplates(deps: Deps, ctx: TenantContext): Promise<EmailTemplateDto[]> {
  const rows = await query<Row>(
    deps.pool,
    sql`SELECT t.*, (t.organization_id IS NULL AND EXISTS (
                SELECT 1 FROM email_templates o WHERE o.organization_id = ${ctx.organizationId} AND o.template_key = t.template_key)) AS overridden
        FROM email_templates t
        WHERE t.organization_id = ${ctx.organizationId} OR t.organization_id IS NULL
        ORDER BY t.template_key, t.organization_id NULLS LAST`,
  );
  return rows.map(toDto);
}

export async function getTemplate(deps: Deps, ctx: TenantContext, id: string): Promise<EmailTemplateDto> {
  const row = await queryOne<Row>(
    deps.pool,
    sql`SELECT t.*, false AS overridden FROM email_templates t WHERE t.id = ${id} AND (t.organization_id = ${ctx.organizationId} OR t.organization_id IS NULL)`,
  );
  if (!row) throw notFound('Template');
  return toDto(row);
}

function validateBody(input: { audience?: Audience; subjectTemplate: string; htmlBody: string; textBody?: string | null | undefined }) {
  const unknown = [...new Set([...unknownVariables(input.subjectTemplate, KNOWN), ...unknownVariables(input.htmlBody, KNOWN), ...unknownVariables(input.textBody ?? '', KNOWN)])];
  if (unknown.length) {
    throw validationError(`Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}`, [{ path: 'htmlBody', message: 'Unknown variables' }]);
  }
  if (input.audience === 'client') {
    const teamOnly = internalOnlyUsed(input.subjectTemplate, input.htmlBody, input.textBody);
    if (teamOnly.length) {
      throw validationError(`Team-only variable${teamOnly.length > 1 ? 's' : ''} can't be used in client emails: ${teamOnly.map((u) => `{{${u}}}`).join(', ')}`, [
        { path: 'htmlBody', message: 'Team-only variables' },
      ]);
    }
  }
}

/** Creates the firm's own template (or its override of a system template). HTML is sanitised on save. */
export async function saveTemplate(deps: Deps, ctx: TenantContext, input: z.output<typeof templateSchema>, meta: RequestMeta, id?: string) {
  validateBody(input);
  const html = sanitizeTemplateHtml(input.htmlBody);
  return withTransaction(deps.pool, async (tx) => {
    let row: { id: string } | undefined;
    if (id) {
      const existing = await queryOne<{ organization_id: string | null; template_key: string }>(tx, sql`SELECT organization_id, template_key FROM email_templates WHERE id = ${id} FOR UPDATE`);
      if (!existing || (existing.organization_id !== null && existing.organization_id !== ctx.organizationId)) throw notFound('Template');
      if (existing.organization_id === null) throw conflict('System templates can’t be edited; save a copy for your firm instead');
      if (existing.template_key !== input.templateKey) throw conflict('The template key can’t change');
      row = await queryOne(
        tx,
        sql`UPDATE email_templates SET name = ${input.name}, audience = ${input.audience}, subject_template = ${input.subjectTemplate},
              html_body = ${html}, text_body = ${input.textBody ?? null}, is_active = ${input.isActive}, updated_by = ${ctx.userId}
            WHERE id = ${id} RETURNING id`,
      );
    } else {
      const sys = await queryOne<{ event_type: string | null }>(tx, sql`SELECT event_type FROM email_templates WHERE organization_id IS NULL AND template_key = ${input.templateKey}`);
      row = await queryOne(
        tx,
        sql`INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body, is_active, created_by, updated_by)
            VALUES (${ctx.organizationId}, ${input.templateKey}, ${input.name}, ${sys?.event_type ?? null}, ${input.audience}, ${input.subjectTemplate},
                    ${html}, ${input.textBody ?? null}, ${input.isActive}, ${ctx.userId}, ${ctx.userId})
            RETURNING id`,
      );
    }
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: id ? 'template.updated' : 'template.created',
      entityType: 'email_template',
      entityId: row!.id,
      after: { ...input, htmlBody: html },
      meta,
    });
    return row!.id;
  });
}

export async function deleteTemplate(deps: Deps, ctx: TenantContext, id: string, meta: RequestMeta) {
  await withTransaction(deps.pool, async (tx) => {
    const t = await queryOne<{ template_key: string }>(tx, sql`DELETE FROM email_templates WHERE id = ${id} AND organization_id = ${ctx.organizationId} RETURNING template_key`);
    if (!t) throw notFound('Template');
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'template.deleted', entityType: 'email_template', entityId: id, before: t, meta });
  });
}

/** Preview with real data from a matter when given, otherwise the documented examples. */
export async function previewTemplate(deps: Deps, ctx: TenantContext, input: { audience?: Audience; subjectTemplate: string; htmlBody: string; matterId?: string | undefined }) {
  validateBody(input);
  const examples: Record<string, Record<string, unknown>> = {};
  for (const g of TEMPLATE_VARIABLES) for (const v of g.vars) {
    const [grp, key] = v.name.split('.') as [string, string];
    (examples[grp] ??= {})[key] = v.example;
  }
  const ctxVars = input.matterId ? (await buildContext(deps.pool, ctx.organizationId, { matterId: input.matterId }, new Date(), deps.env.APP_URL)).vars : {};
  const vars = varsForAudience(
    { ...examples, ...Object.fromEntries(Object.entries(ctxVars).map(([k, v]) => [k, { ...(examples[k] ?? {}), ...v }])) },
    input.audience ?? 'internal',
  );
  const { logoUrl } = await firmBranding(deps.pool, ctx.organizationId, deps.env.APP_URL);
  const firm = { ...((vars.firm ?? {}) as { name: string; email: string | null; phone: string | null }), logoUrl };
  const body = renderTemplate(sanitizeTemplateHtml(input.htmlBody), vars, 'html');
  return { subject: renderTemplate(input.subjectTemplate, vars, 'text'), html: emailLayout(body, firm), text: htmlToText(body) };
}

/** Sends the saved template to the person testing it, through the normal queue (so it shows in the log). */
export async function testSendTemplate(deps: Deps, ctx: TenantContext, id: string, matterId: string | undefined, meta: RequestMeta) {
  const t = await getTemplate(deps, ctx, id);
  return withTransaction(deps.pool, async (tx) => {
    const n = await createNotification(tx, deps.env.APP_URL, {
      organizationId: ctx.organizationId,
      templateKey: t.templateKey,
      recipient: { type: 'user', userId: ctx.userId },
      refs: matterId ? { matterId } : {},
      now: new Date(),
      createdBy: ctx.userId,
      idempotencyKey: `test:${meta.requestId}`,
    });
    return { notificationId: n.id };
  });
}
