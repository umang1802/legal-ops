import {
  CASE_STATUS_LABELS,
  type AdvocateDto,
  type CaseListItemDto,
  type CaseDetailDto,
  type CaseStatus,
  type CaseSummaryDto,
  type PartyDto,
} from '@legalops/types';
import type { advocateSchema, createCaseSchema, partySchema, updateCaseSchema } from '@legalops/validation';
import type { z } from 'zod';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { AppError, notFound } from '../../http/errors.js';
import { orgTodaySql } from '../../http/dates.js';
import { iso, likeContains } from '../../http/query-helpers.js';
import type { CourtDataProvider } from '../../integrations/courts/court-provider.js';
import { assertMatterVisible, matterVisible } from '../access/matter-scope.js';
import { recordAudit } from '../audit/audit.service.js';
import { assertCourtUsable } from '../courts/courts.service.js';
import { emitEvent } from '../outbox/outbox.service.js';
import { addTimelineEvent } from '../timeline/timeline.service.js';

type CaseInput = z.output<typeof createCaseSchema>;

/** Next hearing is derived from hearings (scheduled, on/after the firm's today), never trusted from a cached column. */
const NEXT_HEARING = sql`(SELECT min(h.scheduled_date) FROM hearings h
    WHERE h.case_id = cs.id AND h.status = 'scheduled' AND h.scheduled_date >= ${orgTodaySql('cs.organization_id')})`;

const SUMMARY_SELECT = sql`
  cs.id, cs.title, cs.case_number, cs.cnr, cs.case_type, cs.status, ${NEXT_HEARING}::text AS next_hearing_date,
  ct.id AS court_id, ct.name AS court_name`;

type SummaryRow = {
  id: string;
  title: string;
  case_number: string | null;
  cnr: string | null;
  case_type: string | null;
  status: CaseStatus;
  next_hearing_date: string | null;
  court_id: string | null;
  court_name: string | null;
};

const toSummary = (r: SummaryRow): CaseSummaryDto => ({
  id: r.id,
  title: r.title,
  caseNumber: r.case_number,
  cnr: r.cnr,
  caseType: r.case_type,
  status: r.status,
  court: r.court_id ? { id: r.court_id, name: r.court_name ?? '' } : null,
  nextHearingDate: r.next_hearing_date,
});

/** Case identifier for timeline titles: "CS(OS) 123/2026" or the title. */
const label = (c: { case_number: string | null; title: string }) => c.case_number ?? c.title;

export async function listCaseSummaries(
  db: Db,
  ctx: TenantContext,
  matterId: string,
): Promise<CaseSummaryDto[]> {
  const rows = await query<SummaryRow>(
    db,
    sql`SELECT ${SUMMARY_SELECT} FROM cases cs LEFT JOIN courts ct ON ct.id = cs.court_id
        WHERE cs.organization_id = ${ctx.organizationId} AND cs.matter_id = ${matterId}
        ORDER BY cs.created_at`,
  );
  return rows.map(toSummary);
}

/** Loads a case the caller may see, or 404. Visibility follows the parent matter. */
export async function loadVisibleCase(
  db: Db,
  ctx: TenantContext,
  caseId: string,
  lock = false,
): Promise<SummaryRow & { matter_id: string; client_id: string } & Record<string, unknown>> {
  const row = await queryOne<SummaryRow & { matter_id: string; client_id: string }>(
    db,
    sql`SELECT cs.*, ${NEXT_HEARING}::text AS next_hearing_date, ct.id AS court_id, ct.name AS court_name, m.client_id
        FROM cases cs
        JOIN matters m ON m.id = cs.matter_id
        LEFT JOIN courts ct ON ct.id = cs.court_id
        WHERE cs.id = ${caseId} AND cs.organization_id = ${ctx.organizationId}
          AND ${matterVisible(ctx, sql.raw('cs.matter_id'))}
        ${lock ? sql`FOR UPDATE OF cs` : sql.empty}`,
  );
  if (!row) throw notFound('Case');
  return row;
}

export async function createCaseInTx(
  db: Db,
  ctx: TenantContext,
  input: CaseInput,
  meta: RequestMeta,
): Promise<string> {
  await assertMatterVisible(db, ctx, input.matterId);
  if (input.courtId) await assertCourtUsable(db, ctx, input.courtId);
  const row = await queryOne<{ id: string; client_id: string }>(
    db,
    sql`INSERT INTO cases (organization_id, matter_id, court_id, title, case_number, cnr, case_type,
                           filing_date, registration_date, status, judge_bench, created_by)
        VALUES (${ctx.organizationId}, ${input.matterId}, ${input.courtId ?? null}, ${input.title},
                ${input.caseNumber ?? null}, ${input.cnr ?? null}, ${input.caseType ?? null}, ${input.filingDate ?? null},
                ${input.registrationDate ?? null}, ${input.status}, ${input.judgeBench ?? null}, ${ctx.userId})
        RETURNING id, (SELECT client_id FROM matters WHERE id = ${input.matterId}) AS client_id`,
  );
  const caseId = row!.id;
  await addTimelineEvent(db, {
    organizationId: ctx.organizationId,
    matterId: input.matterId,
    caseId,
    clientId: row!.client_id,
    eventType: 'case.created',
    title: `Case added: ${input.caseNumber ?? input.title}`,
    description: input.caseNumber ? input.title : null,
    actorUserId: ctx.userId,
  });
  await emitEvent(db, {
    organizationId: ctx.organizationId,
    eventType: 'CASE_CREATED',
    aggregateType: 'case',
    aggregateId: caseId,
    payload: { caseId, matterId: input.matterId },
    actorUserId: ctx.userId,
  });
  await recordAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'case.created',
    entityType: 'case',
    entityId: caseId,
    after: input,
    meta,
  });
  return caseId;
}

export async function createCase(
  deps: Deps,
  ctx: TenantContext,
  input: CaseInput,
  meta: RequestMeta,
): Promise<CaseDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    const id = await createCaseInTx(tx, ctx, input, meta);
    return getCase(tx, ctx, id);
  });
}

export async function getCase(db: Db, ctx: TenantContext, caseId: string): Promise<CaseDetailDto> {
  const c = await loadVisibleCase(db, ctx, caseId);
  const matter = await queryOne<{ title: string; client_name: string }>(
    db,
    sql`SELECT m.title, cl.name AS client_name FROM matters m JOIN clients cl ON cl.id = m.client_id WHERE m.id = ${c.matter_id}`,
  );
  return {
    ...toSummary(c),
    matter: { id: c.matter_id, title: matter!.title, client: { id: c.client_id, name: matter!.client_name } },
    filingDate: c.filing_date as string | null,
    registrationDate: c.registration_date as string | null,
    judgeBench: c.judge_bench as string | null,
    externalProvider: c.external_provider as string | null,
    lastSyncedAt: iso(c.last_synced_at as Date | null),
    parties: await listParties(db, ctx, caseId),
    advocates: await listAdvocates(db, ctx, caseId),
    createdAt: iso(c.created_at as Date)!,
    updatedAt: iso(c.updated_at as Date)!,
  };
}

const CASE_COLUMNS: Record<keyof z.output<typeof updateCaseSchema>, string> = {
  title: 'title',
  caseNumber: 'case_number',
  cnr: 'cnr',
  courtId: 'court_id',
  caseType: 'case_type',
  filingDate: 'filing_date',
  registrationDate: 'registration_date',
  status: 'status',
  judgeBench: 'judge_bench',
};

export async function updateCase(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  input: z.output<typeof updateCaseSchema>,
  meta: RequestMeta,
): Promise<CaseDetailDto> {
  return withTransaction(deps.pool, async (tx) => {
    const before = await loadVisibleCase(tx, ctx, caseId, true);
    if (input.courtId) await assertCourtUsable(tx, ctx, input.courtId);
    const keys = (Object.keys(input) as (keyof typeof input)[]).filter((k) => input[k] !== undefined);
    if (keys.length > 0) {
      await query(
        tx,
        sql`UPDATE cases SET ${sql.join(keys.map((k) => sql`${sql.raw(CASE_COLUMNS[k])} = ${input[k]}`))}
            WHERE id = ${caseId} AND organization_id = ${ctx.organizationId}`,
      );
    }
    const statusChanged = input.status !== undefined && input.status !== before.status;
    const otherChanged = keys.some((k) => k !== 'status');
    if (statusChanged) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: before.matter_id,
        caseId,
        eventType: 'case.status_changed',
        title: `${label(before)}: ${CASE_STATUS_LABELS[input.status!]}`,
        description: `Was ${CASE_STATUS_LABELS[before.status]}`,
        actorUserId: ctx.userId,
      });
      await emitEvent(tx, {
        organizationId: ctx.organizationId,
        eventType: 'CASE_STATUS_CHANGED',
        aggregateType: 'case',
        aggregateId: caseId,
        payload: { caseId, matterId: before.matter_id, before: before.status, after: input.status },
        actorUserId: ctx.userId,
      });
    }
    if (otherChanged) {
      await addTimelineEvent(tx, {
        organizationId: ctx.organizationId,
        matterId: before.matter_id,
        caseId,
        eventType: 'case.updated',
        title: `Case details updated: ${input.caseNumber ?? label(before)}`,
        actorUserId: ctx.userId,
      });
    }
    const after = await queryOne(tx, sql`SELECT * FROM cases WHERE id = ${caseId}`);
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.updated',
      entityType: 'case',
      entityId: caseId,
      before,
      after,
      meta,
    });
    return getCase(tx, ctx, caseId);
  });
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

type PartyRow = {
  id: string;
  name: string;
  party_type: string | null;
  side: PartyDto['side'];
  is_client: boolean;
  email: string | null;
  phone: string | null;
};
const toParty = (p: PartyRow): PartyDto => ({
  id: p.id,
  name: p.name,
  partyType: p.party_type,
  side: p.side,
  isClient: p.is_client,
  email: p.email,
  phone: p.phone,
});

export async function listParties(db: Db, ctx: TenantContext, caseId: string): Promise<PartyDto[]> {
  const rows = await query<PartyRow>(
    db,
    sql`SELECT id, name, party_type, side, is_client, email, phone FROM case_parties
        WHERE organization_id = ${ctx.organizationId} AND case_id = ${caseId}
        ORDER BY CASE WHEN side IN ('petitioner', 'plaintiff', 'appellant') THEN 0
                      WHEN side IN ('respondent', 'defendant') THEN 1 ELSE 2 END, created_at`,
  );
  return rows.map(toParty);
}

export async function addParty(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  input: z.output<typeof partySchema>,
  meta: RequestMeta,
): Promise<PartyDto> {
  return withTransaction(deps.pool, async (tx) => {
    const c = await loadVisibleCase(tx, ctx, caseId);
    const row = await queryOne<PartyRow>(
      tx,
      sql`INSERT INTO case_parties (organization_id, case_id, name, party_type, side, is_client, email, phone)
          VALUES (${ctx.organizationId}, ${caseId}, ${input.name}, ${input.partyType ?? null}, ${input.side ?? null},
                  ${input.isClient}, ${input.email ?? null}, ${input.phone ?? null})
          RETURNING id, name, party_type, side, is_client, email, phone`,
    );
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: c.matter_id,
      caseId,
      eventType: 'case.party_added',
      title: `Party added: ${input.name}`,
      description: input.side ? `${label(c)} · ${input.side}` : label(c),
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.party_added',
      entityType: 'case_party',
      entityId: row!.id,
      after: input,
      meta,
    });
    return toParty(row!);
  });
}

export async function updateParty(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  partyId: string,
  input: z.output<typeof partySchema>,
  meta: RequestMeta,
): Promise<PartyDto> {
  return withTransaction(deps.pool, async (tx) => {
    await loadVisibleCase(tx, ctx, caseId);
    const before = await queryOne(
      tx,
      sql`SELECT * FROM case_parties WHERE id = ${partyId} AND case_id = ${caseId} AND organization_id = ${ctx.organizationId} FOR UPDATE`,
    );
    if (!before) throw notFound('Party');
    const row = await queryOne<PartyRow>(
      tx,
      sql`UPDATE case_parties SET name = ${input.name}, party_type = ${input.partyType ?? null}, side = ${input.side ?? null},
                                  is_client = ${input.isClient}, email = ${input.email ?? null}, phone = ${input.phone ?? null}
          WHERE id = ${partyId}
          RETURNING id, name, party_type, side, is_client, email, phone`,
    );
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.party_updated',
      entityType: 'case_party',
      entityId: partyId,
      before,
      after: row,
      meta,
    });
    return toParty(row!);
  });
}

export async function removeParty(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  partyId: string,
  meta: RequestMeta,
) {
  await withTransaction(deps.pool, async (tx) => {
    const c = await loadVisibleCase(tx, ctx, caseId);
    const removed = await queryOne<PartyRow>(
      tx,
      sql`DELETE FROM case_parties WHERE id = ${partyId} AND case_id = ${caseId} AND organization_id = ${ctx.organizationId}
          RETURNING id, name, party_type, side, is_client, email, phone`,
    );
    if (!removed) throw notFound('Party');
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: c.matter_id,
      caseId,
      eventType: 'case.party_removed',
      title: `Party removed: ${removed.name}`,
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.party_removed',
      entityType: 'case_party',
      entityId: partyId,
      before: removed,
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Advocates (org-level directory, linked to cases)
// ---------------------------------------------------------------------------

type AdvocateRow = {
  id: string;
  name: string;
  firm_name: string | null;
  enrollment_number: string | null;
  phone: string | null;
  email: string | null;
  is_internal: boolean;
  side: AdvocateDto['side'];
  is_lead: boolean;
};
const toAdvocate = (a: AdvocateRow): AdvocateDto => ({
  id: a.id,
  name: a.name,
  firmName: a.firm_name,
  enrollmentNumber: a.enrollment_number,
  phone: a.phone,
  email: a.email,
  isInternal: a.is_internal,
  side: a.side,
  isLead: a.is_lead,
});

export async function listAdvocates(db: Db, ctx: TenantContext, caseId: string): Promise<AdvocateDto[]> {
  const rows = await query<AdvocateRow>(
    db,
    sql`SELECT a.id, a.name, a.firm_name, a.enrollment_number, a.phone, a.email, a.is_internal, ca.side, ca.is_lead
        FROM case_advocates ca JOIN advocates a ON a.id = ca.advocate_id
        WHERE ca.organization_id = ${ctx.organizationId} AND ca.case_id = ${caseId}
        ORDER BY a.is_internal DESC, ca.is_lead DESC, a.name`,
  );
  return rows.map(toAdvocate);
}

export async function addAdvocate(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  input: z.output<typeof advocateSchema>,
  meta: RequestMeta,
): Promise<AdvocateDto> {
  return withTransaction(deps.pool, async (tx) => {
    const c = await loadVisibleCase(tx, ctx, caseId);
    const adv = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO advocates (organization_id, name, firm_name, enrollment_number, phone, email, is_internal)
          VALUES (${ctx.organizationId}, ${input.name}, ${input.firmName ?? null}, ${input.enrollmentNumber ?? null},
                  ${input.phone ?? null}, ${input.email ?? null}, ${input.isInternal})
          RETURNING id`,
    );
    await query(
      tx,
      sql`INSERT INTO case_advocates (organization_id, case_id, advocate_id, side, is_lead)
          VALUES (${ctx.organizationId}, ${caseId}, ${adv!.id}, ${input.side ?? null}, ${input.isLead})`,
    );
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: c.matter_id,
      caseId,
      eventType: 'case.advocate_added',
      title: `Advocate added: ${input.name}`,
      description: input.firmName ?? null,
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.advocate_added',
      entityType: 'advocate',
      entityId: adv!.id,
      after: { ...input, caseId },
      meta,
    });
    const all = await listAdvocates(tx, ctx, caseId);
    return all.find((a) => a.id === adv!.id)!;
  });
}

export async function removeAdvocate(
  deps: Deps,
  ctx: TenantContext,
  caseId: string,
  advocateId: string,
  meta: RequestMeta,
): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const c = await loadVisibleCase(tx, ctx, caseId);
    const removed = await queryOne<{ name: string }>(
      tx,
      sql`DELETE FROM case_advocates ca USING advocates a
          WHERE ca.case_id = ${caseId} AND ca.advocate_id = ${advocateId} AND ca.organization_id = ${ctx.organizationId}
            AND a.id = ca.advocate_id
          RETURNING a.name`,
    );
    if (!removed) throw notFound('Advocate');
    await addTimelineEvent(tx, {
      organizationId: ctx.organizationId,
      matterId: c.matter_id,
      caseId,
      eventType: 'case.advocate_removed',
      title: `Advocate removed: ${removed.name}`,
      actorUserId: ctx.userId,
    });
    await recordAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'case.advocate_removed',
      entityType: 'advocate',
      entityId: advocateId,
      before: { caseId, name: removed.name },
      meta,
    });
  });
}

// ---------------------------------------------------------------------------
// Court refresh (PRD §21.6): honest about not being configured.
// ---------------------------------------------------------------------------

export async function refreshCase(
  deps: Deps & { courts: CourtDataProvider },
  ctx: TenantContext,
  caseId: string,
) {
  const c = await loadVisibleCase(deps.pool, ctx, caseId);
  const result = await deps.courts.refreshCase({
    cnr: c.cnr,
    caseNumber: c.case_number,
    courtName: c.court_name,
  });
  if (result.status === 'not_configured') {
    throw new AppError(
      501,
      'NOT_CONFIGURED',
      'Court data refresh isn’t set up for your firm yet. Update dates manually.',
    );
  }
  if (result.status === 'unavailable') {
    throw new AppError(503, 'NOT_CONFIGURED', 'Court data refresh is temporarily unavailable.');
  }
  // A real provider lands in V1.5; persisting source data + last_synced_at belongs here then.
  throw new AppError(501, 'NOT_CONFIGURED', 'Court data refresh isn’t set up for your firm yet.');
}

/** Case picker (hearing/task forms): visible cases only. */
export async function listCases(
  db: Db,
  ctx: TenantContext,
  f: { search?: string | undefined; matterId?: string | undefined },
): Promise<CaseListItemDto[]> {
  const p = f.search ? likeContains(f.search) : null;
  const rows = await query<SummaryRow & { matter_id: string; matter_title: string; client_name: string }>(
    db,
    sql`SELECT ${SUMMARY_SELECT}, m.id AS matter_id, m.title AS matter_title, cl.name AS client_name
        FROM cases cs
        JOIN matters m ON m.id = cs.matter_id
        JOIN clients cl ON cl.id = m.client_id
        LEFT JOIN courts ct ON ct.id = cs.court_id
        WHERE cs.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('cs.matter_id'))}
          ${f.matterId ? sql`AND cs.matter_id = ${f.matterId}` : sql.empty}
          ${p ? sql`AND (cs.title ILIKE ${p} OR cs.case_number ILIKE ${p} OR cs.cnr ILIKE ${p} OR m.title ILIKE ${p} OR cl.name ILIKE ${p})` : sql.empty}
          AND m.status IN ('lead', 'active', 'on_hold')
        ORDER BY cs.updated_at DESC
        LIMIT 20`,
  );
  return rows.map((r) => ({
    ...toSummary(r),
    matter: { id: r.matter_id, title: r.matter_title },
    clientName: r.client_name,
  }));
}
