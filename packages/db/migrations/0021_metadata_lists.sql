-- Firm-managed pick-lists ("metadata"): one table for every list a firm keeps for itself. A firm adds, renames, reorders
-- and archives entries (Settings → Metadata); forms offer the active ones. Records store the entry's name as text, so
-- history, the diary and printouts read the same everywhere.
CREATE TABLE metadata_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  list_key VARCHAR(40) NOT NULL CHECK (list_key IN ('hearing_type', 'document_category', 'practice_area', 'expense_category')),
  name VARCHAR(100) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_metadata_options_name ON metadata_options (organization_id, list_key, lower(name));
CREATE INDEX idx_metadata_options_list ON metadata_options (organization_id, list_key, position);
CREATE TRIGGER trg_metadata_options_updated_at BEFORE UPDATE ON metadata_options FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- Hearing types move across from their own table (same ids, same order, same archived entries) ----
INSERT INTO metadata_options (id, organization_id, list_key, name, position, is_active, created_by, created_at, updated_at)
SELECT id, organization_id, 'hearing_type', name, position, is_active, created_by, created_at, updated_at FROM hearing_types;
DROP TABLE hearing_types;

-- ---- File categories: stored as the category's name instead of a fixed code, and now optional ----
ALTER TABLE documents DROP CONSTRAINT ck_documents_category;
ALTER TABLE documents ALTER COLUMN category DROP NOT NULL, ALTER COLUMN category DROP DEFAULT;
UPDATE documents SET category = CASE category
  WHEN 'pleadings' THEN 'Pleadings'
  WHEN 'orders' THEN 'Orders & judgments'
  WHEN 'evidence' THEN 'Evidence'
  WHEN 'correspondence' THEN 'Correspondence'
  WHEN 'authority' THEN 'Vakalatnama & authority'
  WHEN 'client_documents' THEN 'Client documents'
  ELSE 'Other' END;

-- Every existing firm starts with the standard lists...
INSERT INTO metadata_options (organization_id, list_key, name, position)
SELECT o.id, d.list_key, d.name, d.pos
FROM organizations o
CROSS JOIN (VALUES
  ('document_category', 'Pleadings', 0), ('document_category', 'Orders & judgments', 1), ('document_category', 'Evidence', 2),
  ('document_category', 'Correspondence', 3), ('document_category', 'Vakalatnama & authority', 4),
  ('document_category', 'Client documents', 5), ('document_category', 'Other', 6),
  ('practice_area', 'Civil', 0), ('practice_area', 'Criminal', 1), ('practice_area', 'Commercial', 2), ('practice_area', 'Family', 3),
  ('practice_area', 'Property', 4), ('practice_area', 'Labour', 5), ('practice_area', 'Tax', 6), ('practice_area', 'Consumer', 7),
  ('practice_area', 'Arbitration', 8), ('practice_area', 'Constitutional', 9), ('practice_area', 'Corporate', 10),
  ('practice_area', 'IPR', 11), ('practice_area', 'Other', 12),
  ('expense_category', 'Court fees', 0), ('expense_category', 'Stamp duty', 1), ('expense_category', 'Filing & process fees', 2),
  ('expense_category', 'Certified copies', 3), ('expense_category', 'Travel', 4), ('expense_category', 'Courier', 5),
  ('expense_category', 'Typing & printing', 6), ('expense_category', 'Counsel fees', 7), ('expense_category', 'Other', 8)
) AS d(list_key, name, pos);

-- ...and any other practice area or expense category its records already carry is kept as an ARCHIVED entry: visible in
-- settings so the firm can bring it back, but not offered on forms (many will be one-off spellings).
INSERT INTO metadata_options (organization_id, list_key, name, position, is_active)
SELECT x.organization_id, x.list_key, x.name, 100 + (row_number() OVER (PARTITION BY x.organization_id, x.list_key ORDER BY x.name))::int, false
FROM (
  SELECT DISTINCT ON (organization_id, list_key, lower(name)) organization_id, list_key, name FROM (
    SELECT organization_id, 'practice_area' AS list_key, trim(practice_area) AS name, created_at FROM matters WHERE practice_area IS NOT NULL AND trim(practice_area) <> ''
    UNION ALL
    SELECT organization_id, 'expense_category', trim(category), created_at FROM expenses WHERE category IS NOT NULL AND trim(category) <> ''
  ) v
  ORDER BY organization_id, list_key, lower(name), created_at
) x
WHERE NOT EXISTS (
  SELECT 1 FROM metadata_options m WHERE m.organization_id = x.organization_id AND m.list_key = x.list_key AND lower(m.name) = lower(x.name)
);
