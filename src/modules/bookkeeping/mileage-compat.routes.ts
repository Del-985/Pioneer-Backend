import { Router } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createMileageSchema, mileageListQuerySchema, mileageSummaryQuerySchema } from './completion.schemas.js';
import {
  createCanonicalBookkeepingMileage,
  createLegacyBookkeepingMileage,
  exportBookkeepingMileageCompat,
  listBookkeepingMileageCompat,
  updateCanonicalBookkeepingMileage,
  updateLegacyBookkeepingMileage,
} from './mileage-compat.service.js';

export const bookkeepingMileageCompatRouter = Router();
bookkeepingMileageCompatRouter.use(requireAuth);

const legacyMileageSchema = z.object({
  businessUnitId: z.string().uuid(),
  date: z.string().date(),
  vehicle: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  startOdometer: z.coerce.number().nonnegative(),
  endOdometer: z.coerce.number().nonnegative(),
}).strict().refine((value) => value.endOdometer > value.startOdometer, {
  message: 'Ending odometer must be greater than starting odometer.',
  path: ['endOdometer'],
});

const legacyMileagePatchSchema = z.object({
  businessUnitId: z.string().uuid(),
  date: z.string().date().optional(),
  vehicle: z.string().trim().min(1).max(200).optional(),
  purpose: z.string().trim().min(1).max(500).optional(),
  startOdometer: z.coerce.number().nonnegative().optional(),
  endOdometer: z.coerce.number().nonnegative().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'businessUnitId'), {
  message: 'At least one editable field is required.',
});

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendMileageCsv(res: any, rows: Array<Record<string, any>>) {
  const headers = ['date', 'vehicle', 'purpose', 'startOdometer', 'endOdometer', 'miles', 'businessUnitName'];
  const body = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mileage.csv"');
  res.send(body);
}

bookkeepingMileageCompatRouter.get('/mileage', async (req, res) => {
  const { scope: _scope, ...query } = req.query;
  const parsed = mileageListQuerySchema.parse(query);
  res.json(await listBookkeepingMileageCompat(req.auth!.userId, parsed as unknown as Record<string, unknown>));
});

bookkeepingMileageCompatRouter.post('/mileage', async (req, res) => {
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};

  const data = typeof raw.vehicleId === 'string'
    ? await createCanonicalBookkeepingMileage(req.auth!.userId, createMileageSchema.parse(raw))
    : await createLegacyBookkeepingMileage(req.auth!.userId, legacyMileageSchema.parse(raw));

  res.status(201).json({ data });
});

bookkeepingMileageCompatRouter.patch('/mileage/:mileageId', async (req, res) => {
  const mileageId = requireRouteParam(req, 'mileageId');
  const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const isLegacy = Object.prototype.hasOwnProperty.call(raw, 'date')
    || Object.prototype.hasOwnProperty.call(raw, 'vehicle');
  const data = isLegacy
    ? await updateLegacyBookkeepingMileage(req.auth!.userId, mileageId, legacyMileagePatchSchema.parse(raw))
    : await updateCanonicalBookkeepingMileage(req.auth!.userId, mileageId, raw);
  res.json({ data });
});

bookkeepingMileageCompatRouter.get('/mileage/export.csv', async (req, res) => {
  const { scope: _scope, ...query } = req.query;
  const parsed = mileageSummaryQuerySchema.parse(query);
  const rows = await exportBookkeepingMileageCompat(
    req.auth!.userId,
    parsed as unknown as Record<string, unknown>
  );
  sendMileageCsv(res, rows as Array<Record<string, any>>);
});
