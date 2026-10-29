import type { FeatureKey } from './features.js';
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

/** An invitation that hasn't been accepted or revoked (it may have expired; a new link resets the expiry). */
export type PlatformPendingInvitation = {
  id: string;
  email: string;
  role: string;
  /** "LexForgeX team" for platform invites, otherwise the firm member who sent it. */
  invitedBy: string;
  expiresAt: string;
  expired: boolean;
  createdAt: string;
};

/** A freshly minted accept-invite link. Shown once; minting another cancels this one. */
export type PlatformInviteLink = { url: string; email: string; role: string; expiresAt: string };

/** While a firm is suspended its members keep read access only (L-12, spec §5.2). */
export function allowedWhileSuspended(permission: Permission): boolean {
  return permission.endsWith('.view') || permission === 'finance.dashboard';
}

/** One feature switch on a firm, as the platform console shows it. */
export type PlatformFirmFeature = {
  key: FeatureKey;
  label: string;
  description: string;
  enabled: boolean;
  /** True when no one has set this switch, so the feature's default applies. */
  isDefault: boolean;
  setBy: string | null;
  setAt: string | null;
};
