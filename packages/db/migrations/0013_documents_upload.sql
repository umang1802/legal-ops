-- Documents (Vidhimeya must-have): bulk upload straight to S3 by multipart upload.
ALTER TABLE documents ADD COLUMN upload_id TEXT;  -- S3 multipart upload id while status = 'pending'
UPDATE documents SET category = 'other' WHERE category IS NULL OR category NOT IN
  ('pleadings', 'orders', 'evidence', 'correspondence', 'authority', 'client_documents', 'other');
ALTER TABLE documents
  ALTER COLUMN category SET DEFAULT 'other',
  ALTER COLUMN category SET NOT NULL,
  ADD CONSTRAINT ck_documents_category CHECK (category IN
    ('pleadings', 'orders', 'evidence', 'correspondence', 'authority', 'client_documents', 'other'));
CREATE INDEX idx_documents_org_hearing ON documents(organization_id, hearing_id) WHERE hearing_id IS NOT NULL;
