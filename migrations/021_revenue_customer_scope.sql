-- Enforce that revenue customer links remain inside the selected business unit.

CREATE OR REPLACE FUNCTION validate_revenue_customer_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM customers c
    WHERE c.id = NEW.customer_id
      AND c.business_unit_id = NEW.business_unit_id
  ) THEN
    RAISE EXCEPTION 'Revenue customer must belong to the same business unit.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revenue_customer_scope_trg ON revenue_records;
CREATE TRIGGER revenue_customer_scope_trg
BEFORE INSERT OR UPDATE OF business_unit_id, customer_id
ON revenue_records
FOR EACH ROW
EXECUTE FUNCTION validate_revenue_customer_scope();
