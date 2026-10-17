import { can, seesAllMatters, type DashboardDto } from '@legalops/types';
import { query, queryOne } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { TenantContext } from '../../http/context.js';
import { orgToday } from '../../http/dates.js';
import { iso } from '../../http/query-helpers.js';
import { matterVisible } from '../access/matter-scope.js';
import { receivableTotals } from '../billing/summary.service.js';
import { queryHearings } from '../hearings/hearings.service.js';
import { queryTasks } from '../tasks/tasks.service.js';

const LIST_LIMIT = 10;

/**
 * "What needs my attention today?" (PRD §12), aggregated server-side in one call.
 * Firm-wide roles see the firm; everyone else sees their assigned matters and their own tasks.
 * Money figures are null for roles without the firm financial view.
 */
export async function getDashboard(deps: Deps, ctx: TenantContext): Promise<DashboardDto> {
  const db = deps.pool;
  const today = await orgToday(db, ctx.organizationId);
  const firm = seesAllMatters(ctx.role);
  const localDue = sql`(t.due_at AT TIME ZONE o.timezone)::date`;
  const open = sql`t.status IN ('todo', 'in_progress', 'blocked')`;
  const mine = firm ? sql`TRUE` : sql`t.assignee_id = ${ctx.userId}`;

  const [hearingsToday, upcomingHearings, pendingOutcomes, tasksDueToday, overdueTasks] = await Promise.all([
    queryHearings(db, ctx, [sql`h.scheduled_date = ${today}`, sql`h.status <> 'cancelled'`]),
    queryHearings(
      db,
      ctx,
      [
        sql`h.scheduled_date > ${today}`,
        sql`h.scheduled_date <= ${today}::date + 7`,
        sql`h.status = 'scheduled'`,
      ],
      undefined,
      LIST_LIMIT,
    ),
    queryHearings(
      db,
      ctx,
      [sql`h.status = 'scheduled'`, sql`h.scheduled_date < ${today}`],
      sql`h.scheduled_date DESC`,
      LIST_LIMIT,
    ),
    queryTasks(
      db,
      ctx,
      [open, mine, sql`${localDue} = ${today}`],
      sql`t.due_at, t.priority = 'urgent' DESC`,
      {
        page: 1,
        pageSize: LIST_LIMIT,
      },
    ),
    // Overdue = due on an earlier day (today's items are "due today", not overdue yet).
    queryTasks(db, ctx, [open, mine, sql`${localDue} < ${today}`], sql`t.due_at`, {
      page: 1,
      pageSize: LIST_LIMIT,
    }),
  ]);

  const pendingCount = await queryOne<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM hearings h JOIN cases cs ON cs.id = h.case_id
        WHERE h.organization_id = ${ctx.organizationId} AND h.status = 'scheduled' AND h.scheduled_date < ${today}
          AND ${matterVisible(ctx, sql.raw('cs.matter_id'))}`,
  );

  const recent = await query<{
    id: string;
    event_type: string;
    title: string;
    description: string | null;
    actor_user_id: string | null;
    first_name: string | null;
    last_name: string | null;
    actor_type: 'user' | 'system' | 'workflow' | 'provider';
    case_id: string | null;
    created_at: Date;
    matter_id: string | null;
    matter_title: string | null;
  }>(
    db,
    sql`SELECT e.id, e.event_type, e.title, e.description, e.actor_user_id, u.first_name, u.last_name, e.actor_type,
               e.case_id, e.created_at, e.matter_id, m.title AS matter_title
        FROM timeline_events e
        JOIN matters m ON m.id = e.matter_id
        LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.organization_id = ${ctx.organizationId} AND ${matterVisible(ctx, sql.raw('e.matter_id'))}
        ORDER BY e.created_at DESC
        LIMIT ${LIST_LIMIT}`,
  );

  // Money only for roles with the firm financial dashboard (owner/admin/finance); lawyers keep "—".
  const money = can(ctx.role, 'finance.dashboard') ? await receivableTotals(db, ctx) : null;

  return {
    today,
    scope: firm ? 'firm' : 'mine',
    counts: {
      hearingsToday: hearingsToday.length,
      tasksDueToday: tasksDueToday.total,
      overdueTasks: overdueTasks.total,
      pendingOutcomes: pendingCount?.n ?? 0,
      outstanding: money?.outstanding ?? null,
      overdueAmount: money?.overdue ?? null,
    },
    hearingsToday,
    upcomingHearings,
    pendingOutcomes,
    tasksDueToday: tasksDueToday.items,
    overdueTasks: overdueTasks.items,
    recentChanges: recent.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      title: e.title,
      description: e.description,
      actor: e.actor_user_id
        ? { userId: e.actor_user_id, firstName: e.first_name ?? '', lastName: e.last_name }
        : null,
      actorType: e.actor_type,
      caseId: e.case_id,
      createdAt: iso(e.created_at)!,
      matter: e.matter_id ? { id: e.matter_id, title: e.matter_title ?? '' } : null,
    })),
  };
}
