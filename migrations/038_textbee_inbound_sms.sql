CREATE TABLE IF NOT EXISTS inbound_sms_events (
  provider text NOT NULL,
  idempotency_key text NOT NULL,
  provider_message_id text,
  device_id text,
  sender text NOT NULL,
  message text NOT NULL,
  received_at timestamptz,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  action text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_inbound_sms_events_customer
  ON inbound_sms_events(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_sms_events_sender
  ON inbound_sms_events(sender, created_at DESC);
