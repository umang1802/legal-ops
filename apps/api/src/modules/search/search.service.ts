import { can, type SearchResultsDto } from '@legalops/types';
import { query } from '../../db/pool.js';
import { sql } from '../../db/sql.js';
import type { Deps } from '../../deps.js';
import type { TenantContext } from '../../http/context.js';
import { likeContains } from '../../http/query-helpers.js';
import { matterVisible } from '../access/matter-scope.js';

const LIMIT = 5;

/** Org-scoped global search (PRD §14). Matter-owned results respect assignment visibility. */
export async function search(deps: Deps, ctx: TenantContext, q: string): Promise<SearchResultsDto> {
  const p = likeContains(q);
  const digits = q.replace(/\D/g, '');
  const org = ctx.organizationId;

  const [clients, matters, cases, invoices] = await Promise.all([
    can(ctx.role, 'clients.view')
      ? query<{ id: string; name: string; email: string | null; phone: string | null }>(
          deps.pool,
          sql`SELECT id, name, email, phone FROM clients
              WHERE organization_id = ${org} AND status <> 'archived'
                AND (name ILIKE ${p} OR email ILIKE ${p}
                     ${digits.length >= 4 ? sql`OR phone_e164 LIKE ${likeContains(digits)}` : sql.empty})
              ORDER BY similarity(name, ${q}) DESC, name LIMIT ${LIMIT}`,
        )
      : [],
    query<{ id: string; title: string; reference_code: string | null; client_name: string }>(
      deps.pool,
      sql`SELECT m.id, m.title, m.reference_code, c.name AS client_name
          FROM matters m JOIN clients c ON c.id = m.client_id
          WHERE m.organization_id = ${org} AND ${matterVisible(ctx, sql.raw('m.id'))}
            AND (m.title ILIKE ${p} OR m.reference_code ILIKE ${p})
          ORDER BY similarity(m.title, ${q}) DESC, m.updated_at DESC LIMIT ${LIMIT}`,
    ),
    query<{ id: string; title: string; case_number: string | null; cnr: string | null; matter_id: string }>(
      deps.pool,
      sql`SELECT cs.id, cs.title, cs.case_number, cs.cnr, cs.matter_id FROM cases cs
          WHERE cs.organization_id = ${org} AND ${matterVisible(ctx, sql.raw('cs.matter_id'))}
            AND (cs.case_number ILIKE ${p} OR cs.cnr ILIKE ${p} OR cs.title ILIKE ${p})
          ORDER BY cs.updated_at DESC LIMIT ${LIMIT}`,
    ),
    can(ctx.role, 'billing.view')
      ? query<{ id: string; invoice_number: string; matter_id: string; client_name: string }>(
          deps.pool,
          sql`SELECT i.id, i.invoice_number, i.matter_id, c.name AS client_name
              FROM invoices i JOIN clients c ON c.id = i.client_id
              WHERE i.organization_id = ${org} AND i.invoice_number ILIKE ${p}
                AND ${matterVisible(ctx, sql.raw('i.matter_id'))}
              ORDER BY i.issue_date DESC NULLS LAST LIMIT ${LIMIT}`,
        )
      : [],
  ]);

  return {
    clients,
    matters: matters.map((m) => ({
      id: m.id,
      title: m.title,
      referenceCode: m.reference_code,
      clientName: m.client_name,
    })),
    cases: cases.map((c) => ({
      id: c.id,
      title: c.title,
      caseNumber: c.case_number,
      cnr: c.cnr,
      matterId: c.matter_id,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      matterId: i.matter_id,
      clientName: i.client_name,
    })),
  };
}
