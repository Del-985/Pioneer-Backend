-- Tighten approved native calculation immutability. Even approval->void requires
-- a future explicit reversal workflow, never direct evidence mutation.
CREATE OR REPLACE FUNCTION payroll_native_calculation_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Native payroll calculations cannot be deleted';
 END IF;
 IF OLD.status IN ('approved','void') AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Approved and void native payroll snapshots are immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
