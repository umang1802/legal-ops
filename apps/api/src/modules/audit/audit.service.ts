import { query, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { RequestMeta } from '../../http/context.js';

export type AuditEntry = {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'workflow' | 'client';
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: RequestMeta;
};

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'csrf_secret',
]);

/** Strips secrets so audit rows can never leak credentials (PRD §16, §31). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SENSITIVE_KEYS.has(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

export async function recordAudit(db: Db, e: AuditEntry): Promise<void> {
  await query(
    db,
    sql`INSERT INTO audit_logs (organization_id, actor_user_id, actor_type, action, entity_type, entity_id,
                                before_json, after_json, request_id, ip_address, user_agent)
        VALUES (${e.organizationId}, ${e.actorUserId}, ${e.actorType ?? 'user'}, ${e.action}, ${e.entityType},
                ${e.entityId ?? null},
                ${e.before === undefined ? null : JSON.stringify(redact(e.before))},
                ${e.after === undefined ? null : JSON.stringify(redact(e.after))},
                ${e.meta?.requestId ?? null}, ${e.meta?.ip ?? null}, ${e.meta?.userAgent ?? null})`,
  );
}
