-- Global court reference data (organization_id NULL = visible to every firm) + search indexes.
-- District courts and tribunals are added per firm via POST /courts.

CREATE UNIQUE INDEX uq_courts_global_name ON courts (name) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX uq_courts_org_name ON courts (organization_id, lower(name)) WHERE organization_id IS NOT NULL;

INSERT INTO courts (organization_id, name, court_type, city, state) VALUES
  (NULL, 'Supreme Court of India', 'Supreme Court', 'New Delhi', 'Delhi'),
  (NULL, 'Allahabad High Court', 'High Court', 'Prayagraj', 'Uttar Pradesh'),
  (NULL, 'High Court of Andhra Pradesh', 'High Court', 'Amaravati', 'Andhra Pradesh'),
  (NULL, 'Bombay High Court', 'High Court', 'Mumbai', 'Maharashtra'),
  (NULL, 'Calcutta High Court', 'High Court', 'Kolkata', 'West Bengal'),
  (NULL, 'High Court of Chhattisgarh', 'High Court', 'Bilaspur', 'Chhattisgarh'),
  (NULL, 'Delhi High Court', 'High Court', 'New Delhi', 'Delhi'),
  (NULL, 'Gauhati High Court', 'High Court', 'Guwahati', 'Assam'),
  (NULL, 'Gujarat High Court', 'High Court', 'Ahmedabad', 'Gujarat'),
  (NULL, 'High Court of Himachal Pradesh', 'High Court', 'Shimla', 'Himachal Pradesh'),
  (NULL, 'High Court of Jammu & Kashmir and Ladakh', 'High Court', 'Srinagar', 'Jammu and Kashmir'),
  (NULL, 'Jharkhand High Court', 'High Court', 'Ranchi', 'Jharkhand'),
  (NULL, 'Karnataka High Court', 'High Court', 'Bengaluru', 'Karnataka'),
  (NULL, 'Kerala High Court', 'High Court', 'Kochi', 'Kerala'),
  (NULL, 'Madhya Pradesh High Court', 'High Court', 'Jabalpur', 'Madhya Pradesh'),
  (NULL, 'Madras High Court', 'High Court', 'Chennai', 'Tamil Nadu'),
  (NULL, 'Manipur High Court', 'High Court', 'Imphal', 'Manipur'),
  (NULL, 'Meghalaya High Court', 'High Court', 'Shillong', 'Meghalaya'),
  (NULL, 'Orissa High Court', 'High Court', 'Cuttack', 'Odisha'),
  (NULL, 'Patna High Court', 'High Court', 'Patna', 'Bihar'),
  (NULL, 'Punjab and Haryana High Court', 'High Court', 'Chandigarh', 'Chandigarh'),
  (NULL, 'Rajasthan High Court', 'High Court', 'Jodhpur', 'Rajasthan'),
  (NULL, 'Sikkim High Court', 'High Court', 'Gangtok', 'Sikkim'),
  (NULL, 'Telangana High Court', 'High Court', 'Hyderabad', 'Telangana'),
  (NULL, 'Tripura High Court', 'High Court', 'Agartala', 'Tripura'),
  (NULL, 'Uttarakhand High Court', 'High Court', 'Nainital', 'Uttarakhand');

-- Global search (PRD §14): substring match on email and party names.
CREATE INDEX idx_clients_email_trgm ON clients USING gin ((email::text) gin_trgm_ops);
CREATE INDEX idx_matters_org_updated ON matters (organization_id, updated_at DESC);
