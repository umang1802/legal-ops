-- Per-firm feature switches, set by the LexForgeX team in the platform console.
-- A row exists only where a switch was set; no row means the feature's default from FEATURES in
-- @legalops/types. So a feature added later is off everywhere without touching this table.
-- feature_key is deliberately unconstrained: features are added in code, without a migration, and
-- keys the code no longer knows are ignored when read.
CREATE TABLE organization_features (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  feature_key VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_by UUID REFERENCES platform_admins(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, feature_key)
);
