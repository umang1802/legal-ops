import type { FeatureKey, OrganizationStatus, Role } from '@legalops/types';
import type { Logger } from 'pino';

/** Who is acting, derived only from the authenticated session, never from request input. */
export type TenantContext = {
  userId: string;
  organizationId: string;
  role: Role;
  /** The firm's switchable features that are on (see FEATURES in @legalops/types). */
  features: readonly FeatureKey[];
};

export type AuthContext = TenantContext & { sessionId: string; csrfSecret: string; orgStatus: OrganizationStatus };

export type RequestMeta = { requestId: string; ip: string | null; userAgent: string | null };

/** A platform (LexForgeX team) session. Never carries a firm; never authorises firm endpoints. */
export type PlatformAuth = { sessionId: string; adminId: string; csrfSecret: string; mfaVerified: boolean };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      auth?: AuthContext;
      platform?: PlatformAuth;
    }
  }
}
