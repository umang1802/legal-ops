import { ROLE_LABELS, type Role } from '@legalops/types';
import { query, queryOne, withTransaction, type Db } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import { createNotification, dueNotificationIds, sendNotification } from '../notifications/notifications.service.js';
import { ensureDefaultsOnce } from './defaults.js';
import { claimDueActions, executeScheduledAction, planForEvent, type OutboxEvent } from './engine.js';

const MAX_EVENT_ATTEMPTS = 8;

/** Security emails don't go through firm-editable workflows: they always send. */
async function handleSystemEvent(deps: Deps, db: Db, event: OutboxEvent, now: Date): Promise<void> {
  const p = event.payload as Record<string, string>;
  if (event.event_type === 'PASSWORD_RESET_REQUESTED' && p.userId) {
    await createNotification(db, deps.env.APP_URL, {
      organizationId: event.organization_id,
      templateKey: 'password_reset',
      recipient: { type: 'user', userId: p.userId },
      refs: {},
      now,
      sourceEventId: event.id,
      idempotencyKey: `event:${event.id}`,
      sensitive: { kind: 'password_reset', userId: p.userId },
    });
  }
  if (event.event_type === 'MEMBER_INVITED' && p.invitationId && p.email) {
    const inviter = await queryOne<{ name: string }>(
      db,
      sql`SELECT trim(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name FROM invitations i JOIN users u ON u.id = i.invited_by WHERE i.id = ${p.invitationId}`,
    );
    await createNotification(db, deps.env.APP_URL, {
      organizationId: event.organization_id,
      templateKey: 'member_invite',
      recipient: { type: 'external', email: p.email },
      refs: {},
      now,
      sourceEventId: event.id,
      idempotencyKey: `event:${event.id}`,
      extraVars: { invite: { role: ROLE_LABELS[p.role as Role] ?? p.role ?? '', invited_by: inviter?.name ?? '' } },
      sensitive: { kind: 'member_invite', invitationId: p.invitationId },
    });
  }
}

/** Plans everything one event causes, in one transaction with marking it processed. */
export async function handleEvent(deps: Deps, db: Db, event: OutboxEvent, now: Date): Promise<number> {
  await ensureDefaultsOnce(db, event.organization_id);
  await handleSystemEvent(deps, db, event, now);
  return planForEvent(deps, db, event, now);
}

/**
 * Relays committed outbox events (PRD §10). Each event is claimed with SKIP LOCKED and handled in
 * its own transaction, so a failure retries that event alone with backoff, and parallel workers
 * never handle the same event twice.
 */
export async function processOutbox(deps: Deps, now: Date, opts: { workerId?: string; limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < (opts.limit ?? 100); i++) {
    const outcome = await withTransaction(deps.pool, async (tx) => {
      const event = await queryOne<OutboxEvent & { attempts: number }>(
        tx,
        sql`SELECT id, organization_id, event_type, aggregate_type, aggregate_id, payload, attempts FROM outbox_events
            WHERE status IN ('pending', 'processing') AND available_at <= ${now.toISOString()}
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!event) return 'empty' as const;
      try {
        await query(tx, sql`SAVEPOINT handle_event`);
        await handleEvent(deps, tx, event, now);
        await query(tx, sql`RELEASE SAVEPOINT handle_event`);
        await query(
          tx,
          sql`UPDATE outbox_events SET status = 'processed', processed_at = now(), attempts = attempts + 1, locked_at = NULL, locked_by = ${opts.workerId ?? null}, last_error = NULL WHERE id = ${event.id}`,
        );
        return 'ok' as const;
      } catch (err) {
        await query(tx, sql`ROLLBACK TO SAVEPOINT handle_event`);
        const attempts = event.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        deps.log.error({ err, eventId: event.id, eventType: event.event_type }, 'outbox event failed');
        await query(
          tx,
          sql`UPDATE outbox_events SET attempts = ${attempts}, last_error = ${message.slice(0, 2000)},
                status = ${attempts >= MAX_EVENT_ATTEMPTS ? 'failed' : 'pending'},
                available_at = ${new Date(now.getTime() + Math.min(2 ** attempts, 60) * 60_000).toISOString()}
              WHERE id = ${event.id}`,
        );
        return 'failed' as const;
      }
    });
    if (outcome === 'empty') break;
    if (outcome === 'ok') processed++;
    else failed++;
  }
  return { processed, failed };
}

/** Runs every due scheduled action inline (dev tick / tests). The worker does this through BullMQ. */
export async function runDueActions(deps: Deps, now: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (;;) {
    const ids = await claimDueActions(deps.pool, now);
    if (ids.length === 0) return counts;
    for (const id of ids) {
      let result: string;
      try {
        result = await executeScheduledAction(deps, id, now);
      } catch (err) {
        result = 'failed';
        await markActionFailed(deps, id, err);
      }
      counts[result] = (counts[result] ?? 0) + 1;
    }
  }
}

export async function markActionFailed(deps: Deps, id: string, err: unknown): Promise<void> {
  deps.log.error({ err, scheduledActionId: id }, 'scheduled action failed');
  await query(
    deps.pool,
    sql`UPDATE scheduled_actions SET status = 'failed', executed_at = now(), last_error = ${(err instanceof Error ? err.message : String(err)).slice(0, 2000)} WHERE id = ${id}`,
  );
}

export async function sendDueNotifications(deps: Deps, now: Date): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (;;) {
    const ids = (await dueNotificationIds(deps.pool, now)).filter((id) => !seen.has(id));
    if (ids.length === 0) return counts;
    for (const id of ids) {
      seen.add(id);
      const r = await sendNotification(deps, id, now);
      counts[r] = (counts[r] ?? 0) + 1;
    }
  }
}

/**
 * One full pass as of `now`: events → plans → due actions → emails, repeated until quiet
 * (actions can emit new events, e.g. a workflow-created task). This is the pilot's test clock.
 */
export async function tick(deps: Deps, now: Date) {
  const total = { events: 0, eventFailures: 0, actions: {} as Record<string, number>, emails: {} as Record<string, number> };
  for (let round = 0; round < 5; round++) {
    const o = await processOutbox(deps, now);
    const a = await runDueActions(deps, now);
    const e = await sendDueNotifications(deps, now);
    total.events += o.processed;
    total.eventFailures += o.failed;
    for (const [k, v] of Object.entries(a)) total.actions[k] = (total.actions[k] ?? 0) + v;
    for (const [k, v] of Object.entries(e)) total.emails[k] = (total.emails[k] ?? 0) + v;
    if (o.processed + o.failed === 0 && Object.keys(a).length === 0) break;
  }
  return total;
}
