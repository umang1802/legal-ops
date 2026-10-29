import type { FeatureKey } from './features.js';
import type { OrganizationStatus } from './platform.js';
import type { Permission } from './permissions.js';
import type { Role } from './roles.js';

export type ApiSuccess<T, M = Record<string, unknown>> = { data: T; meta?: M };

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CSRF_INVALID'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'NO_MEMBERSHIP'
  | 'TOKEN_INVALID'
  | 'NOT_CONFIGURED'
  | 'FEATURE_DISABLED'
  | 'DUPLICATE_WARNING'
  | 'MFA_REQUIRED'
  | 'FIRM_SUSPENDED'
  | 'INTERNAL_ERROR';

export type ApiError = {
  error: { code: ApiErrorCode; message: string; details?: unknown[] };
};

export type Paginated<T> = ApiSuccess<T[], { page: number; pageSize: number; total: number }>;

export type MembershipSummary = {
  organizationId: string;
  organizationName: string;
  role: Role;
};

export type MeResponse = {
  user: { id: string; email: string; firstName: string; lastName: string | null; emailVerified: boolean };
  organization: { id: string; name: string; timezone: string; currency: string; taxMode: 'simple' | 'gst'; status: OrganizationStatus };
  role: Role;
  permissions: readonly Permission[];
  /** Switchable features that are on for this firm (see FEATURES). */
  features: readonly FeatureKey[];
  memberships: MembershipSummary[];
  csrfToken: string;
};

export type MemberDto = {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  joinedAt: string | null;
};

export type OrganizationDto = {
  id: string;
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  stateCode: string | null;
  timezone: string;
  remindersEnabled: boolean;
  /** Calendar sync shows only case numbers and court, not parties, client or matter names. */
  calendarHideParties: boolean;
  currency: string;
  invoicePrefix: string;
  taxMode: 'simple' | 'gst';
  gstin: string | null;
  pan: string | null;
  defaultSendTime: string;
};
