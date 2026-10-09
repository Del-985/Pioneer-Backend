-- Pioneer Employees v0.2 field dispatch / staff scheduling.
-- Every operational row is scoped to its business unit. All employee-facing
-- services also check the authenticated, active employee association.

CREATE TABLE employee_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  available boolean NOT NULL DEFAULT true,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, weekday, start_time, end_time),
  CHECK (start_time <> end_time),
  CHECK (length(COALESCE(notes,'')) <= 500)
);
CREATE INDEX employee_availability_unit_idx ON employee_availability(business_unit_id, employee_id);

CREATE TABLE employee_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX employee_shifts_business_unit_idx ON employee_shifts(business_unit_id, starts_at DESC);

CREATE TABLE employee_shift_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES employee_shifts(id) ON DELETE CASCADE,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','cancelled')),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shift_id, employee_id)
);
CREATE INDEX employee_shift_offers_employee_idx ON employee_shift_offers(employee_id, status);

CREATE TABLE field_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  starts_at timestamptz,
  notes text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_routes_business_idx ON field_routes(business_unit_id,starts_at);

CREATE TABLE field_route_members (
  route_id uuid NOT NULL REFERENCES field_routes(id) ON DELETE CASCADE,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(route_id,employee_id)
);
CREATE INDEX field_route_members_employee_idx ON field_route_members(employee_id,route_id);

CREATE TABLE field_route_jobs (
  route_id uuid NOT NULL REFERENCES field_routes(id) ON DELETE CASCADE,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 10000),
  PRIMARY KEY(route_id,work_order_id),
  UNIQUE(work_order_id)
);
CREATE INDEX field_route_jobs_position_idx ON field_route_jobs(route_id,position);

CREATE TABLE field_job_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','acknowledged','in_progress','issue','submitted','approved','rejected')),
  acknowledged_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  completion_notes text,
  issue_notes text,
  manager_notes text,
  salt_applied boolean NOT NULL DEFAULT false,
  salt_amount_lbs numeric(9,2) CHECK(salt_amount_lbs IS NULL OR salt_amount_lbs >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(work_order_id,employee_id),
  CHECK(length(COALESCE(completion_notes,''))<=5000),
  CHECK(length(COALESCE(issue_notes,''))<=2000),
  CHECK(length(COALESCE(manager_notes,''))<=2000)
);
CREATE INDEX field_job_reports_queue_idx ON field_job_reports(business_unit_id,status,submitted_at DESC);

CREATE TABLE field_job_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES field_job_reports(id) ON DELETE CASCADE,
  business_unit_id uuid NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('before','after','issue')),
  storage_key text NOT NULL UNIQUE,
  file_name text NOT NULL,
  content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_job_photos_report_idx ON field_job_photos(report_id);

-- Keep this role least-privileged; employee routes do not grant admin permissions.
