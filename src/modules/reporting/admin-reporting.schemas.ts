import { z } from 'zod';

export const reportRangeSchema=z.object({from:z.string().date().optional(),to:z.string().date().optional()});
export const trialBalanceQuerySchema=z.object({asOf:z.string().date().optional()});
export const consolidatedReportQuerySchema=reportRangeSchema.extend({legalEntityId:z.string().uuid().optional()});
