-- Hearing types become a list each firm manages (only the firm adds or renames them). Hearings keep the type as text,
-- so history, the diary and calendar feeds are unchanged; this table is what the hearing form offers and enforces.
CREATE TABLE hearing_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(100) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_hearing_types_name ON hearing_types (organization_id, lower(name));
CREATE INDEX idx_hearing_types_org ON hearing_types (organization_id, position);
CREATE TRIGGER trg_hearing_types_updated_at BEFORE UPDATE ON hearing_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every existing firm starts with the standard list...
INSERT INTO hearing_types (organization_id, name, position)
SELECT o.id, d.name, d.pos
FROM organizations o
CROSS JOIN (VALUES ('Admission', 0), ('Arguments', 1), ('Evidence', 2), ('Cross-examination', 3), ('Framing of issues', 4),
                   ('Interim application', 5), ('Orders', 6), ('Mention', 7), ('Final hearing', 8), ('Other', 9)) AS d(name, pos);

-- ...and anything else its hearings were already saved with is kept as an ARCHIVED type: visible in settings so the firm
-- can bring it back, but not offered in the form (many of these will be one-off spellings).
INSERT INTO hearing_types (organization_id, name, position, is_active)
SELECT x.organization_id, x.name, 100 + (row_number() OVER (PARTITION BY x.organization_id ORDER BY x.name))::int, false
FROM (
  SELECT DISTINCT ON (h.organization_id, lower(trim(h.hearing_type))) h.organization_id, trim(h.hearing_type) AS name
  FROM hearings h
  WHERE h.hearing_type IS NOT NULL AND trim(h.hearing_type) <> ''
  ORDER BY h.organization_id, lower(trim(h.hearing_type)), h.created_at
) x
WHERE NOT EXISTS (SELECT 1 FROM hearing_types t WHERE t.organization_id = x.organization_id AND lower(t.name) = lower(x.name));
