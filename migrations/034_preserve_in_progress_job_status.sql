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
             status = CASE
               WHEN status IN ('in_progress', 'completed', 'cancelled') THEN status
               ELSE job_status
             END
       WHERE id = existing_job_id;
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'scheduled' THEN
      UPDATE work_orders
         SET status = 'scheduled'
       WHERE source_service_request_id = NEW.id
         AND business_unit_id = NEW.business_unit_id
         AND status = 'draft';
    ELSIF NEW.status = 'completed' THEN
      UPDATE work_orders
         SET status = 'completed',
             completed_at = COALESCE(completed_at, now())
       WHERE source_service_request_id = NEW.id
         AND business_unit_id = NEW.business_unit_id
         AND status NOT IN ('completed', 'cancelled');
    ELSIF NEW.status = 'cancelled' THEN
      UPDATE work_orders
         SET status = 'cancelled'
       WHERE source_service_request_id = NEW.id
         AND business_unit_id = NEW.business_unit_id
         AND status NOT IN ('completed', 'cancelled');
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
