-- Online payments through Zoho Payments (India): a firm's gateway credentials, the payment links created
-- from its invoices, and the webhook events received (for idempotency).

-- One row per firm and provider. Set by LexForgeX platform admins only. Secrets are AES-256-GCM encrypted
-- by the app (iv.tag.ciphertext) with the platform key; the plain values are never stored or returned.
CREATE TABLE organization_payment_gateways (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('zohopay')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  environment VARCHAR(10) NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'live')),
  account_id VARCHAR(40) NOT NULL,                 -- Zoho Payments account id (numeric)
  client_id VARCHAR(120) NOT NULL,                 -- Zoho OAuth client id
  client_secret_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  signing_key_enc TEXT,                            -- webhook signing key; webhooks are refused until it is set
  last_test_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_message VARCHAR(300),
  updated_by UUID REFERENCES platform_admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider),
  CHECK (account_id ~ '^[0-9]{3,20}$')
);

CREATE TABLE payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  client_id UUID NOT NULL REFERENCES clients(id),
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('zohopay')),
  environment VARCHAR(10) NOT NULL CHECK (environment IN ('sandbox', 'live')),
  provider_link_id VARCHAR(60) NOT NULL,
  url TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'expired', 'canceled')),
  expires_at DATE,
  paid_at TIMESTAMPTZ,
  provider_payment_id VARCHAR(60),
  payment_id UUID REFERENCES payments(id),          -- the receipt recorded when it was paid
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_link_id)
);
CREATE INDEX idx_payment_links_invoice ON payment_links(organization_id, invoice_id, created_at DESC);
-- At most one open link per invoice, so a client is never handed two ways to pay the same bill.
CREATE UNIQUE INDEX uq_payment_links_one_active ON payment_links(invoice_id) WHERE status = 'active';

-- Every webhook delivery that passed signature verification. The unique key makes retries harmless.
CREATE TABLE payment_gateway_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider VARCHAR(20) NOT NULL,
  event_id VARCHAR(60) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result VARCHAR(300),
  UNIQUE (provider, event_id)
);
