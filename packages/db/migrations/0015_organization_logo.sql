-- Firm logo (docs/superpowers/specs/2026-10-30-firm-logo-design.md). The file lives in the documents bucket at
-- org/<id>/branding/<logo_id>.<logo_type>. Replacing or removing a logo only changes these columns; earlier files are
-- kept on purpose so emails already sent keep showing the logo they were sent with.
ALTER TABLE organizations
  ADD COLUMN logo_id UUID,
  ADD COLUMN logo_type VARCHAR(3) CHECK (logo_type IN ('png', 'jpg')),
  ADD CONSTRAINT organizations_logo_complete CHECK ((logo_id IS NULL) = (logo_type IS NULL));

-- Every logo file that passed the upload check (size + PNG/JPEG bytes). The public logo route serves only files listed
-- here, so anything PUT to a signed upload URL but never completed (or refused) is never served. Rows are kept after a
-- logo is replaced or removed, for the same reason the files are.
CREATE TABLE organization_logos (
  logo_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  logo_type VARCHAR(3) NOT NULL CHECK (logo_type IN ('png', 'jpg')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
