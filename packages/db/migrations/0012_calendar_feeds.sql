-- Calendar sync (Vidhimeya must-have): personal, read-only, revocable iCalendar subscribe links.
-- Only the HMAC of the link's token is stored (like sessions). One active link per user per firm.
CREATE TABLE calendar_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ,              -- last time a calendar app fetched it
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_calendar_feeds_active ON calendar_feeds(organization_id, user_id) WHERE revoked_at IS NULL;

-- Firm choice: calendars show only case numbers and court (no parties, client or matter names).
ALTER TABLE organizations ADD COLUMN calendar_hide_parties BOOLEAN NOT NULL DEFAULT false;
