CREATE TABLE customer_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  property_id uuid REFERENCES customer_addresses(id) ON DELETE SET NULL,
  service_type text NOT NULL,
  subject text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'scheduled', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customer_service_requests_customer_idx
  ON customer_service_requests(customer_id, created_at DESC);

CREATE INDEX customer_service_requests_unit_status_idx
  ON customer_service_requests(business_unit_id, status, created_at DESC);

CREATE TRIGGER customer_service_requests_set_updated_at
BEFORE UPDATE ON customer_service_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_customer_service_request_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  customer_unit uuid;
  property_customer uuid;
  property_unit uuid;
BEGIN
  SELECT business_unit_id INTO customer_unit
  FROM customers
  WHERE id = NEW.customer_id;

  IF customer_unit IS NULL OR customer_unit <> NEW.business_unit_id THEN
    RAISE EXCEPTION 'Customer service request must use the customer business unit';
  END IF;

  IF NEW.property_id IS NOT NULL THEN
    SELECT customer_id, business_unit_id INTO property_customer, property_unit
    FROM customer_addresses
    WHERE id = NEW.property_id;

    IF property_customer IS NULL
       OR property_customer <> NEW.customer_id
       OR property_unit <> NEW.business_unit_id THEN
      RAISE EXCEPTION 'Customer service request property must belong to the same customer and business unit';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_service_requests_validate_scope
BEFORE INSERT OR UPDATE OF business_unit_id, customer_id, property_id
ON customer_service_requests
FOR EACH ROW EXECUTE FUNCTION validate_customer_service_request_scope();
