-- Avoid emailing employees about their own progress updates, while keeping
-- manager-driven assignments, rescheduling and cancellations.
CREATE OR REPLACE FUNCTION enqueue_employee_work_order_notice()
RETURNS trigger AS $$
DECLARE employee_email text; employee_name text; template_name text;
BEGIN
  IF NEW.assigned_employee_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
      template_name:='employee_job_cancelled';
    ELSIF NEW.assigned_employee_id IS DISTINCT FROM OLD.assigned_employee_id
      OR NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start
      OR (NEW.status='scheduled' AND OLD.status IS DISTINCT FROM 'scheduled') THEN
      template_name:='employee_job_assigned';
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    template_name:='employee_job_assigned';
  END IF;

  SELECT e.email::text,e.display_name INTO employee_email,employee_name
  FROM employees e WHERE e.id=NEW.assigned_employee_id
    AND e.business_unit_id=NEW.business_unit_id AND e.status='active';
  IF employee_email IS NULL OR trim(employee_email)='' THEN RETURN NEW; END IF;
  INSERT INTO notification_outbox(channel,recipient,business_unit_id,template_key,subject,payload)
  VALUES ('email',employee_email,NEW.business_unit_id,template_name,
    CASE WHEN template_name='employee_job_cancelled' THEN 'Job cancelled: '
      ELSE 'Job assignment: ' END || NEW.title,
    jsonb_build_object('employeeName',employee_name,'jobTitle',NEW.title,
      'workOrderNumber',NEW.work_order_number,'scheduledStart',NEW.scheduled_start,
      'portalUrl','https://employee.pioneeroutdoorservices.com/#/jobs/'||NEW.id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
