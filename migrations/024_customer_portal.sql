-- Customer-facing portal identities, sessions, properties metadata, and booking workflow.

CREATE TABLE customer_portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  email citext NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, email)
);

CREATE INDEX customer_portal_accounts_site_idx
  ON customer_portal_accounts(site_id, status, email);

CREATE TRIGGER customer_portal_accounts_set_updated_at
BEFORE UPDATE ON customer_portal_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_customer_portal_account_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  customer_unit uuid;
  site_unit uuid;
  site_scope text;
BEGIN
  SELECT business_unit_id INTO customer_unit
  FROM customers
  WHERE id = NEW.customer_id;

  SELECT business_unit_id, scope INTO site_unit, site_scope
  FROM sites
  WHERE id = NEW.site_id;

  IF customer_unit IS NULL OR customer_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Customer portal account must use the customer business unit';
  END IF;

  IF site_scope <> 'business_unit' OR site_unit IS NULL OR site_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Customer portal account site must belong to the same business unit';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_portal_accounts_validate_scope
BEFORE INSERT OR UPDATE OF business_unit_id, customer_id, site_id
ON customer_portal_accounts
FOR EACH ROW EXECUTE FUNCTION validate_customer_portal_account_scope();

CREATE TABLE customer_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_portal_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_portal_sessions_account_idx
  ON customer_portal_sessions(account_id, expires_at DESC);

CREATE INDEX customer_portal_sessions_expiry_idx
  ON customer_portal_sessions(expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE customer_addresses
  ADD CONSTRAINT customer_addresses_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object');

CREATE TABLE customer_booking_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 100),
  service_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX customer_booking_slots_unit_time_idx
  ON customer_booking_slots(business_unit_id, starts_at, status);

CREATE TRIGGER customer_booking_slots_set_updated_at
BEFORE UPDATE ON customer_booking_slots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES customer_booking_slots(id) ON DELETE RESTRICT,
  property_id uuid REFERENCES customer_addresses(id) ON DELETE SET NULL,
  service_type text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled', 'completed')),
  schedule_entry_id uuid UNIQUE REFERENCES schedule_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX customer_bookings_customer_time_idx
  ON customer_bookings(customer_id, starts_at DESC, status);

CREATE INDEX customer_bookings_unit_status_idx
  ON customer_bookings(business_unit_id, status, starts_at);

CREATE UNIQUE INDEX customer_bookings_customer_slot_active_idx
  ON customer_bookings(customer_id, slot_id)
  WHERE status IN ('requested', 'confirmed');

CREATE TRIGGER customer_bookings_set_updated_at
BEFORE UPDATE ON customer_bookings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_customer_booking_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  customer_unit uuid;
  slot_unit uuid;
  property_customer uuid;
  property_unit uuid;
BEGIN
  SELECT business_unit_id INTO customer_unit
  FROM customers
  WHERE id = NEW.customer_id;

  SELECT business_unit_id INTO slot_unit
  FROM customer_booking_slots
  WHERE id = NEW.slot_id;

  IF customer_unit IS NULL OR customer_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Customer booking customer must belong to the booking business unit';
  END IF;

  IF slot_unit IS NULL OR slot_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Customer booking slot must belong to the booking business unit';
  END IF;

  IF NEW.property_id IS NOT NULL THEN
    SELECT customer_id, business_unit_id INTO property_customer, property_unit
    FROM customer_addresses
    WHERE id = NEW.property_id;

    IF property_customer IS NULL
       OR property_customer <> NEW.customer_id
       OR property_unit <> NEW.business_unit_id THEN
      RAISE EXCEPTION 'Customer booking property must belong to the same customer and business unit';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_bookings_validate_scope
BEFORE INSERT OR UPDATE OF business_unit_id, customer_id, slot_id, property_id
ON customer_bookings
FOR EACH ROW EXECUTE FUNCTION validate_customer_booking_scope();
