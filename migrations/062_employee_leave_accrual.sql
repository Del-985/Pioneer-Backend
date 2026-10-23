-- PTO + sick leave: each earns one hour for 30 actual worked hours.
-- Policy starts October 23, 2026 (Detroit local shift date); do not silently
-- create retroactive employee liabilities from older approved time entries.
-- No balance cap, expiration, usage, or payout rule is assumed here.
CREATE TABLE employee_leave_policy (
  singleton integer PRIMARY KEY DEFAULT 1 CHECK (singleton=1),
  effective_on date NOT NULL,
  hours_worked_per_leave_hour integer NOT NULL CHECK (hours_worked_per_leave_hour>0),
  planned_notice_days integer NOT NULL CHECK (planned_notice_days>=0)
);
INSERT INTO employee_leave_policy(singleton,effective_on,hours_worked_per_leave_hour,planned_notice_days)
VALUES(1,'2026-10-23',30,7);

-- Append-only, signed credit/reversal history. Source IDs intentionally remain
-- after a time entry is removed, so deletion cannot erase leave audit evidence.
CREATE TABLE employee_leave_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  time_entry_id uuid NOT NULL,
  leave_type text NOT NULL CHECK(leave_type IN ('pto','sick')),
  event_type text NOT NULL CHECK(event_type IN ('earned','reversed')),
  hours_delta numeric(16,6) NOT NULL CHECK(
    (event_type='earned' AND hours_delta>0)
    OR (event_type='reversed' AND hours_delta<0)
  ),
  worked_seconds bigint NOT NULL CHECK(worked_seconds>=0),
  hours_worked_per_leave_hour integer NOT NULL CHECK(hours_worked_per_leave_hour>0),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_leave_balance_idx
  ON employee_leave_ledger(business_unit_id,employee_id,leave_type);
CREATE INDEX employee_leave_source_idx
  ON employee_leave_ledger(time_entry_id,occurred_at,id);

CREATE FUNCTION forbid_leave_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Leave ledger entries are immutable; post compensating entries';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER employee_leave_ledger_immutable BEFORE UPDATE OR DELETE
  ON employee_leave_ledger FOR EACH ROW EXECUTE FUNCTION forbid_leave_ledger_mutation();

CREATE FUNCTION record_employee_leave_from_time() RETURNS trigger AS $$
DECLARE
  v_kind text;
  v_outstanding numeric(16,6);
  v_seconds bigint;
  v_earned numeric(16,6);
  v_rate integer;
  v_effective date;
  v_revoke boolean := false;
  v_credit boolean := false;
BEGIN
  SELECT effective_on,hours_worked_per_leave_hour
  INTO v_effective,v_rate FROM employee_leave_policy WHERE singleton=1;
  IF v_effective IS NULL THEN
    RAISE EXCEPTION 'Employee leave policy must be configured before time can be approved';
  END IF;

  IF TG_OP='DELETE' THEN
    v_revoke := true;
  ELSIF TG_OP='INSERT' THEN
    v_credit := NEW.review_status='approved';
  ELSE
    v_revoke := OLD.review_status='approved' AND (
      NEW.review_status IS DISTINCT FROM 'approved'
      OR (NEW.clock_in_at,NEW.clock_out_at,NEW.unpaid_break_seconds,
          NEW.employee_id,NEW.business_unit_id)
        IS DISTINCT FROM
         (OLD.clock_in_at,OLD.clock_out_at,OLD.unpaid_break_seconds,
          OLD.employee_id,OLD.business_unit_id)
    );
    v_credit := NEW.review_status='approved' AND (
      OLD.review_status IS DISTINCT FROM 'approved'
      OR (NEW.clock_in_at,NEW.clock_out_at,NEW.unpaid_break_seconds,
          NEW.employee_id,NEW.business_unit_id)
        IS DISTINCT FROM
         (OLD.clock_in_at,OLD.clock_out_at,OLD.unpaid_break_seconds,
          OLD.employee_id,OLD.business_unit_id)
    );
  END IF;

  IF v_revoke THEN
    -- Reverse only what was actually credited: older approved shifts have no
    -- ledger rows and must not receive artificial negative balances.
    FOR v_kind IN SELECT unnest(ARRAY['pto','sick']) LOOP
      SELECT coalesce(sum(hours_delta),0)::numeric(16,6)
      INTO v_outstanding
      FROM employee_leave_ledger
      WHERE time_entry_id=OLD.id AND leave_type=v_kind;
      IF v_outstanding > 0 THEN
        INSERT INTO employee_leave_ledger(
          business_unit_id,employee_id,time_entry_id,leave_type,event_type,
          hours_delta,worked_seconds,hours_worked_per_leave_hour)
        VALUES (OLD.business_unit_id,OLD.employee_id,OLD.id,v_kind,'reversed',
          -v_outstanding,0,v_rate);
      END IF;
    END LOOP;
  END IF;

  IF v_credit
    AND NEW.clock_out_at IS NOT NULL
    AND (NEW.clock_in_at AT TIME ZONE 'America/Detroit')::date >= v_effective
  THEN
    -- Match payroll: paid breaks count, unpaid breaks do not. Both ordinary
    -- and overtime worked seconds accrue; paid leave isn't clock time.
    v_seconds := GREATEST(0,round(EXTRACT(EPOCH FROM
      (NEW.clock_out_at-NEW.clock_in_at)))::bigint-NEW.unpaid_break_seconds);
    v_earned := round(v_seconds::numeric/(3600*v_rate)::numeric,6);
    IF v_earned>0 THEN
      FOR v_kind IN SELECT unnest(ARRAY['pto','sick']) LOOP
        INSERT INTO employee_leave_ledger(
          business_unit_id,employee_id,time_entry_id,leave_type,event_type,
          hours_delta,worked_seconds,hours_worked_per_leave_hour)
        VALUES (NEW.business_unit_id,NEW.employee_id,NEW.id,v_kind,'earned',
          v_earned,v_seconds,v_rate);
      END LOOP;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employee_leave_time_insert AFTER INSERT ON employee_time_entries
  FOR EACH ROW EXECUTE FUNCTION record_employee_leave_from_time();
CREATE TRIGGER employee_leave_time_update AFTER UPDATE ON employee_time_entries
  FOR EACH ROW EXECUTE FUNCTION record_employee_leave_from_time();
CREATE TRIGGER employee_leave_time_delete BEFORE DELETE ON employee_time_entries
  FOR EACH ROW EXECUTE FUNCTION record_employee_leave_from_time();
