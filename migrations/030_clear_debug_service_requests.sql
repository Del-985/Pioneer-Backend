-- Clear service-request records used while validating the customer/admin request workflow.
-- Remove schedule entries created from those requests first so no debug appointments remain.
DELETE FROM schedule_entries
WHERE id IN (
  SELECT schedule_entry_id
  FROM customer_service_requests
  WHERE schedule_entry_id IS NOT NULL
);

DELETE FROM customer_service_requests;
