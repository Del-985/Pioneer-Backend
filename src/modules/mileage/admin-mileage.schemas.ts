import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

export const mileageListQuerySchema=paginationQuerySchema.extend({vehicleId:z.string().uuid().optional(),employeeId:z.string().uuid().optional(),from:z.string().datetime().optional(),to:z.string().datetime().optional()});
export const createMileageLogSchema=z.object({vehicleId:z.string().uuid(),employeeId:z.string().uuid().nullable().optional(),startOdometer:z.coerce.number().min(0),endOdometer:z.coerce.number().min(0),purpose:z.string().trim().min(1).max(1000),startedAt:z.string().datetime(),endedAt:z.string().datetime().nullable().optional(),notes:z.string().trim().max(5000).nullable().optional()}).refine(v=>v.endOdometer>=v.startOdometer,{message:'endOdometer must be at least startOdometer.',path:['endOdometer']}).refine(v=>!v.endedAt||new Date(v.endedAt)>=new Date(v.startedAt),{message:'endedAt must not be before startedAt.',path:['endedAt']});
