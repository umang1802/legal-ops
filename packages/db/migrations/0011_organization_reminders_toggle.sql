-- Firm-wide switch for scheduled reminders (hearing and payment reminders). On by default.
ALTER TABLE organizations ADD COLUMN reminders_enabled BOOLEAN NOT NULL DEFAULT true;
