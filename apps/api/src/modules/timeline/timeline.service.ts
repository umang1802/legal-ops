import type { TimelineEventDto } from '@legalops/types';
import { query, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { TenantContext } from '../../http/context.js';
import { iso, pageClause, type Page } from '../../http/query-helpers.js';
import { assertMatterVisible } from '../access/matter-scope.js';
import { activityVisible } from '../features/features.service.js';

export type TimelineEntry = {
  organizationId: string;
  matterId?: string | null;
  caseId?: string | null;
  clientId?: string | null;
  eventType: string;
  title: string;
  description?: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'workflow' | 'provider';
  sourceType?: string;
  sourceId?: string;
  visibility?: 'internal' | 'client';
  metadata?: Record<string, unknown>;
};

/** Written inside the same transaction as the change it describes. */
export async function addTimelineEvent(db: Db, e: TimelineEntry): Promise<void> {
  await query(
    db,
    sql`INSERT INTO timeline_events (organization_id, matter_id, case_id, client_id, event_type, title, description,
                                     actor_user_id, actor_type, source_type, source_id, visibility, metadata)
        VALUES (${e.organizationId}, ${e.matterId ?? null}, ${e.caseId ?? null}, ${e.clientId ?? null}, ${e.eventType},
                ${e.title}, ${e.description ?? null}, ${e.actorUserId}, ${e.actorType ?? 'user'},
                ${e.sourceType ?? null}, ${e.sourceId ?? null}, ${e.visibility ?? 'internal'},
                ${JSON.stringify(e.metadata ?? {})})`,
  );
}

export async function listMatterTimeline(
  db: Db,
  ctx: TenantContext,
  matterId: string,
  page: Page,
): Promise<{ items: TimelineEventDto[]; total: number }> {
  await assertMatterVisible(db, ctx, matterId);
  const rows = await query<{
    id: string;
    event_type: string;
    title: string;
    description: string | null;
    actor_user_id: string | null;
    first_name: string | null;
    last_name: string | null;
    actor_type: TimelineEventDto['actorType'];
    case_id: string | null;
    created_at: Date;
    total: number;
  }>(
    db,
    sql`SELECT t.id, t.event_type, t.title, t.description, t.actor_user_id, u.first_name, u.last_name,
               t.actor_type, t.case_id, t.created_at, count(*) OVER ()::int AS total
        FROM timeline_events t LEFT JOIN users u ON u.id = t.actor_user_id
        WHERE t.organization_id = ${ctx.organizationId} AND t.matter_id = ${matterId}
          AND ${activityVisible(ctx.features, 't.event_type')}
        ORDER BY t.created_at DESC, t.id DESC
        ${pageClause(page)}`,
  );
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      title: r.title,
      description: r.description,
      actor: r.actor_user_id
        ? { userId: r.actor_user_id, firstName: r.first_name ?? '', lastName: r.last_name }
        : null,
      actorType: r.actor_type,
      caseId: r.case_id,
      createdAt: iso(r.created_at)!,
    })),
  };
}
