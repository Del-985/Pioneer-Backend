import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { z } from 'zod';

export const employeeJobsQuerySchema = z.object({
  status: z.enum(['draft', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
  businessUnitId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type EmployeeJobsQuery = z.infer<typeof employeeJobsQuerySchema>;

type EmployeeRow = {
  id: string;
  business_unit_id: string;
  business_name: string;
  display_name: string;
  employee_number: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  hire_date: string | null;
  hourly_rate_cents: string | null;
  hourly_rate_effective_on: string | null;
  overtime_multiplier_bps: number | null;
};

type JobRow = {
  id: string;
  business_unit_id: string;
  business_name: string;
  work_order_number: string;
  title: string;
  description: string | null;
  status: 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  completed_at: Date | null;
  created_at: Date;
  customer_name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  report_status: string | null;
  route_id: string | null;
  route_name: string | null;
  route_position: number | null;
};

function mapEmployee(row: EmployeeRow) {
  return {
    id: row.id,
    businessUnitId: row.business_unit_id,
    businessName: row.business_name,
    displayName: row.display_name,
    employeeNumber: row.employee_number,
    email: row.email,
    phone: row.phone,
    jobTitle: row.job_title,
    hireDate: row.hire_date,
    payRate: row.hourly_rate_cents === null ? null : {
      hourlyCents: Number(row.hourly_rate_cents),
      effectiveOn: row.hourly_rate_effective_on,
      overtimeMultiplierBps: row.overtime_multiplier_bps,
    },
  };
}

function mapJob(row: JobRow) {
  return {
    id: row.id,
    businessUnitId: row.business_unit_id,
    businessName: row.business_name,
    workOrderNumber: row.work_order_number,
    title: row.title,
    description: row.description,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    customerName: row.customer_name,
    reportStatus: row.report_status,
    routeId: row.route_id,
    routeName: row.route_name,
    routePosition: row.route_position,
    serviceAddress: row.address_line1 ? {
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
    } : null,
  };
}

async function getActiveEmployment(userId: string) {
  const result = await pool.query<EmployeeRow>(
    `SELECT e.id, e.business_unit_id, b.name AS business_name,
       e.display_name, e.employee_number, e.email::text, e.phone, e.job_title,
       e.hire_date::text,
       current_rate.hourly_cents::text AS hourly_rate_cents,
       current_rate.effective_on::text AS hourly_rate_effective_on,
       current_rate.overtime_multiplier_bps
     FROM employees e
     JOIN business_units b ON b.id = e.business_unit_id
     LEFT JOIN LATERAL (
       SELECT hourly_cents, effective_on, overtime_multiplier_bps
       FROM payroll_hourly_rates r
       WHERE r.employee_id = e.id AND r.business_unit_id = e.business_unit_id
         AND r.effective_on <= (now() AT TIME ZONE 'America/Detroit')::date
       ORDER BY r.effective_on DESC LIMIT 1
     ) current_rate ON true
     WHERE e.user_id = $1 AND e.status = 'active' AND b.status = 'active'
     ORDER BY b.name, e.display_name`,
    [userId]
  );
  if (!result.rows.length) {
    throw new HttpError(403, 'EMPLOYEE_ACCESS_DENIED',
      'No active employee profile is linked to this account.');
  }
  return result.rows;
}

export async function employeeProfile(userId: string, user: {
  email: string;
  displayName: string;
}) {
  const employment = await getActiveEmployment(userId);
  return {
    user: { id: userId, email: user.email, displayName: user.displayName },
    employment: employment.map(mapEmployee),
  };
}

async function assertEmployeeBusinessScope(userId: string, businessUnitId?: string) {
  const employment = await getActiveEmployment(userId);
  if (businessUnitId && !employment.some((e) => e.business_unit_id === businessUnitId)) {
    throw new HttpError(403, 'EMPLOYEE_SCOPE_DENIED',
      'You cannot view another business unit\'s work orders.');
  }
}

const jobSelect = `SELECT wo.id, wo.business_unit_id, b.name AS business_name,
  wo.work_order_number, wo.title, wo.description, wo.status,
  wo.scheduled_start, wo.scheduled_end, wo.completed_at, wo.created_at,
  c.display_name AS customer_name,
  ca.address_line1, ca.address_line2, ca.city, ca.state, ca.postal_code,
  fr.status AS report_status,rt.id AS route_id,rt.name AS route_name,
  rj.position AS route_position
  FROM work_orders wo
  JOIN employees e ON e.user_id = $1 AND e.business_unit_id = wo.business_unit_id
    AND e.status = 'active'
  JOIN business_units b ON b.id = wo.business_unit_id
  JOIN customers c ON c.id = wo.customer_id AND c.business_unit_id = wo.business_unit_id
  LEFT JOIN customer_addresses ca ON ca.id = wo.service_address_id
    AND ca.business_unit_id = wo.business_unit_id
  LEFT JOIN field_route_jobs rj ON rj.work_order_id=wo.id
  LEFT JOIN field_routes rt ON rt.id=rj.route_id AND rt.status<>'cancelled'
  LEFT JOIN field_job_reports fr ON fr.work_order_id=wo.id AND fr.employee_id=e.id
  WHERE b.status = 'active'
    AND (wo.assigned_employee_id=e.id OR EXISTS (
      SELECT 1 FROM field_route_members rm
      WHERE rm.route_id=rt.id AND rm.employee_id=e.id
    ))`;

export async function employeeJobs(userId: string, query: EmployeeJobsQuery) {
  await assertEmployeeBusinessScope(userId, query.businessUnitId);
  const result = await pool.query<JobRow>(
    jobSelect + `
      AND ($2::uuid IS NULL OR wo.business_unit_id = $2::uuid)
      AND ($3::text IS NULL OR wo.status = $3)
      ORDER BY
        CASE WHEN wo.status IN ('scheduled', 'in_progress', 'draft') THEN 0 ELSE 1 END,
        COALESCE(wo.scheduled_start, wo.created_at) DESC,
        wo.id
      LIMIT $4 OFFSET $5`,
    [userId, query.businessUnitId ?? null, query.status ?? null, query.limit, query.offset]
  );
  return { data: result.rows.map(mapJob), meta: paginationMeta(query, result.rows.length) };
}

export async function employeeJob(userId: string, jobId: string) {
  await assertEmployeeBusinessScope(userId);
  const result = await pool.query<JobRow>(
    jobSelect + ' AND wo.id = $2',
    [userId, jobId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, 'EMPLOYEE_JOB_NOT_FOUND',
      'This work order is not assigned to your active employee account.');
  }
  return mapJob(row);
}
