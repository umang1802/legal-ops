import { can, type Permission } from './permissions.js';
import type { Role } from './roles.js';

/**
 * Features the LexForgeX team switches on or off per firm from the platform console. Core features (clients,
 * matters, hearings, calendar, tasks, team) are always on and aren't listed. To add a feature later, append it
 * here with `defaultEnabled: false` so it stays off for every firm until switched on, then guard its code.
 */
export type FeatureDef = { key: string; label: string; description: string; defaultEnabled: boolean };

export const FEATURES = [
  { key: 'documents', label: 'Documents', description: 'Upload and view case papers and orders on matters and hearings.', defaultEnabled: true },
  { key: 'billing', label: 'Billing', description: 'Invoices, payments and receipts, expenses, fee agreements and collections.', defaultEnabled: true },
  { key: 'communication', label: 'Communication', description: 'The log of client emails, and approving emails before they go out.', defaultEnabled: true },
  { key: 'automations', label: 'Automations', description: 'Firms edit and add their own automatic email rules (built-in reminders run regardless).', defaultEnabled: true },
  { key: 'diary', label: 'Diary & printouts', description: 'The printable next-day hearings board and printable matter history.', defaultEnabled: true },
  { key: 'calendar_sync', label: 'Calendar sync', description: 'Hearings in Google, Outlook or Apple Calendar through subscription links.', defaultEnabled: true },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS: readonly FeatureKey[] = FEATURES.map((f) => f.key);
export const isFeatureKey = (k: string): k is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(k);
/** A feature's console name, or the key itself for one the code no longer knows (e.g. in old audit entries). */
export const featureLabel = (k: string): string => FEATURES.find((f) => f.key === k)?.label ?? k;

/** The feature a permission belongs to. A permission whose feature is off counts as not granted. */
export const PERMISSION_FEATURE: Partial<Record<Permission, FeatureKey>> = {
  'documents.view': 'documents',
  'documents.upload': 'documents',
  'billing.view': 'billing',
  'invoices.manage': 'billing',
  'payments.record': 'billing',
  'finance.dashboard': 'billing',
  'workflows.manage': 'automations',
  'templates.manage': 'automations',
};

/** Timeline event types (by prefix) that belong to a feature: activity feeds leave them out while it's off. */
export const FEATURE_EVENT_PREFIXES: Partial<Record<FeatureKey, readonly string[]>> = {
  billing: ['invoice.', 'payment.', 'fee_agreement.', 'fee_milestone.', 'expense.'],
  documents: ['document.'],
};

/** Features that are on: a firm's own switch where one is set, otherwise the feature's default. */
export function resolveFeatures(overrides: Partial<Record<string, boolean>>, defs: readonly FeatureDef[] = FEATURES): FeatureKey[] {
  return defs.filter((d) => overrides[d.key] ?? d.defaultEnabled).map((d) => d.key as FeatureKey);
}

export function canWithFeatures(role: Role, features: readonly FeatureKey[], permission: Permission): boolean {
  const feature = PERMISSION_FEATURE[permission];
  return can(role, permission) && (!feature || features.includes(feature));
}
