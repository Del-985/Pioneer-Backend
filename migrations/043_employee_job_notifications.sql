-- Generate workforce notifications when managers assign/reschedule/cancel jobs.
CREATE OR REPLACE FUNCTION enqueue_employee_work_order_notice()
RETURNS trigger AS $$
DECLARE employee_email text; employee_name text; template_name text;
BEGIN
  IF NEW.assigned_employee_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.assigned_employee_id IS NOT DISTINCT FROM OLD.assigned_employee_id
      AND NEW.scheduled_start IS NOT DISTINCT FROM OLD.scheduled_start
      AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  END IF;
  SELECT e.email::text,e.display_name INTO employee_email,employee_name
  FROM employees e WHERE e.id=NEW.assigned_employee_id
    AND e.business_unit_id=NEW.business_unit_id AND e.status='active';
  IF employee_email IS NULL OR trim(employee_email)='' THEN RETURN NEW; END IF;
  template_name := CASE WHEN NEW.status='cancelled' THEN 'employee_job_cancelled'
    ELSE 'employee_job_assigned' END;
  INSERT INTO notification_outbox(channel,recipient,business_unit_id,template_key,subject,payload)
  VALUES ('email',employee_email,NEW.business_unit_id,template_name,
    CASE WHEN NEW.status='cancelled' THEN 'Job cancelled: ' ELSE 'Job assignment: ' END || NEW.title,
    jsonb_build_object('employeeName',employee_name,'jobTitle',NEW.title,
      'workOrderNumber',NEW.work_order_number,'scheduledStart',NEW.scheduled_start,
      'portalUrl','https://employee.pioneeroutdoorservices.com/#/jobs/'||NEW.id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS employee_job_assignment_notification ON work_orders;
CREATE TRIGGER employee_job_assignment_notification
AFTER INSERT OR UPDATE OF assigned_employee_id,scheduled_start,status
ON work_orders FOR EACH ROW EXECUTE FUNCTION enqueue_employee_work_order_notice();
