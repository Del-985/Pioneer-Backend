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
  completed_at,
  source_service_request_id,
  notes
)
SELECT
  r.business_unit_id,
  r.customer_id,
  r.schedule_entry_id,
  r.property_id,
  format(
    'JOB-%s-%s',
    to_char(CURRENT_DATE, 'YYYY'),
    lpad(nextval('work_order_auto_number_seq')::text, 6, '0')
  ),
  r.subject,
  r.description,
  CASE
    WHEN r.status = 'completed' THEN 'completed'
    WHEN r.status = 'cancelled' THEN 'cancelled'
    WHEN r.status = 'scheduled' OR r.schedule_entry_id IS NOT NULL THEN 'scheduled'
    ELSE 'draft'
  END,
  COALESCE(s.starts_at, r.requested_at),
  s.ends_at,
  CASE WHEN r.status = 'completed' THEN r.updated_at ELSE NULL END,
  r.id,
  'Generated from an approved customer service request.'
FROM customer_service_requests r
LEFT JOIN schedule_entries s
  ON s.id = r.schedule_entry_id
 AND s.business_unit_id = r.business_unit_id
WHERE r.status IN ('accepted', 'scheduled', 'completed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1
    FROM work_orders wo
    WHERE wo.source_service_request_id = r.id
  );
