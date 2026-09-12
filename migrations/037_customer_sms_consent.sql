ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS sms_transactional_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_transactional_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_transactional_consent_source text;

CREATE OR REPLACE FUNCTION queue_customer_service_scheduled_notification()
RETURNS trigger AS $$
DECLARE
  customer_name text;
  customer_email text;
  customer_phone text;
  contact_method text;
  service_confirmations_enabled boolean;
  sms_consent boolean;
  scheduled_start timestamptz;
  scheduled_end timestamptz;
  property_address text;
  target_channel text;
  target_recipient text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('accepted', 'scheduled') THEN

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

    IF scheduled_start IS NULL AND NEW.status = 'scheduled' THEN
      scheduled_start := NEW.requested_at;
    END IF;

    IF scheduled_start IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT
      c.display_name,
      c.email,
      c.phone,
      c.preferred_contact_method,
      c.notify_service_confirmations,
      c.sms_transactional_consent
    INTO
      customer_name,
      customer_email,
      customer_phone,
      contact_method,
      service_confirmations_enabled,
      sms_consent
    FROM customers c
    WHERE c.id = NEW.customer_id
      AND c.business_unit_id = NEW.business_unit_id
      AND c.status = 'active';

    IF COALESCE(service_confirmations_enabled, true) = false THEN
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

    IF contact_method = 'text'
       AND COALESCE(sms_consent, false)
       AND customer_phone IS NOT NULL THEN
      target_channel := 'sms';
      target_recipient := customer_phone;
    ELSIF customer_email IS NOT NULL THEN
      target_channel := 'email';
      target_recipient := customer_email;
    ELSIF COALESCE(sms_consent, false) AND customer_phone IS NOT NULL THEN
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
