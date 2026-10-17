export const ROLES = ['owner', 'admin', 'lawyer', 'staff', 'finance', 'read_only'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner / Partner',
  admin: 'Admin',
  lawyer: 'Lawyer',
  staff: 'Staff / Clerk',
  finance: 'Finance',
  read_only: 'Read-only',
};

/** Roles that see every matter in the firm (decisions.md D-004). Everyone else sees assigned matters only. */
export const ROLES_SEEING_ALL_MATTERS: readonly Role[] = ['owner', 'admin', 'finance'];

export function seesAllMatters(role: Role): boolean {
  return ROLES_SEEING_ALL_MATTERS.includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
