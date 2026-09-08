import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createWorkOrderSchema, updateWorkOrderSchema, workOrderListQuerySchema } from './admin-work-order.schemas.js';

type ListQuery = z.infer<typeof workOrderListQuerySchema>;
type CreateInput = z.infer<typeof createWorkOrderSchema>;
type UpdateInput = z.infer<typeof updateWorkOrderSchema>;

type WorkOrderRow = {
  id: string;
  customer_id: string;
  customer_name?: string;
  estimate_id: string | null;
  schedule_entry_id: string | null;
  service_address_id: string | null;
  assigned_employee_id: string | null;
  work_order_number: string;
  title: string;
  description: string | null;
  status: 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  completed_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

function map(row: WorkOrderRow) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name ?? null,
    estimateId: row.estimate_id,
    scheduleEntryId: row.schedule_entry_id,
    serviceAddressId: row.service_address_id,
    assignedEmployeeId: row.assigned_employee_id,
    workOrderNumber: row.work_order_number,
    title: row.title,
    description: row.description,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    completedAt: row.completed_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function existsInUnit(table: string, id: string | null | undefined, businessUnitId: string, code: string, message: string) {
  if (!id) return;
  const allowed = new Set(['customers', 'estimates', 'schedule_entries', 'customer_addresses', 'employees']);
  if (!allowed.has(table)) throw new Error('Unsupported work-order relationship validation table.');
  const result = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND business_unit_id = $2`, [id, businessUnitId]);
  if (!result.rows[0]) throw new HttpError(400, code, message);
}

async function validateRelations(businessUnitId: string, input: {
  customerId?: string | undefined;
  estimateId?: string | null | undefined;
  scheduleEntryId?: string | null | undefined;
  serviceAddressId?: string | null | undefined;
  assignedEmployeeId?: string | null | undefined;
}) {
  if (input.customerId) await existsInUnit('customers', input.customerId, businessUnitId, 'INVALID_CUSTOMER', 'Customer does not belong to this business unit.');
  await existsInUnit('estimates', input.estimateId, businessUnitId, 'INVALID_ESTIMATE', 'Estimate does not belong to this business unit.');
  await existsInUnit('schedule_entries', input.scheduleEntryId, businessUnitId, 'INVALID_SCHEDULE_ENTRY', 'Schedule entry does not belong to this business unit.');
  await existsInUnit('customer_addresses', input.serviceAddressId, businessUnitId, 'INVALID_SERVICE_ADDRESS', 'Service address does not belong to this business unit.');
  await existsInUnit('employees', input.assignedEmployeeId, businessUnitId, 'INVALID_EMPLOYEE', 'Employee does not belong to this business unit.');
}

async function load(businessUnitId: string, workOrderId: string) {
  const result = await pool.query<WorkOrderRow>(
    `SELECT wo.*, c.display_name AS customer_name
     FROM work_orders wo JOIN customers c ON c.id = wo.customer_id
     WHERE wo.id = $1 AND wo.business_unit_id = $2`,
    [workOrderId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found.');
  return map(row);
}

export async function listWorkOrders(userId: string, businessUnitId: string, query: ListQuery) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'work_orders.read');
  const result = await pool.query<WorkOrderRow>(
    `SELECT wo.*, c.display_name AS customer_name
     FROM work_orders wo JOIN customers c ON c.id = wo.customer_id
     WHERE wo.business_unit_id = $1
       AND ($2::text IS NULL OR wo.status = $2)
       AND ($3::uuid IS NULL OR wo.customer_id = $3)
       AND ($4::text IS NULL OR wo.work_order_number ILIKE '%' || $4 || '%' OR wo.title ILIKE '%' || $4 || '%' OR c.display_name ILIKE '%' || $4 || '%')
     ORDER BY wo.created_at DESC LIMIT $5 OFFSET $6`,
    [businessUnitId, query.status ?? null, query.customerId ?? null, query.search || null, query.limit, query.offset]
  );
  return { data: result.rows.map(map), meta: paginationMeta(query, result.rows.length) };
}

export async function getWorkOrder(userId: string, businessUnitId: string, workOrderId: string) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'work_orders.read');
  return load(businessUnitId, workOrderId);
}

export async function createWorkOrder(userId: string, businessUnitId: string, input: CreateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'work_orders.write');
  await validateRelations(businessUnitId, input);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO work_orders (
       business_unit_id, customer_id, estimate_id, schedule_entry_id, service_address_id,
       assigned_employee_id, work_order_number, title, description, status, scheduled_start, scheduled_end, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [businessUnitId, input.customerId, input.estimateId ?? null, input.scheduleEntryId ?? null,
     input.serviceAddressId ?? null, input.assignedEmployeeId ?? null, input.workOrderNumber, input.title,
     input.description ?? null, input.status, input.scheduledStart ?? null, input.scheduledEnd ?? null, input.notes ?? null]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new HttpError(500, 'WORK_ORDER_CREATE_FAILED', 'Work order could not be created.');
  await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'work_order.created', resourceType: 'work_order', resourceId: id, metadata: { workOrderNumber: input.workOrderNumber } });
  return load(businessUnitId, id);
}

export async function updateWorkOrder(userId: string, businessUnitId: string, workOrderId: string, input: UpdateInput) {
  await assertBusinessUnitPermission(userId, businessUnitId, 'work_orders.write');
  await validateRelations(businessUnitId, input);
  const currentResult = await pool.query<WorkOrderRow>('SELECT * FROM work_orders WHERE id = $1 AND business_unit_id = $2', [workOrderId, businessUnitId]);
  const c = currentResult.rows[0];
  if (!c) throw new HttpError(404, 'WORK_ORDER_NOT_FOUND', 'Work order not found.');
  const scheduledStart = input.scheduledStart === undefined ? c.scheduled_start : input.scheduledStart ? new Date(input.scheduledStart) : null;
  const scheduledEnd = input.scheduledEnd === undefined ? c.scheduled_end : input.scheduledEnd ? new Date(input.scheduledEnd) : null;
  if (scheduledStart && scheduledEnd && scheduledEnd < scheduledStart) throw new HttpError(400, 'INVALID_WORK_ORDER_RANGE', 'scheduledEnd must not be before scheduledStart.');
  const completedAt = input.completedAt === undefined
    ? (input.status === 'completed' && !c.completed_at ? new Date() : c.completed_at)
    : input.completedAt ? new Date(input.completedAt) : null;

  await pool.query(
    `UPDATE work_orders SET estimate_id=$3,schedule_entry_id=$4,service_address_id=$5,assigned_employee_id=$6,
       title=$7,description=$8,status=$9,scheduled_start=$10,scheduled_end=$11,completed_at=$12,notes=$13
     WHERE id=$1 AND business_unit_id=$2`,
    [workOrderId, businessUnitId, input.estimateId === undefined ? c.estimate_id : input.estimateId,
     input.scheduleEntryId === undefined ? c.schedule_entry_id : input.scheduleEntryId,
     input.serviceAddressId === undefined ? c.service_address_id : input.serviceAddressId,
     input.assignedEmployeeId === undefined ? c.assigned_employee_id : input.assignedEmployeeId,
     input.title ?? c.title, input.description === undefined ? c.description : input.description, input.status ?? c.status,
     scheduledStart, scheduledEnd, completedAt, input.notes === undefined ? c.notes : input.notes]
  );
  await writeAuditEvent({ actorUserId: userId, businessUnitId, action: 'work_order.updated', resourceType: 'work_order', resourceId: workOrderId, metadata: { status: input.status ?? c.status } });
  return load(businessUnitId, workOrderId);
}
