import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const status=z.enum(['draft','scheduled','in_progress','completed','cancelled']);
export const workOrderListQuerySchema=paginationQuerySchema.extend({status:status.optional(),customerId:z.string().uuid().optional(),search:z.string().trim().max(200).optional()});
export const createWorkOrderSchema=z.object({
 customerId:z.string().uuid(),estimateId:z.string().uuid().nullable().optional(),scheduleEntryId:z.string().uuid().nullable().optional(),serviceAddressId:z.string().uuid().nullable().optional(),assignedEmployeeId:z.string().uuid().nullable().optional(),
 workOrderNumber:z.string().trim().min(1).max(80),title:z.string().trim().min(1).max(200),description:z.string().trim().max(5000).nullable().optional(),status:status.default('draft'),scheduledStart:z.string().datetime().nullable().optional(),scheduledEnd:z.string().datetime().nullable().optional(),notes:z.string().trim().max(5000).nullable().optional()
}).refine(v=>!v.scheduledStart||!v.scheduledEnd||new Date(v.scheduledEnd)>=new Date(v.scheduledStart),{message:'scheduledEnd must not be before scheduledStart.',path:['scheduledEnd']});
export const updateWorkOrderSchema=z.object({
 estimateId:z.string().uuid().nullable().optional(),scheduleEntryId:z.string().uuid().nullable().optional(),serviceAddressId:z.string().uuid().nullable().optional(),assignedEmployeeId:z.string().uuid().nullable().optional(),title:z.string().trim().min(1).max(200).optional(),description:z.string().trim().max(5000).nullable().optional(),status:status.optional(),scheduledStart:z.string().datetime().nullable().optional(),scheduledEnd:z.string().datetime().nullable().optional(),completedAt:z.string().datetime().nullable().optional(),notes:z.string().trim().max(5000).nullable().optional()
}).refine(v=>Object.keys(v).length>0,{message:'At least one field is required.'});
