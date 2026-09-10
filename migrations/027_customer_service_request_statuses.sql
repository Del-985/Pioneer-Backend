ALTER TABLE customer_service_requests
  DROP CONSTRAINT IF EXISTS customer_service_requests_status_check;

ALTER TABLE customer_service_requests
  ADD CONSTRAINT customer_service_requests_status_check
  CHECK (status IN ('new', 'in_review', 'accepted', 'denied', 'scheduled', 'completed', 'cancelled'));
