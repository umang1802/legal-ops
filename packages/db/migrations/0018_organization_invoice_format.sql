-- A firm's invoice look (sections, letterhead, labels, footer, watermark). NULL = the standard format.
-- The app fills in anything missing when it reads this, so partial or older values are fine.
ALTER TABLE organizations ADD COLUMN invoice_format JSONB;
