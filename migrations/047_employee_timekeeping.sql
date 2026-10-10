-- Pioneer Employees v0.3.0: auditable shift time, breaks, and approvals.
-- Timestamps are UTC instants. Reporting weeks are Monday-Sunday in
-- America/Detroit, with each overnight entry attributed to its clock-in date.
CREATE TABLE employee_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_shift_id uuid REFERENCES employee_shifts(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  clock_in_at timestamptz NOT NULL,
  clock_out_at timestamptz,
  active_break_started_at timestamptz,
  active_break_paid boolean,
  paid_break_seconds integer NOT NULL DEFAULT 0 CHECK (paid_break_seconds >= 0),
  unpaid_break_seconds integer NOT NULL DEFAULT 0 CHECK (unpaid_break_seconds >= 0),
  review_status text NOT NULL DEFAULT 'open'
    CHECK (review_status IN ('open','submitted','approved','returned')),
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text CHECK (length(COALESCE(review_notes,'')) <= 2000),
  corrected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  correction_reason text CHECK (length(COALESCE(correction_reason,'')) <= 2000),
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_clock_ends_after_start CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at),
  CONSTRAINT time_clock_break_state CHECK (
    (active_break_started_at IS NULL AND active_break_paid IS NULL)
    OR (active_break_started_at IS NOT NULL AND active_break_paid IS NOT NULL
        AND active_break_started_at >= clock_in_at AND clock_out_at IS NULL)),
  CONSTRAINT time_clock_review_state CHECK (
    (clock_out_at IS NULL AND review_status='open')
    OR (clock_out_at IS NOT NULL AND review_status <> 'open')),
  CONSTRAINT time_clock_break_limit CHECK (
    clock_out_at IS NULL OR unpaid_break_seconds + paid_break_seconds <=
      EXTRACT(EPOCH FROM (clock_out_at-clock_in_at))::integer
  )
);
CREATE UNIQUE INDEX employee_time_one_open_per_employee_idx
  ON employee_time_entries(employee_id) WHERE clock_out_at IS NULL;
CREATE INDEX employee_time_unit_week_idx ON employee_time_entries
  (business_unit_id,clock_in_at DESC,review_status);
CREATE INDEX employee_time_employee_week_idx ON employee_time_entries
  (employee_id,clock_in_at DESC);
CREATE TRIGGER employee_time_entries_set_updated_at
BEFORE UPDATE ON employee_time_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Immutable before/after snapshots of all employee and manager time actions.
CREATE TABLE employee_time_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id uuid NOT NULL REFERENCES employee_time_entries(id) ON DELETE CASCADE,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'clock_in','break_start','break_end','clock_out',
    'manager_correct','manager_approve','manager_return')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX employee_time_events_entry_idx ON employee_time_events(time_entry_id,occurred_at);

INSERT INTO permissions(key,description) VALUES
 ('timekeeping.read','Review employee time and weekly time summaries'),
 ('timekeeping.write','Correct employee time entries with required reasons'),
 ('timekeeping.approve','Approve or return submitted employee time')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.key IN ('platform_admin','entity_admin','business_admin')
  AND p.key IN ('timekeeping.read','timekeeping.write','timekeeping.approve')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.key='business_viewer' AND p.key='timekeeping.read'
ON CONFLICT DO NOTHING;
