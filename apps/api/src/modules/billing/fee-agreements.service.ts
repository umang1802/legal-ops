import { FEE_AGREEMENT_TYPE_LABELS, type FeeAgreementDto, type FeeMilestoneDto } from '@legalops/types';
import {
  fromPaise,
  toPaise,
  type feeAgreementSchema,
  type milestoneSchema,
  type updateFeeAgreementSchema,
  type updateMilestoneSchema,
} from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { conflict, notFound } from '../../http/errors.js';
import { iso } from '../../http/query-helpers.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';
import { displayStatus, rupees } from './invoices.service.js';

export async function listFeeAgreements(
  db: Db,
  ctx: TenantContext,
  matterId: string,
): Promise<FeeAgreementDto[]> {
  await assertMatterVisible(db, ctx, matterId);
  const rows = await query<{
    id: string;
    matter_id: string;
    agreement_type: FeeAgreementDto['agreementType'];
    description: string | null;
    currency: string;
    agreed_amount: string | null;
    per_appearance_amount: string | null;
    tax_included: boolean;
    effective_date: string | null;
    status: FeeAgreementDto['status'];
    notes: string | null;
    created_at: Date;
  }>(
    db,
    sql`SELECT fa.id, fa.matter_id, fa.agreement_type, fa.description, fa.currency, fa.agreed_amount::text,
               fa.per_appearance_amount::text, fa.tax_included, fa.effective_date::text, fa.status, fa.notes, fa.created_at
        FROM fee_agreements fa
        WHERE fa.organization_id = ${ctx.organizationId} AND fa.matter_id = ${matterId}
          AND ${matterVisible(ctx, sql.raw('fa.matter_id'))}
        ORDER BY fa.created_at`,
  );
  if (rows.length === 0) return [];
  const ms = await query<{
    id: string;
    fee_agreement_id: string;
    name: string;
    sequence_no: number | null;
    amount: string;
    due_date: string | null;
    status: FeeMilestoneDto['status'];
    invoice_id: string | null;
    invoice_number: string | null;
    inv_status: string | null;
    payment_state: 'unpaid' | 'partial' | 'paid' | null;
    days_overdue: number | null;
  }>(
    db,
    sql`SELECT fm.id, fm.fee_agreement_id, fm.name, fm.sequence_no, fm.amount::text, fm.due_date::text, fm.status,
               fm.invoice_id, i.invoice_number, i.status AS inv_status, b.payment_state,
               CASE WHEN i.status = 'issued' AND b.amount_due > 0 AND i.due_date < (now() AT TIME ZONE o.timezone)::date
                    THEN ((now() AT TIME ZONE o.timezone)::date - i.due_date) ELSE 0 END AS days_overdue
        FROM fee_milestones fm
        JOIN organizations o ON o.id = fm.organization_id
        LEFT JOIN invoices i ON i.id = fm.invoice_id
        LEFT JOIN v_invoice_balances b ON b.invoice_id = i.id
        WHERE fm.fee_agreement_id = ANY(${rows.map((r) => r.id)}::uuid[])
        ORDER BY fm.sequence_no NULLS LAST, fm.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    matterId: r.matter_id,
    agreementType: r.agreement_type,
    description: r.description,
    currency: r.currency,
    agreedAmount: r.agreed_amount,
    perAppearanceAmount: r.per_appearance_amount,
    taxIncluded: r.tax_included,
    effectiveDate: r.effective_date,
    status: r.status,
    notes: r.notes,
    createdAt: iso(r.created_at)!,
    milestones: ms
      .filter((m) => m.fee_agreement_id === r.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        sequenceNo: m.sequence_no,
        amount: m.amount,
        dueDate: m.due_date,
        status: m.status,
        invoiceId: m.invoice_id,
        invoiceNumber: m.invoice_number,
        invoiceDisplayStatus: m.inv_status
          ? displayStatus({
              status: m.inv_status as 'issued',
              payment_state: m.payment_state,
              days_overdue: m.days_overdue ?? 0,
            })
          : null,
      })),
  }));
}

async function insertMilestones(
  db: Db,
  ctx: TenantContext,
  agreementId: string,
  list: z.output<typeof milestoneSchema>[],
  startAt: number,
) {
  for (const [i, m] of list.entries()) {
    await query(
      db,
      sql`INSERT INTO fee_milestones (organization_id, fee_agreement_id, name, sequence_no, amount, due_date)
          VALUES (${ctx.organizationId}, ${agreementId}, ${m.name}, ${startAt + i}, ${m.amount}, ${m.dueDate ?? null})`,
    );
  }
}

export async function createFeeAgreement(
  deps: Deps,
  ctx: TenantContext,
  input: z.output<typeof feeAgreementSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    await assertMatterVisible(tx, ctx, input.matterId);
    const row = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO fee_agreements (organization_id, matter_id, agreement_type, description, agreed_amount, per_appearance_amount,
                                      tax_included, effective_date, notes, created_by)
          VALUES (${ctx.organizationId}, ${input.matterId}, ${input.agreementType}, ${input.description ?? null},
                  ${input.agreedAmount ?? null}, ${input.perAppearanceAmount ?? null}, ${input.taxIncluded},
                  ${input.effectiveDate ?? null}, ${input.notes ?? null}, ${ctx.userId})
          RETURNING id`,
    );
    await insertMilestones(tx, ctx, row!.id, input.milestones, 1);
    const total = input.milestones.reduce((s, m) => s + toPaise(m.amount), 0);
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: input.matterId,
      eventType: 'fee_agreement.created',
      title: `Fee agreement: ${FEE_AGREEMENT_TYPE_LABELS[input.agreementType]}${input.agreedAmount ? ` ${rupees(toPaise(input.agreedAmount))}` : ''}`,
      description: input.milestones.length
        ? `${input.milestones.length} milestone(s) totalling ${rupees(total)}`
        : null,
      actorUserId: ctx.userId,
      sourceType: 'fee_agreement',
      sourceId: row!.id,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fee_agreement.created',
      entityType: 'fee_agreement',
      entityId: row!.id,
      after: input,
      meta,
    });
    return (await listFeeAgreements(tx, ctx, input.matterId)).find((a) => a.id === row!.id)!;
  });
}

async function lockAgreement(db: Db, ctx: TenantContext, id: string) {
  const a = await queryOne<{ id: string; matter_id: string }>(
    db,
    sql`SELECT fa.id, fa.matter_id FROM fee_agreements fa
        WHERE fa.id = ${id} AND fa.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('fa.matter_id'))}
        FOR UPDATE OF fa`,
  );
  if (!a) throw notFound('Fee agreement');
  return a;
}

const AGREEMENT_COLUMNS = {
  agreementType: 'agreement_type',
  description: 'description',
  agreedAmount: 'agreed_amount',
  perAppearanceAmount: 'per_appearance_amount',
  taxIncluded: 'tax_included',
  effectiveDate: 'effective_date',
  notes: 'notes',
  status: 'status',
} as const;

export async function updateFeeAgreement(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof updateFeeAgreementSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const a = await lockAgreement(tx, ctx, id);
    const keys = (Object.keys(AGREEMENT_COLUMNS) as (keyof typeof AGREEMENT_COLUMNS)[]).filter(
      (k) => input[k] !== undefined,
    );
    if (keys.length)
      await query(
        tx,
        sql`UPDATE fee_agreements SET ${sql.join(keys.map((k) => sql`${sql.raw(AGREEMENT_COLUMNS[k])} = ${input[k]}`))} WHERE id = ${id}`,
      );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fee_agreement.updated',
      entityType: 'fee_agreement',
      entityId: id,
      after: input,
      meta,
    });
    return (await listFeeAgreements(tx, ctx, a.matter_id)).find((x) => x.id === id)!;
  });
}

export async function addMilestone(
  deps: Deps,
  ctx: TenantContext,
  id: string,
  input: z.output<typeof milestoneSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const a = await lockAgreement(tx, ctx, id);
    const next = await queryOne<{ n: number }>(
      tx,
      sql`SELECT COALESCE(max(sequence_no), 0)::int + 1 AS n FROM fee_milestones WHERE fee_agreement_id = ${id}`,
    );
    await insertMilestones(tx, ctx, id, [input], next!.n);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fee_milestone.added',
      entityType: 'fee_agreement',
      entityId: id,
      after: input,
      meta,
    });
    return (await listFeeAgreements(tx, ctx, a.matter_id)).find((x) => x.id === id)!;
  });
}

export async function updateMilestone(
  deps: Deps,
  ctx: TenantContext,
  milestoneId: string,
  input: z.output<typeof updateMilestoneSchema>,
  meta: RequestMeta,
) {
  return withTransaction(deps.pool, async (tx) => {
    const m = await queryOne<{ fee_agreement_id: string; status: string; amount: string }>(
      tx,
      sql`SELECT fee_agreement_id, status, amount::text FROM fee_milestones WHERE id = ${milestoneId} AND organization_id = ${ctx.organizationId} FOR UPDATE`,
    );
    if (!m) throw notFound('Milestone');
    const a = await lockAgreement(tx, ctx, m.fee_agreement_id);
    if (m.status === 'invoiced' && (input.amount !== undefined || input.status !== undefined)) {
      throw conflict('This milestone is invoiced; change the invoice instead');
    }
    const sets = [
      input.name !== undefined ? sql`name = ${input.name}` : null,
      input.amount !== undefined ? sql`amount = ${input.amount}` : null,
      input.dueDate !== undefined ? sql`due_date = ${input.dueDate}` : null,
      input.status !== undefined ? sql`status = ${input.status}` : null,
    ].filter((x) => x !== null);
    if (sets.length)
      await query(tx, sql`UPDATE fee_milestones SET ${sql.join(sets)} WHERE id = ${milestoneId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'fee_milestone.updated',
      entityType: 'fee_milestone',
      entityId: milestoneId,
      before: { status: m.status, amount: m.amount },
      after: { ...input, amount: input.amount ? fromPaise(toPaise(input.amount)) : undefined },
      meta,
    });
    return (await listFeeAgreements(tx, ctx, a.matter_id)).find((x) => x.id === a.id)!;
  });
}
