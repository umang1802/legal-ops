import { FEATURE_EVENT_PREFIXES, FEATURES, type FeatureKey, type PlatformFirmFeature, resolveFeatures } from '@legalops/types';
import { type Db, query } from '../../db/pool.js';
import { sql, type SqlFragment } from '../../db/sql.js';

type SwitchRow = { feature_key: string; enabled: boolean; updated_at: Date; set_by: string | null };

async function switchesOf(db: Db, organizationId: string): Promise<SwitchRow[]> {
  return query<SwitchRow>(
    db,
    sql`SELECT f.feature_key, f.enabled, f.updated_at, a.name AS set_by
        FROM organization_features f LEFT JOIN platform_admins a ON a.id = f.updated_by
        WHERE f.organization_id = ${organizationId}`,
  );
}

/** SQL condition on a timeline event-type column: false for activity of features that are off. */
export function activityVisible(features: readonly FeatureKey[], column: string): SqlFragment {
  const patterns = (Object.keys(FEATURE_EVENT_PREFIXES) as FeatureKey[])
    .filter((f) => !features.includes(f))
    .flatMap((f) => FEATURE_EVENT_PREFIXES[f]!.map((p) => `${p}%`));
  return patterns.length ? sql`NOT (${sql.raw(column)} LIKE ANY(${patterns}::text[]))` : sql`TRUE`;
}

/** The firm's switchable features that are on (its own switch where set, otherwise the default). */
export async function loadEnabledFeatures(db: Db, organizationId: string): Promise<FeatureKey[]> {
  const rows = await switchesOf(db, organizationId);
  return resolveFeatures(Object.fromEntries(rows.map((r) => [r.feature_key, r.enabled])));
}

export async function listFirmFeatures(db: Db, organizationId: string): Promise<PlatformFirmFeature[]> {
  const rows = new Map((await switchesOf(db, organizationId)).map((r) => [r.feature_key, r]));
  return FEATURES.map((f) => {
    const row = rows.get(f.key);
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      enabled: row ? row.enabled : f.defaultEnabled,
      isDefault: !row,
      setBy: row?.set_by ?? null,
      setAt: row ? row.updated_at.toISOString() : null,
    };
  });
}

/**
 * When a feature is switched off, client emails still waiting for approval that belong to it are marked not sent
 * (skipped), never held to go out late. Communication holds every approval; Billing its invoice and payment emails;
 * Automations the firm's own rules. Mirrors workflowFeatures in the workflow engine.
 */
export async function skipHeldEmails(db: Db, organizationId: string, key: FeatureKey): Promise<number> {
  const belongs =
    key === 'communication'
      ? sql`TRUE`
      : key === 'billing'
        ? sql`n.workflow_id IN (SELECT id FROM workflows WHERE trigger_type IN ('INVOICE_CREATED', 'INVOICE_PAID', 'PAYMENT_RECEIVED'))`
        : key === 'automations'
          ? sql`n.workflow_id IN (SELECT id FROM workflows WHERE system_key IS NULL)`
          : null;
  if (!belongs) return 0;
  const rows = await query(
    db,
    sql`UPDATE notifications n SET status = 'skipped', skip_reason = ${`feature_off:${key}`}, updated_at = now()
        WHERE n.organization_id = ${organizationId} AND n.status = 'awaiting_approval' AND ${belongs}
        RETURNING n.id`,
  );
  return rows.length;
}

/** Sets one switch. Setting it to the default value still stores it, so the firm keeps it if the default changes. */
export async function setFirmFeature(db: Db, organizationId: string, key: FeatureKey, enabled: boolean, adminId: string): Promise<void> {
  await query(
    db,
    sql`INSERT INTO organization_features (organization_id, feature_key, enabled, updated_by)
        VALUES (${organizationId}, ${key}, ${enabled}, ${adminId})
        ON CONFLICT (organization_id, feature_key)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  );
}
