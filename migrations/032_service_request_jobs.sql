CREATE SEQUENCE IF NOT EXISTS work_order_auto_number_seq START WITH 1 INCREMENT BY 1;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS source_service_request_id uuid
  REFERENCES customer_service_requests(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_source_service_request_uidx
  ON work_orders(source_service_request_id)
  WHERE source_service_request_id IS NOT NULL;

UPDATE feature_definitions
SET
  name = 'Jobs',
  description = 'Approved customer work and field execution records.'
WHERE key = 'work_orders';

INSERT INTO business_unit_features (business_unit_id, feature_key, enabled, config)
SELECT id, 'work_orders', true, '{}'::jsonb
FROM business_units
WHERE slug = 'pos'
ON CONFLICT (business_unit_id, feature_key)
DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = now();

CREATE OR REPLACE FUNCTION sync_service_request_job()
RETURNS trigger AS $$
DECLARE
  existing_job_id uuid;
  job_number text;
  job_status text;
  job_start timestamptz;
  job_end timestamptz;
BEGIN
  IF NEW.status = 'accepted' THEN
    SELECT id
      INTO existing_job_id
      FROM work_orders
     WHERE source_service_request_id = NEW.id
     LIMIT 1;

    IF NEW.schedule_entry_id IS NOT NULL THEN
      SELECT starts_at, ends_at
        INTO job_start, job_end
        FROM schedule_entries
       WHERE id = NEW.schedule_entry_id
         AND business_unit_id = NEW.business_unit_id;
    ELSE
      job_start := NEW.requested_at;
      job_end := NULL;
    END IF;

    job_status := CASE
      WHEN NEW.schedule_entry_id IS NOT NULL THEN 'scheduled'
      ELSE 'draft'
    END;

    IF existing_job_id IS NULL THEN
      job_number := format(
        'JOB-%s-%s',
        to_char(CURRENT_DATE, 'YYYY'),
        lpad(nextval('work_order_auto_number_seq')::text, 6, '0')
      );

      INSERT INTO work_orders (
        business_unit_id,
        customer_id,
        schedule_entry_id,
        service_address_id,
        work_order_number,
        title,
        description,
        status,
        scheduled_start,
        scheduled_end,
        source_service_request_id,
        notes
      ) VALUES (
        NEW.business_unit_id,
        NEW.customer_id,
        NEW.schedule_entry_id,
        NEW.property_id,
        job_number,
        NEW.subject,
        NEW.description,
        job_status,
        job_start,
        job_end,
        NEW.id,
        'Generated from an approved customer service request.'
      );
    ELSIF NEW.schedule_entry_id IS DISTINCT FROM OLD.schedule_entry_id THEN
      UPDATE work_orders
         SET schedule_entry_id = NEW.schedule_entry_id,
             service_address_id = NEW.property_id,
             scheduled_start = job_start,
             scheduled_end = job_end,
             status = job_status
       WHERE id = existing_job_id;
    END IF;
  END IF;

  IF NEW.status IN ('scheduled', 'completed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE work_orders
       SET status = CASE NEW.status
           WHEN 'scheduled' THEN 'scheduled'
           WHEN 'completed' THEN 'completed'
           WHEN 'cancelled' THEN 'cancelled'
         END,
           completed_at = CASE
             WHEN NEW.status = 'completed' THEN COALESCE(completed_at, now())
             ELSE completed_at
           END
     WHERE source_service_request_id = NEW.id
       AND business_unit_id = NEW.business_unit_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_service_requests_sync_job ON customer_service_requests;
CREATE TRIGGER customer_service_requests_sync_job
AFTER UPDATE OF status, schedule_entry_id ON customer_service_requests
FOR EACH ROW EXECUTE FUNCTION sync_service_request_job();

CREATE OR REPLACE FUNCTION sync_job_service_request_status()
RETURNS trigger AS $$
DECLARE
  request_status text;
BEGIN
  IF NEW.source_service_request_id IS NULL
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  request_status := CASE NEW.status
    WHEN 'scheduled' THEN 'scheduled'
    WHEN 'in_progress' THEN 'scheduled'
    WHEN 'completed' THEN 'completed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE NULL
  END;

  IF request_status IS NOT NULL THEN
    UPDATE customer_service_requests
       SET status = request_status
     WHERE id = NEW.source_service_request_id
       AND business_unit_id = NEW.business_unit_id
       AND status IS DISTINCT FROM request_status
       AND status NOT IN ('denied', 'completed', 'cancelled');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_orders_sync_service_request_status ON work_orders;
CREATE TRIGGER work_orders_sync_service_request_status
AFTER UPDATE OF status ON work_orders
FOR EACH ROW EXECUTE FUNCTION sync_job_service_request_status();
