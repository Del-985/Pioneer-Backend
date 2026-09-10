ALTER TABLE customer_service_requests
  ADD COLUMN schedule_entry_id uuid REFERENCES schedule_entries(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX customer_service_requests_schedule_entry_idx
  ON customer_service_requests(schedule_entry_id)
  WHERE schedule_entry_id IS NOT NULL;
