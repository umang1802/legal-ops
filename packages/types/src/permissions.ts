import type { Role } from './roles.js';

/**
 * Capability matrix from PRD §4. "configurable" cells default to the conservative value
 * until per-org overrides land (organizations.settings.permissions).
 */
export const PERMISSIONS = [
  'dashboard.view',
  'users.manage',
  'organization.manage',
  'clients.view',
  'clients.create',
  'clients.edit',
  'matters.view',
  'matters.create',
  'matters.edit',
  'hearings.manage',
  'tasks.manage',
  'documents.view',
  'documents.upload',
  'billing.view',
  'invoices.manage',
  'payments.record',
  'finance.dashboard',
  'workflows.manage',
  'templates.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  lawyer: [
    'dashboard.view',
    'clients.view',
    'clients.create',
    'clients.edit',
    'matters.view',
    'matters.create',
    'matters.edit',
    'hearings.manage',
    'tasks.manage',
    'documents.view',
    'documents.upload',
    'billing.view',
  ],
  staff: [
    'dashboard.view',
    'clients.view',
    'clients.create',
    'matters.view',
    'matters.create',
    'hearings.manage',
    'tasks.manage',
    'documents.view',
    'documents.upload',
  ],
  finance: [
    'dashboard.view',
    'clients.view',
    'clients.create',
    'matters.view',
    'documents.view',
    'billing.view',
    'invoices.manage',
    'payments.record',
    'finance.dashboard',
    'audit.view',
  ],
  read_only: ['dashboard.view', 'clients.view', 'matters.view', 'documents.view'],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
