-- LegalForgeX Track 2 review fix: per-admin throttle on the second factor (RFC 6238 §5.2).
ALTER TABLE platform_admins
  ADD COLUMN failed_totp_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN totp_locked_until TIMESTAMPTZ;
