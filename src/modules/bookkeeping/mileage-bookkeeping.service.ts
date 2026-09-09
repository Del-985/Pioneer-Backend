import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import {
  createMileageSchema,
  mileageListQuerySchema,
  mileageSummaryQuerySchema,
  updateMileageSchema,
} from './completion.schemas.js';

type ListQuery = z.infer<typeof mileageListQuerySchema>;
type CreateInput = z.infer<typeof createMileageSchema>;
type UpdateInput = z.infer<typeof updateMileageSchema>;
type SummaryQuery = z.infer<typeof mileageSummaryQuerySchema>;

type MileageRow = {
  id: string;
  legal_entity_id: string;
  business_unit_id: string;
  vehicle_id: string;
  vehicle_name: string;
  employee_id: string | null;
  employee_name: string | null;
  start_odometer: string;
  end_odometer: string;
  miles: string;
  purpose: string;
  started_at: Date;
  ended_at: Date | null;
  notes: string | null;
  status: 'active' | 'archived';
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapMileage(row: MileageRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    startOdometer: Number(row.start_odometer),
    endOdometer: Number(row.end_odometer),
    miles: Number(row.miles),
    purpose: row.purpose,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    notes: row.notes,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const mileageSelect = `
  SELECT ml.id,ml.legal_entity_id,ml.business_unit_id,ml.vehicle_id,v.name AS vehicle_name,
         ml.employee_id,e.display_name AS employee_name,ml.start_odometer::text,ml.end_odometer::text,
         ml.miles::text,ml.purpose,ml.started_at,ml.ended_at,ml.notes,ml.status,
         ml.created_by_user_id,ml.created_at,ml.updated_at
  FROM mileage_logs ml
  JOIN vehicles v ON v.id=ml.vehicle_id
  LEFT JOIN employees e ON e.id=ml.employee_id`;

export async function listBookkeepingMileage(userId: string, query: ListQuery) {
  await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  const result = await pool.query<MileageRow>(
    `${mileageSelect}
     WHERE ml.business_unit_id=$1
       AND ($2::uuid IS NULL OR ml.vehicle_id=$2)
       AND ($3::text IS NULL OR ml.status=$3)
       AND ($4::date IS NULL OR ml.started_at::date >= $4)
       AND ($5::date IS NULL OR ml.started_at::date <= $5)
     ORDER BY ml.started_at DESC
     LIMIT $6 OFFSET $7`,
    [query.businessUnitId, query.vehicleId ?? null, query.status ?? null, query.from ?? null, query.to ?? null, query.limit, query.offset]
  );
  return { data: result.rows.map(mapMileage), meta: paginationMeta(query, result.rows.length) };
}

async function validateVehicleAndEmployee(businessUnitId: string, vehicleId: string, employeeId?: string | null) {
  const vehicle = await pool.query<{ current_odometer: string | null }>(
    `SELECT current_odometer::text FROM vehicles WHERE id=$1 AND business_unit_id=$2`,
    [vehicleId, businessUnitId]
  );
  if (!vehicle.rows[0]) throw new HttpError(400, 'INVALID_VEHICLE', 'Vehicle does not belong to the selected business unit.');
  if (employeeId) {
    const employee = await pool.query(`SELECT 1 FROM employees WHERE id=$1 AND business_unit_id=$2`, [employeeId, businessUnitId]);
    if (!employee.rows[0]) throw new HttpError(400, 'INVALID_EMPLOYEE', 'Employee does not belong to the selected business unit.');
  }
  return vehicle.rows[0].current_odometer === null ? null : Number(vehicle.rows[0].current_odometer);
}

export async function createBookkeepingMileage(userId: string, input: CreateInput) {
  const context = await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  const current = await validateVehicleAndEmployee(input.businessUnitId, input.vehicleId, input.employeeId);
  if (current !== null && input.startOdometer < current) {
    throw new HttpError(409, 'ODOMETER_ROLLBACK', 'Starting odometer cannot be less than the vehicle current odometer.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<MileageRow>(
      `INSERT INTO mileage_logs (
         legal_entity_id,business_unit_id,vehicle_id,employee_id,start_odometer,end_odometer,
         purpose,started_at,ended_at,notes,created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id,legal_entity_id,business_unit_id,vehicle_id,
         (SELECT name FROM vehicles WHERE id=vehicle_id) AS vehicle_name,
         employee_id,(SELECT display_name FROM employees WHERE id=employee_id) AS employee_name,
         start_odometer::text,end_odometer::text,miles::text,purpose,started_at,ended_at,notes,status,
         created_by_user_id,created_at,updated_at`,
      [context.legalEntityId,input.businessUnitId,input.vehicleId,input.employeeId ?? null,input.startOdometer,input.endOdometer,input.purpose,input.startedAt,input.endedAt ?? null,input.notes ?? null,userId]
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(500, 'MILEAGE_CREATE_FAILED', 'Mileage log could not be created.');
    await client.query(
      `UPDATE vehicles SET current_odometer=GREATEST(COALESCE(current_odometer,0),$2) WHERE id=$1`,
      [input.vehicleId, input.endOdometer]
    );
    await client.query('COMMIT');
    await writeAuditEvent({
      actorUserId: userId,
      legalEntityId: context.legalEntityId,
      businessUnitId: input.businessUnitId,
      action: 'bookkeeping.mileage.created',
      resourceType: 'mileage_log',
      resourceId: row.id,
      metadata: { vehicleId: input.vehicleId, miles: Number(row.miles) },
    });
    return mapMileage(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateBookkeepingMileage(userId: string, mileageId: string, input: UpdateInput) {
  const context = await assertBookkeepingBusinessUnit(userId, input.businessUnitId, 'bookkeeping.write');
  const currentResult = await pool.query<MileageRow>(
    `${mileageSelect} WHERE ml.id=$1 AND ml.business_unit_id=$2`,
    [mileageId, input.businessUnitId]
  );
  const current = currentResult.rows[0];
  if (!current) throw new HttpError(404, 'MILEAGE_NOT_FOUND', 'Mileage log not found.');
  if (current.status !== 'active') throw new HttpError(409, 'MILEAGE_ARCHIVED', 'Archived mileage logs cannot be edited.');

  const vehicleId = input.vehicleId ?? current.vehicle_id;
  const employeeId = input.employeeId === undefined ? current.employee_id : input.employeeId;
  await validateVehicleAndEmployee(input.businessUnitId, vehicleId, employeeId);
  const start = input.startOdometer ?? Number(current.start_odometer);
  const end = input.endOdometer ?? Number(current.end_odometer);
  if (end < start) throw new HttpError(400, 'INVALID_ODOMETER_RANGE', 'Ending odometer must be greater than or equal to starting odometer.');

  const result = await pool.query<MileageRow>(
    `UPDATE mileage_logs ml
     SET vehicle_id=$3,employee_id=$4,start_odometer=$5,end_odometer=$6,
         purpose=$7,started_at=$8,ended_at=$9,notes=$10
     WHERE ml.id=$1 AND ml.business_unit_id=$2 AND ml.status='active'
     RETURNING ml.id,ml.legal_entity_id,ml.business_unit_id,ml.vehicle_id,
       (SELECT name FROM vehicles WHERE id=ml.vehicle_id) AS vehicle_name,
       ml.employee_id,(SELECT display_name FROM employees WHERE id=ml.employee_id) AS employee_name,
       ml.start_odometer::text,ml.end_odometer::text,ml.miles::text,ml.purpose,ml.started_at,ml.ended_at,
       ml.notes,ml.status,ml.created_by_user_id,ml.created_at,ml.updated_at`,
    [mileageId,input.businessUnitId,vehicleId,employeeId,start,end,input.purpose ?? current.purpose,input.startedAt ?? current.started_at,input.endedAt === undefined ? current.ended_at : input.endedAt,input.notes === undefined ? current.notes : input.notes]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(409, 'MILEAGE_UPDATE_FAILED', 'Mileage log could not be updated.');
  await pool.query(`UPDATE vehicles SET current_odometer=GREATEST(COALESCE(current_odometer,0),$2) WHERE id=$1`, [vehicleId,end]);
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId: input.businessUnitId,
    action: 'bookkeeping.mileage.updated',
    resourceType: 'mileage_log',
    resourceId: mileageId,
    metadata: {
      before: { vehicleId: current.vehicle_id, startOdometer: Number(current.start_odometer), endOdometer: Number(current.end_odometer) },
      after: { vehicleId, startOdometer: start, endOdometer: end },
    },
  });
  return mapMileage(row);
}

export async function archiveBookkeepingMileage(userId: string, businessUnitId: string, mileageId: string) {
  const context = await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.write');
  const result = await pool.query<{ id: string }>(
    `UPDATE mileage_logs SET status='archived' WHERE id=$1 AND business_unit_id=$2 AND status='active' RETURNING id`,
    [mileageId, businessUnitId]
  );
  if (!result.rows[0]) throw new HttpError(404, 'MILEAGE_NOT_FOUND', 'Active mileage log not found.');
  await writeAuditEvent({
    actorUserId: userId,
    legalEntityId: context.legalEntityId,
    businessUnitId,
    action: 'bookkeeping.mileage.archived',
    resourceType: 'mileage_log',
    resourceId: mileageId,
  });
  return { id: mileageId, status: 'archived' as const };
}

export async function getBookkeepingMileageSummary(userId: string, query: SummaryQuery) {
  await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  const result = await pool.query<{
    vehicle_id: string;
    vehicle_name: string;
    trips: string;
    miles: string;
    first_trip: string | null;
    last_trip: string | null;
  }>(
    `SELECT ml.vehicle_id,v.name AS vehicle_name,count(*)::text AS trips,
            COALESCE(sum(ml.miles),0)::text AS miles,
            min(ml.started_at)::date::text AS first_trip,max(ml.started_at)::date::text AS last_trip
     FROM mileage_logs ml
     JOIN vehicles v ON v.id=ml.vehicle_id
     WHERE ml.business_unit_id=$1 AND ml.status='active'
       AND ($2::uuid IS NULL OR ml.vehicle_id=$2)
       AND ($3::date IS NULL OR ml.started_at::date >= $3)
       AND ($4::date IS NULL OR ml.started_at::date <= $4)
     GROUP BY ml.vehicle_id,v.name
     ORDER BY v.name`,
    [query.businessUnitId,query.vehicleId ?? null,query.from ?? null,query.to ?? null]
  );
  const vehicles = result.rows.map((row) => ({
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    trips: Number(row.trips),
    miles: Number(row.miles),
    firstTrip: row.first_trip,
    lastTrip: row.last_trip,
  }));
  return {
    businessUnitId: query.businessUnitId,
    from: query.from ?? null,
    to: query.to ?? null,
    trips: vehicles.reduce((sum, row) => sum + row.trips, 0),
    miles: vehicles.reduce((sum, row) => sum + row.miles, 0),
    vehicles,
  };
}

export async function exportBookkeepingMileage(userId: string, query: SummaryQuery) {
  await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  const result = await pool.query<MileageRow>(
    `${mileageSelect}
     WHERE ml.business_unit_id=$1 AND ml.status='active'
       AND ($2::uuid IS NULL OR ml.vehicle_id=$2)
       AND ($3::date IS NULL OR ml.started_at::date >= $3)
       AND ($4::date IS NULL OR ml.started_at::date <= $4)
     ORDER BY ml.started_at`,
    [query.businessUnitId,query.vehicleId ?? null,query.from ?? null,query.to ?? null]
  );
  return result.rows.map(mapMileage);
}
