import type { Permission } from './permissions.js';

export type OrganizationStatus = 'invited' | 'active' | 'suspended';

export type PlatformMe = {
  admin: { id: string; email: string; name: string };
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  csrfToken: string;
};

export type PlatformInvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

export type PlatformFirmSummary = {
  id: string;
  name: string;
  status: OrganizationStatus;
  ownerName: string | null;
  ownerEmail: string | null;
  inviteEmail: string | null;
  userCount: number;
  caseCount: number;
  lastActivityAt: string | null;
  createdAt: string;
};

export type PlatformAuditEntry = {
  id: string;
  action: string;
  adminName: string;
  adminEmail: string;
  organizationId: string | null;
  organizationName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type PlatformFirmDetail = PlatformFirmSummary & {
  platformNotes: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  invitation: { id: string; email: string; state: PlatformInvitationState; expiresAt: string; createdAt: string } | null;
  history: PlatformAuditEntry[];
};

/** While a firm is suspended its members keep read access only (L-12, spec §5.2). */
export function allowedWhileSuspended(permission: Permission): boolean {
  return permission.endsWith('.view') || permission === 'finance.dashboard';
}
