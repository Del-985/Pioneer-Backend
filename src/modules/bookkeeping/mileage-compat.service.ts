import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { currentAccountingDate } from './accounting-date.js';
import {
  createBookkeepingMileage,
  exportBookkeepingMileage,
  listBookkeepingMileage,
} from './mileage-bookkeeping.service.js';
import {
  createMileageSchema,
  mileageListQuerySchema,
  mileageSummaryQuerySchema,
} from './completion.schemas.js';

type LegacyMileageInput = {
  businessUnitId: string;
  date: string;
  vehicle: string;
  purpose: string;
  startOdometer: number;
  endOdometer: number;
};

type AnyRecord = Record<string, any>;

async function businessUnitName(businessUnitId: string) {
  const result = await pool.query<{ name: string }>('SELECT name FROM business_units WHERE id=$1', [businessUnitId]);
  return result.rows[0]?.name ?? null;
}

async function resolveOrCreateVehicle(input: LegacyMileageInput) {
  const name = input.vehicle.trim();
  const existing = await pool.query<{ id: string }>(
    `SELECT id
     FROM vehicles
     WHERE business_unit_id=$1
       AND lower(name)=lower($2)
       AND status IN ('active','maintenance')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at
     LIMIT 2`,
    [input.businessUnitId, name]
  );

  if (existing.rows.length > 1) {
    throw new HttpError(
      409,
      'AMBIGUOUS_VEHICLE_NAME',
      'More than one active vehicle has this name. Select or rename the vehicle in the admin portal.'
    );
  }
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await pool.query<{ id: string }>(
    `INSERT INTO vehicles (business_unit_id,name,current_odometer,notes)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [input.businessUnitId, name, input.startOdometer, 'Created automatically from a bookkeeping mileage entry.']
  );
  const id = created.rows[0]?.id;
  if (!id) throw new HttpError(500, 'VEHICLE_CREATE_FAILED', 'Vehicle could not be created for the mileage entry.');
  return id;
}

export async function createLegacyBookkeepingMileage(userId: string, input: LegacyMileageInput) {
  const vehicleId = await resolveOrCreateVehicle(input);
  const canonical = createMileageSchema.parse({
    businessUnitId: input.businessUnitId,
    vehicleId,
    startOdometer: input.startOdometer,
    endOdometer: input.endOdometer,
    purpose: input.purpose,
    startedAt: `${input.date}T12:00:00Z`,
    endedAt: null,
    notes: null,
  });
  return presentMileage(await createBookkeepingMileage(userId, canonical));
}

export async function createCanonicalBookkeepingMileage(userId: string, rawInput: unknown) {
  const input = createMileageSchema.parse(rawInput);
  return presentMileage(await createBookkeepingMileage(userId, input));
}

export async function listBookkeepingMileageCompat(userId: string, rawQuery: Record<string, unknown>) {
  const query = mileageListQuerySchema.parse(rawQuery);
  const result = await listBookkeepingMileage(userId, query);
  const name = await businessUnitName(query.businessUnitId);
  return {
    ...result,
    data: result.data.map((row) => presentMileage(row, name)),
  };
}

export async function exportBookkeepingMileageCompat(userId: string, rawQuery: Record<string, unknown>) {
  const query = mileageSummaryQuerySchema.parse(rawQuery);
  const rows = await exportBookkeepingMileage(userId, query);
  const name = await businessUnitName(query.businessUnitId);
  return rows.map((row) => presentMileage(row, name));
}

export function presentMileage(value: unknown, knownBusinessUnitName?: string | null) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
  const startedAt = row.startedAt ? new Date(row.startedAt) : null;
  const date = startedAt && !Number.isNaN(startedAt.getTime())
    ? currentAccountingDate(startedAt)
    : String(row.date ?? '');
  return {
    ...row,
    date,
    vehicle: row.vehicle ?? row.vehicleName ?? '',
    businessUnitName: row.businessUnitName ?? knownBusinessUnitName ?? undefined,
  };
}
