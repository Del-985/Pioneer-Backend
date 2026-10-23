-- Employee planned-PTO requests and immutable usage history.
-- PTO is requested as a range with explicit paid hours; no scheduled/unscheduled
-- shifts are inferred, and approvals do NOT themselves generate payroll wages.
CREATE TABLE employee_pto_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  requested_hours numeric(10,2) NOT NULL CHECK (requested_hours>0 AND requested_hours<=160
    AND requested_hours*4=trunc(requested_hours*4)),
  employee_note text CHECK(length(coalesce(employee_note,''))<=1000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  manager_note text CHECK(length(coalesce(manager_note,''))<=1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(end_date>=start_date AND end_date<=start_date+30)
);
CREATE INDEX employee_pto_requests_employee_idx
 ON employee_pto_requests(business_unit_id,employee_id,created_at DESC);
CREATE INDEX employee_pto_requests_queue_idx
 ON employee_pto_requests(business_unit_id,status,start_date);
CREATE TRIGGER employee_pto_requests_updated_at BEFORE UPDATE ON employee_pto_requests
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Debit immediately on approval; restore only on management cancellation.
-- Restrict deletion of accepted requests to preserve payroll audit evidence.
CREATE TABLE employee_pto_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES employee_pto_requests(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('approved','restored')),
  hours_delta numeric(10,2) NOT NULL CHECK(
    (action='approved' AND hours_delta<0)
    OR (action='restored' AND hours_delta>0)
  ),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,action)
);
CREATE INDEX employee_pto_usage_balance_idx ON employee_pto_usage(business_unit_id,employee_id);
CREATE TRIGGER employee_pto_usage_immutable BEFORE UPDATE OR DELETE
 ON employee_pto_usage FOR EACH ROW EXECUTE FUNCTION forbid_leave_ledger_mutation();

CREATE TABLE employee_pto_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES employee_pto_requests(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN ('submitted','approved','denied','cancelled')),
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_pto_request_events_idx ON employee_pto_request_events(request_id,occurred_at);
CREATE TRIGGER employee_pto_events_immutable BEFORE UPDATE OR DELETE
 ON employee_pto_request_events FOR EACH ROW EXECUTE FUNCTION forbid_leave_ledger_mutation();
