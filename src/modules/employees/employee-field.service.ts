import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { z } from 'zod';
import { writeAuditEvent } from '../audit/admin-audit.service.js';

export const fieldActionSchema = z.object({
  action: z.enum(['acknowledge','start','issue','submit']),
  completionNotes: z.string().trim().max(5000).optional(),
  issueNotes: z.string().trim().max(2000).optional(),
  saltApplied: z.boolean().optional(),
  saltAmountLbs: z.number().finite().min(0).max(1000).nullable().optional(),
});
export const fieldReviewSchema = z.object({
  decision: z.enum(['approve','reject']),
  managerNotes: z.string().trim().max(2000).optional(),
});
type ReportRow = {
  id: string; business_unit_id: string; work_order_id: string; employee_id: string;
  status: string; acknowledged_at: Date | null; started_at: Date | null;
  submitted_at: Date | null; reviewed_at: Date | null;
  completion_notes: string | null; issue_notes: string | null;
  manager_notes: string | null; salt_applied: boolean; salt_amount_lbs: string | null;
};
type AllowedRow = { employee_id: string; business_unit_id: string; job_status: string };
export function presentReport(row: ReportRow) {
  return { id:row.id,businessUnitId:row.business_unit_id,workOrderId:row.work_order_id,
    employeeId:row.employee_id,status:row.status,acknowledgedAt:row.acknowledged_at,
    startedAt:row.started_at,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,
    completionNotes:row.completion_notes,issueNotes:row.issue_notes,managerNotes:row.manager_notes,
    saltApplied:row.salt_applied,saltAmountLbs:row.salt_amount_lbs === null ? null : Number(row.salt_amount_lbs) };
}
export async function resolveAssignedEmployee(userId: string, workOrderId: string): Promise<AllowedRow> {
  const result = await pool.query<AllowedRow>(`
    SELECT e.id AS employee_id,wo.business_unit_id,wo.status AS job_status
    FROM work_orders wo
    JOIN business_units bu ON bu.id=wo.business_unit_id AND bu.status='active'
    JOIN employees e ON e.user_id=$1 AND e.business_unit_id=wo.business_unit_id AND e.status='active'
    WHERE wo.id=$2 AND
      (wo.assigned_employee_id=e.id OR EXISTS (
        SELECT 1 FROM field_route_jobs rj
        JOIN field_routes r ON r.id=rj.route_id AND r.status<>'cancelled'
        JOIN field_route_members rm ON rm.route_id=r.id AND rm.employee_id=e.id
        WHERE rj.work_order_id=wo.id AND rj.business_unit_id=wo.business_unit_id
      ))`,
    [userId,workOrderId]
  );
  const row=result.rows[0];
  if(!row) throw new HttpError(404,'EMPLOYEE_JOB_NOT_FOUND','This job is not assigned to your active employee record.');
  return row;
}
export async function getMyReport(userId: string, workOrderId: string) {
  const employee=await resolveAssignedEmployee(userId,workOrderId);
  const result=await pool.query<ReportRow>(
    'SELECT * FROM field_job_reports WHERE work_order_id=$1 AND employee_id=$2',
    [workOrderId,employee.employee_id]
  );
  return {data:result.rows[0]?presentReport(result.rows[0]):null};
}
export async function updateMyJob(
  userId: string,workOrderId:string,input:z.infer<typeof fieldActionSchema>
) {
  const employee=await resolveAssignedEmployee(userId,workOrderId);
  if(['cancelled','completed'].includes(employee.job_status))
    throw new HttpError(409,'WORK_ORDER_CLOSED','The job is closed.');
  if(employee.job_status==='draft') throw new HttpError(409,'JOB_NOT_SCHEDULED','A manager must schedule this job first.');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const job=await client.query<{status:string;assigned_employee_id:string|null}>(
      'SELECT status,assigned_employee_id FROM work_orders WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',
      [workOrderId,employee.business_unit_id]
    );
    if(!job.rows[0]||['completed','cancelled','draft'].includes(job.rows[0].status))
      throw new HttpError(409,'WORK_ORDER_CLOSED','The work order is not available for field updates.');
    // Re-check crew membership under the transaction to avoid stale assignments.
    const entitled=await client.query<{allowed:boolean}>(`
      SELECT ($3::uuid=wo.assigned_employee_id OR EXISTS (
        SELECT 1 FROM field_route_jobs rj JOIN field_routes r ON r.id=rj.route_id
        JOIN field_route_members rm ON rm.route_id=rj.route_id
        WHERE rj.work_order_id=wo.id AND rm.employee_id=$3 AND r.status<>'cancelled'
      )) AS allowed FROM work_orders wo WHERE wo.id=$1 AND wo.business_unit_id=$2`,
      [workOrderId,employee.business_unit_id,employee.employee_id]
    );
    if(!entitled.rows[0]?.allowed) throw new HttpError(403,'ASSIGNMENT_CHANGED','You are no longer assigned to this job.');
    await client.query(
      `INSERT INTO field_job_reports (business_unit_id,work_order_id,employee_id)
       VALUES ($1,$2,$3) ON CONFLICT(work_order_id,employee_id) DO NOTHING`,
      [employee.business_unit_id,workOrderId,employee.employee_id]
    );
    const current=(await client.query<ReportRow>(
      'SELECT * FROM field_job_reports WHERE work_order_id=$1 AND employee_id=$2 FOR UPDATE',
      [workOrderId,employee.employee_id]
    )).rows[0]!;
    const valid:Record<string,string[]>={
      acknowledge:['assigned','rejected'],
      start:['assigned','acknowledged','issue','rejected'],
      issue:['assigned','acknowledged','in_progress','issue','rejected'],
      submit:['in_progress','issue','rejected'],
    };
    if(!valid[input.action]?.includes(current.status))
      throw new HttpError(409,'INVALID_FIELD_TRANSITION','This action is not permitted from the current report status.');
    if(input.action==='issue'&&!input.issueNotes)
      throw new HttpError(400,'ISSUE_NOTES_REQUIRED','Explain the issue before flagging the job.');
    const next:Record<string,string>={acknowledge:'acknowledged',start:'in_progress',issue:'issue',submit:'submitted'};
    const result=await client.query<ReportRow>(
      `UPDATE field_job_reports SET status=$3,
        acknowledged_at=CASE WHEN $4='acknowledge' THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
        started_at=CASE WHEN $4='start' THEN COALESCE(started_at,now()) ELSE started_at END,
        submitted_at=CASE WHEN $4='submit' THEN now() ELSE submitted_at END,
        reviewed_at=NULL, reviewed_by_user_id=NULL, manager_notes=NULL,
        completion_notes=COALESCE($5,completion_notes),
        issue_notes=CASE WHEN $4='issue' THEN $6 ELSE issue_notes END,
        salt_applied=COALESCE($7,salt_applied), salt_amount_lbs=COALESCE($8,salt_amount_lbs)
       WHERE work_order_id=$1 AND employee_id=$2 RETURNING *`,
      [workOrderId,employee.employee_id,next[input.action],input.action,
       input.completionNotes??null,input.issueNotes??null,input.saltApplied??null,input.saltAmountLbs??null]
    );
    if(input.action==='start'){
      await client.query(
        `UPDATE work_orders SET status='in_progress'
         WHERE id=$1 AND business_unit_id=$2 AND status='scheduled'`,
        [workOrderId,employee.business_unit_id]
      );
    }
    await client.query(
      `INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
       VALUES($1,$2,$3,'work_order',$4,$5::jsonb)`,
      [userId,employee.business_unit_id,'field_job.'+input.action,workOrderId,
       JSON.stringify({employeeId:employee.employee_id,reportId:current.id})]
    );
    await client.query('COMMIT');
    return {data:presentReport(result.rows[0]!)};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function listReports(userId:string,businessUnitId:string,status?:string) {
  const {assertBusinessUnitPermission}=await import('../access/authorization.service.js');
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.read');
  const result=await pool.query<ReportRow & {employee_name:string;work_order_number:string;title:string}>(`
    SELECT r.*,e.display_name AS employee_name,wo.work_order_number,wo.title
    FROM field_job_reports r
    JOIN employees e ON e.id=r.employee_id
    JOIN work_orders wo ON wo.id=r.work_order_id
    WHERE r.business_unit_id=$1 AND ($2::text IS NULL OR r.status=$2)
    ORDER BY r.submitted_at DESC NULLS LAST,r.updated_at DESC LIMIT 200`,
    [businessUnitId,status??null]
  );
  return {data:result.rows.map(r=>({...presentReport(r),employeeName:r.employee_name,workOrderNumber:r.work_order_number,jobTitle:r.title}))};
}
export async function reviewReport(
  userId:string,businessUnitId:string,reportId:string,input:z.infer<typeof fieldReviewSchema>
) {
  const {assertBusinessUnitPermission}=await import('../access/authorization.service.js');
  await assertBusinessUnitPermission(userId,businessUnitId,'work_orders.write');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const current=(await client.query<ReportRow>(
      'SELECT * FROM field_job_reports WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',
      [reportId,businessUnitId]
    )).rows[0];
    if(!current)throw new HttpError(404,'FIELD_REPORT_NOT_FOUND','Field report not found.');
    if(current.status!=='submitted')throw new HttpError(409,'REPORT_NOT_SUBMITTED','Only submitted reports can be reviewed.');
    if(input.decision==='reject'&&!input.managerNotes)
      throw new HttpError(400,'REVIEW_NOTES_REQUIRED','A rejection reason is required.');
    const result=await client.query<ReportRow>(
      `UPDATE field_job_reports SET status=$3,reviewed_at=now(),
         reviewed_by_user_id=$4,manager_notes=$5
       WHERE id=$1 AND business_unit_id=$2 RETURNING *`,
      [reportId,businessUnitId,input.decision==='approve'?'approved':'rejected',userId,input.managerNotes??null]
    );
    // Only close the job when all expected active crew members have approved reports.
    if(input.decision==='approve'){
      const q=await client.query<{all_approved:boolean}>(`
        WITH expected AS (
          SELECT assigned_employee_id AS employee_id
          FROM work_orders WHERE id=$1 AND business_unit_id=$2 AND assigned_employee_id IS NOT NULL
          UNION
          SELECT rm.employee_id FROM field_route_jobs rj
          JOIN field_routes rt ON rt.id=rj.route_id AND rt.status<>'cancelled'
          JOIN field_route_members rm ON rm.route_id=rt.id
          JOIN employees e ON e.id=rm.employee_id AND e.status='active'
          WHERE rj.work_order_id=$1 AND rj.business_unit_id=$2
        )
        SELECT NOT EXISTS (
          SELECT 1 FROM expected e LEFT JOIN field_job_reports f
          ON f.work_order_id=$1 AND f.employee_id=e.employee_id
          WHERE f.status IS DISTINCT FROM 'approved'
        ) AND EXISTS (SELECT 1 FROM expected) AS all_approved`,
        [current.work_order_id,businessUnitId]
      );
      if(q.rows[0]?.all_approved){
        await client.query(
          `UPDATE work_orders SET status='completed',completed_at=COALESCE(completed_at,now())
           WHERE id=$1 AND business_unit_id=$2 AND status NOT IN ('cancelled','completed')`,
          [current.work_order_id,businessUnitId]
        );
      }
    }
    await client.query(
      `INSERT INTO audit_log(actor_user_id,business_unit_id,action,resource_type,resource_id,metadata)
       VALUES($1,$2,$3,'field_job_report',$4,$5::jsonb)`,
      [userId,businessUnitId,'field_report.'+input.decision,reportId,
       JSON.stringify({workOrderId:current.work_order_id,employeeId:current.employee_id})]
    );
    await client.query('COMMIT');
    return {data:presentReport(result.rows[0]!)};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
