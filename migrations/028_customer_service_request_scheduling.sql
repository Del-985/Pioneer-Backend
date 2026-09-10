ALTER TABLE customer_service_requests
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN availability_slot_id uuid REFERENCES customer_booking_slots(id) ON DELETE SET NULL;

CREATE INDEX customer_service_requests_requested_at_idx
  ON customer_service_requests(business_unit_id, customer_id, requested_at)
  WHERE requested_at IS NOT NULL;

CREATE INDEX customer_service_requests_availability_slot_idx
  ON customer_service_requests(availability_slot_id, status)
  WHERE availability_slot_id IS NOT NULL;
