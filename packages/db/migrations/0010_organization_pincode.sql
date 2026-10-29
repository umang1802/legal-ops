-- Firm PIN code, stored separately from the free-text address (Indian PIN: 6 digits, first digit 1-9).
ALTER TABLE organizations
  ADD COLUMN pincode CHAR(6),
  ADD CONSTRAINT ck_organizations_pincode CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$');
