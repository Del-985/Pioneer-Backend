import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const status=z.enum(['draft','posted','settled','void']);
export const intercompanyListQuerySchema=paginationQuerySchema.extend({status:status.optional(),legalEntityId:z.string().uuid().optional(),from:z.string().date().optional(),to:z.string().date().optional()});
export const createIntercompanySchema=z.object({fromBusinessUnitId:z.string().uuid(),toBusinessUnitId:z.string().uuid(),transactionDate:z.string().date(),amountCents:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),description:z.string().trim().min(1).max(1000)}).refine(v=>v.fromBusinessUnitId!==v.toBusinessUnitId,{message:'Intercompany business units must differ.'});
export const updateIntercompanySchema=z.object({transactionDate:z.string().date().optional(),amountCents:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),description:z.string().trim().min(1).max(1000).optional(),status:z.enum(['draft','void']).optional()}).refine(v=>Object.keys(v).length>0,{message:'At least one field is required.'});
export const postIntercompanySchema=z.object({fromEntryNumber:z.string().trim().min(1).max(80),toEntryNumber:z.string().trim().min(1).max(80),fromDebitAccountId:z.string().uuid(),fromCreditAccountId:z.string().uuid(),toDebitAccountId:z.string().uuid(),toCreditAccountId:z.string().uuid()});
