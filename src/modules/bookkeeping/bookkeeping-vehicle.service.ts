import { pool } from '../../db/pool.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';

export async function listBookkeepingVehicles(userId: string, businessUnitId: string) {
  await assertBookkeepingBusinessUnit(userId, businessUnitId, 'bookkeeping.read');
  const result = await pool.query<{
    id: string;
    name: string;
    year: number | null;
    make: string | null;
    model: string | null;
    license_plate: string | null;
    current_odometer: string | null;
    status: string;
  }>(
    `SELECT id,name,year,make,model,license_plate,current_odometer::text,status
     FROM vehicles
     WHERE business_unit_id=$1 AND status IN ('active','maintenance')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,name,year DESC NULLS LAST`,
    [businessUnitId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    year: row.year,
    make: row.make,
    model: row.model,
    licensePlate: row.license_plate,
    currentOdometer: row.current_odometer === null ? null : Number(row.current_odometer),
    status: row.status,
  }));
}
