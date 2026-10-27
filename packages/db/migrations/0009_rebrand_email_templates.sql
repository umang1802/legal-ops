-- Rebrand: LegalOps / LegalForgeX -> LexForgeX in the built-in (system) email templates.
-- Only organization_id IS NULL rows are touched; a firm's own edited templates are left alone.
-- Migrations 0005 and 0007 already ran in production, so this fixes live data instead of editing them.
UPDATE email_templates SET
  subject_template = replace(replace(subject_template, 'LegalForgeX', 'LexForgeX'), 'LegalOps', 'LexForgeX'),
  html_body        = replace(replace(html_body,        'LegalForgeX', 'LexForgeX'), 'LegalOps', 'LexForgeX'),
  text_body        = replace(replace(text_body,        'LegalForgeX', 'LexForgeX'), 'LegalOps', 'LexForgeX'),
  updated_at       = now()
WHERE organization_id IS NULL
  AND (subject_template ~ '(LegalForgeX|LegalOps)' OR html_body ~ '(LegalForgeX|LegalOps)' OR text_body ~ '(LegalForgeX|LegalOps)');
