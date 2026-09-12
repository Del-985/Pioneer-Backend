ALTER TABLE notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_channel_check;

ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_channel_check
  CHECK (channel IN ('email', 'sms', 'webhook'));

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_service_scheduled_request_uidx
  ON notification_outbox ((payload ->> 'customerServiceRequestId'))
  WHERE template_key = 'service_scheduled'
    AND payload ? 'customerServiceRequestId';

CREATE OR REPLACE FUNCTION queue_customer_service_scheduled_notification()
RETURNS trigger AS $$
DECLARE
  customer_name text;
  customer_email text;
  customer_phone text;
  contact_method text;
  service_confirmations_enabled boolean;
  scheduled_start timestamptz;
  scheduled_end timestamptz;
  property_address text;
  target_channel text;
  target_recipient text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = 'scheduled' THEN

    SELECT
      c.display_name,
      c.email,
      c.phone,
      c.preferred_contact_method,
      c.notify_service_confirmations
    INTO
      customer_name,
      customer_email,
      customer_phone,
      contact_method,
      service_confirmations_enabled
    FROM customers c
    WHERE c.id = NEW.customer_id
      AND c.business_unit_id = NEW.business_unit_id
      AND c.status = 'active';

    IF COALESCE(service_confirmations_enabled, true) = false THEN
      RETURN NEW;
    END IF;

    SELECT wo.scheduled_start, wo.scheduled_end
      INTO scheduled_start, scheduled_end
      FROM work_orders wo
     WHERE wo.source_service_request_id = NEW.id
       AND wo.business_unit_id = NEW.business_unit_id
       AND wo.scheduled_start IS NOT NULL
     ORDER BY wo.updated_at DESC
     LIMIT 1;

    IF scheduled_start IS NULL AND NEW.schedule_entry_id IS NOT NULL THEN
      SELECT se.starts_at, se.ends_at
        INTO scheduled_start, scheduled_end
        FROM schedule_entries se
       WHERE se.id = NEW.schedule_entry_id
         AND se.business_unit_id = NEW.business_unit_id;
    END IF;

    scheduled_start := COALESCE(scheduled_start, NEW.requested_at);

    IF scheduled_start IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.property_id IS NOT NULL THEN
      SELECT concat_ws(
        ', ',
        NULLIF(a.address_line1, ''),
        NULLIF(a.address_line2, ''),
        NULLIF(a.city, ''),
        NULLIF(trim(concat_ws(' ', NULLIF(a.state, ''), NULLIF(a.postal_code, ''))), '')
      )
      INTO property_address
      FROM customer_addresses a
      WHERE a.id = NEW.property_id
        AND a.business_unit_id = NEW.business_unit_id
        AND a.customer_id = NEW.customer_id;
    END IF;

    customer_email := NULLIF(trim(COALESCE(customer_email, '')), '');
    customer_phone := NULLIF(trim(COALESCE(customer_phone, '')), '');

    IF contact_method = 'text' AND customer_phone IS NOT NULL THEN
      target_channel := 'sms';
      target_recipient := customer_phone;
    ELSIF customer_email IS NOT NULL THEN
      target_channel := 'email';
      target_recipient := customer_email;
    ELSIF customer_phone IS NOT NULL THEN
      target_channel := 'sms';
      target_recipient := customer_phone;
    ELSE
      RETURN NEW;
    END IF;

    INSERT INTO notification_outbox (
      channel,
      recipient,
      template_key,
      subject,
      payload,
      business_unit_id
    ) VALUES (
      target_channel,
      target_recipient,
      'service_scheduled',
      'Your Pioneer Outdoor Services service is scheduled',
      jsonb_build_object(
        'customerServiceRequestId', NEW.id,
        'customerName', COALESCE(customer_name, ''),
        'subject', NEW.subject,
        'serviceType', NEW.service_type,
        'startsAt', scheduled_start,
        'endsAt', scheduled_end,
        'propertyAddress', COALESCE(property_address, ''),
        'fallbackEmail', COALESCE(customer_email, ''),
        'portalUrl', 'https://customer.pioneeroutdoorservices.com/app/schedule',
        'timeZone', 'America/New_York'
      ),
      NEW.business_unit_id
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_service_requests_queue_scheduled_notification
  ON customer_service_requests;

CREATE TRIGGER customer_service_requests_queue_scheduled_notification
AFTER UPDATE OF status ON customer_service_requests
FOR EACH ROW
EXECUTE FUNCTION queue_customer_service_scheduled_notification();
