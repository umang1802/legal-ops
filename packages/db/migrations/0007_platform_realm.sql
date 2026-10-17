-- LegalForgeX Track 2: platform realm (spec §3.1–3.3, §5.2).

ALTER TABLE organizations
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended')),
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_reason TEXT,
  ADD COLUMN platform_notes TEXT,               -- LegalForgeX team only; never returned by firm APIs
  ADD CONSTRAINT ck_org_suspension CHECK ((status = 'suspended') = (suspended_at IS NOT NULL));
CREATE INDEX idx_organizations_status ON organizations(status);

-- Platform admins are a separate realm from firm users (L-03). Created by CLI only.
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,                          -- AES-256-GCM; NULL until enrolment starts
  totp_enrolled_at TIMESTAMPTZ,                  -- set by the first successful code
  totp_last_step BIGINT,                         -- last accepted TOTP time-step (replay guard)
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_platform_admins_updated BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_sessions (
  id TEXT PRIMARY KEY,                           -- HMAC of the cookie token; raw token never stored
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  mfa_verified_at TIMESTAMPTZ,                   -- NULL: password only, platform APIs refuse
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_platform_sessions_admin ON platform_sessions(platform_admin_id);

CREATE TABLE platform_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  platform_admin_id UUID NOT NULL REFERENCES platform_admins(id),
  action VARCHAR(60) NOT NULL,
  organization_id UUID REFERENCES organizations(id),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_org ON platform_audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_platform_audit_created ON platform_audit_logs(created_at DESC);
CREATE TRIGGER trg_platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE invitations
  ADD COLUMN invited_by_platform_admin_id UUID REFERENCES platform_admins(id),
  ADD CONSTRAINT ck_invitation_single_inviter CHECK (invited_by IS NULL OR invited_by_platform_admin_id IS NULL);

INSERT INTO email_templates (organization_id, template_key, name, event_type, audience, subject_template, html_body, text_body) VALUES
(NULL, 'firm_owner_invite', 'Firm owner invitation', 'MEMBER_INVITED', 'internal',
 'Set up {{firm.name}} on LegalForgeX',
 '<p>Hello {{recipient.first_name}},</p><p>Your LegalForgeX workspace for <strong>{{firm.name}}</strong> is ready. Accept the invitation to set your password and finish setting up your firm.</p><p><a href="{{links.accept_invite}}">Set up your firm</a> (the link expires in 7 days).</p><p>If you weren’t expecting this, you can ignore this email.</p>',
 NULL);
