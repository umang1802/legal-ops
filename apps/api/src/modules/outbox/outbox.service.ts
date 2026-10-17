import { queryOne, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';

export type DomainEvent = {
  organizationId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actorUserId?: string | null;
  dedupeKey?: string;
};

/**
 * Writes a domain event in the caller's transaction (transactional outbox). The worker relays it
 * after commit. Never put secrets (raw tokens, passwords) in the payload: the worker generates
 * them at send time.
 */
export async function emitEvent(db: Db, e: DomainEvent): Promise<string | undefined> {
  const row = await queryOne<{ id: string }>(
    db,
    sql`INSERT INTO outbox_events (organization_id, event_type, aggregate_type, aggregate_id, payload, actor_user_id, dedupe_key)
        VALUES (${e.organizationId}, ${e.eventType}, ${e.aggregateType}, ${e.aggregateId},
                ${JSON.stringify(e.payload)}, ${e.actorUserId ?? null}, ${e.dedupeKey ?? null})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id`,
  );
  return row?.id;
}
