import { isRole, type HearingDto } from '@legalops/types';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { RequestMeta, TenantContext } from '../../http/context.js';
import { orgToday } from '../../http/dates.js';
import { recordAudit } from '../audit/audit.service.js';
import { hashToken, randomToken } from '../auth/crypto.js';
import { queryHearings } from '../hearings/hearings.service.js';
import { buildCalendar, type IcsEvent } from './ics.js';

/** The feed covers recent history and the coming months. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;

export type CalendarFeedStatus = { active: boolean; createdAt: string | null; lastAccessedAt: string | null };

export async function getFeedStatus(deps: Deps, ctx: TenantContext): Promise<CalendarFeedStatus> {
  const row = await queryOne<{ created_at: Date; last_accessed_at: Date | null }>(
    deps.pool,
    sql`SELECT created_at, last_accessed_at FROM calendar_feeds
        WHERE organization_id = ${ctx.organizationId} AND user_id = ${ctx.userId} AND revoked_at IS NULL`,
  );
  return { active: Boolean(row), createdAt: row?.created_at.toISOString() ?? null, lastAccessedAt: row?.last_accessed_at?.toISOString() ?? null };
}

/** Creates the user's subscribe link, replacing (and so revoking) any existing one. The URL is returned only here. */
export async function createOrResetFeed(deps: Deps, ctx: TenantContext, meta: RequestMeta): Promise<{ url: string; createdAt: string }> {
  const token = randomToken();
  const createdAt = await withTransaction(deps.pool, async (tx) => {
    await query(
      tx,
      sql`UPDATE calendar_feeds SET revoked_at = now()
          WHERE organization_id = ${ctx.organizationId} AND user_id = ${ctx.userId} AND revoked_at IS NULL`,
    );
    const row = await queryOne<{ id: string; created_at: Date }>(
      tx,
      sql`INSERT INTO calendar_feeds (organization_id, user_id, token_hash)
          VALUES (${ctx.organizationId}, ${ctx.userId}, ${hashToken(deps.env.SESSION_SECRET, token)}) RETURNING id, created_at`,
    );
    await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'calendar_feed.created', entityType: 'calendar_feed', entityId: row!.id, meta });
    return row!.created_at.toISOString();
  });
  return { url: `${deps.env.APP_URL.replace(/\/$/, '')}/api/v1/ical/${token}.ics`, createdAt };
}

export async function revokeFeed(deps: Deps, ctx: TenantContext, meta: RequestMeta): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    const rows = await query<{ id: string }>(
      tx,
      sql`UPDATE calendar_feeds SET revoked_at = now()
          WHERE organization_id = ${ctx.organizationId} AND user_id = ${ctx.userId} AND revoked_at IS NULL RETURNING id`,
    );
    for (const r of rows) {
      await recordAudit(tx, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: 'calendar_feed.revoked', entityType: 'calendar_feed', entityId: r.id, meta });
    }
  });
}

/**
 * Renders the iCalendar feed for a subscribe-link token, or null when the link is unknown, revoked, or no longer
 * entitled (user deactivated or removed from the firm, firm not active). Visibility is the user's own.
 */
export async function renderFeed(deps: Deps, token: string, now = new Date()): Promise<string | null> {
  const feed = await queryOne<{ id: string; organization_id: string; user_id: string; role: string; org_name: string; timezone: string; hide: boolean; stale: boolean }>(
    deps.pool,
    sql`SELECT f.id, f.organization_id, f.user_id, m.role, o.name AS org_name, o.timezone, o.calendar_hide_parties AS hide,
               (f.last_accessed_at IS NULL OR f.last_accessed_at < now() - interval '5 minutes') AS stale
        FROM calendar_feeds f
        JOIN users u ON u.id = f.user_id AND u.is_active
        JOIN organization_members m ON m.user_id = f.user_id AND m.organization_id = f.organization_id AND m.status = 'active'
        JOIN organizations o ON o.id = f.organization_id AND o.status = 'active'
        WHERE f.token_hash = ${hashToken(deps.env.SESSION_SECRET, token)} AND f.revoked_at IS NULL`,
  );
  if (!feed || !isRole(feed.role)) return null;
  if (feed.stale) await query(deps.pool, sql`UPDATE calendar_feeds SET last_accessed_at = now() WHERE id = ${feed.id}`);

  const ctx: TenantContext = { organizationId: feed.organization_id, userId: feed.user_id, role: feed.role };
  const today = await orgToday(deps.pool, ctx.organizationId);
  const hearings = await queryHearings(
    deps.pool,
    ctx,
    [sql`h.scheduled_date >= (${today}::date - ${PAST_DAYS}::int)`, sql`h.scheduled_date <= (${today}::date + ${FUTURE_DAYS}::int)`, sql`h.status <> 'cancelled'`],
    undefined,
    2000,
  );
  const times = new Map(
    (hearings.length
      ? await query<{ id: string; starts_at: Date | null; ends_at: Date | null; updated_at: Date }>(
          deps.pool,
          sql`SELECT h.id,
                     ((h.scheduled_date + h.start_time) AT TIME ZONE o.timezone) AS starts_at,
                     ((h.scheduled_date + COALESCE(h.end_time, h.start_time + interval '1 hour')) AT TIME ZONE o.timezone) AS ends_at,
                     h.updated_at
              FROM hearings h JOIN organizations o ON o.id = h.organization_id
              WHERE h.organization_id = ${ctx.organizationId} AND h.id = ANY(${hearings.map((h) => h.id)}::uuid[])`,
        )
      : []
    ).map((t) => [t.id, t]),
  );
  const appUrl = deps.env.APP_URL.replace(/\/$/, '');
  return buildCalendar({
    name: `LexForgeX · ${feed.org_name}`,
    timezone: feed.timezone,
    now,
    events: hearings.map((h) => hearingEvent(h, times.get(h.id), feed.hide, appUrl)),
  });
}

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const STATUS_PREFIX: Partial<Record<HearingDto['status'], string>> = { completed: 'Held: ', adjourned: 'Adjourned: ' };

/** One hearing as a calendar event. To show more in calendars, add a line here (respecting `hideParties`). */
function hearingEvent(
  h: HearingDto,
  t: { starts_at: Date | null; ends_at: Date | null; updated_at: Date } | undefined,
  hideParties: boolean,
  appUrl: string,
): IcsEvent {
  const caseLabel = h.caseNumber ?? (hideParties ? 'Case' : h.caseTitle);
  const timed = t?.starts_at && t.ends_at;
  return {
    uid: `${h.id}@lexforgex.com`,
    start: timed ? { utc: t.starts_at! } : { date: h.scheduledDate },
    end: timed ? { utc: t.ends_at! } : { date: nextDay(h.scheduledDate) },
    summary: `${STATUS_PREFIX[h.status] ?? ''}${caseLabel} · ${hideParties ? 'Hearing' : h.caseTitle}`,
    location: [h.courtName, h.courtroom ? `Court room ${h.courtroom}` : null].filter(Boolean).join(', ') || undefined,
    description: [
      ...(hideParties ? [] : [`Client: ${h.clientName}`, `Matter: ${h.matterTitle}`]),
      h.hearingType ? `Purpose: ${h.hearingType}` : null,
      h.lead ? `Lead: ${[h.lead.firstName, h.lead.lastName].filter(Boolean).join(' ')}` : null,
      `Open in LexForgeX: ${appUrl}/hearings/${h.id}`,
    ]
      .filter(Boolean)
      .join('\n'),
    url: `${appUrl}/hearings/${h.id}`,
    updatedAt: t?.updated_at,
  };
}
