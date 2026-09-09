import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination.js';

const accountType=z.enum(['asset','liability','equity','revenue','expense']);
export const accountListQuerySchema=paginationQuerySchema.extend({accountType:accountType.optional(),includeInactive:z.enum(['true','false']).optional().transform(v=>v==='true'),search:z.string().trim().max(200).optional()});
export const createAccountSchema=z.object({parentAccountId:z.string().uuid().nullable().optional(),code:z.string().trim().min(1).max(80),name:z.string().trim().min(1).max(200),accountType,subtype:z.string().trim().max(120).nullable().optional()});
export const updateAccountSchema=z.object({parentAccountId:z.string().uuid().nullable().optional(),code:z.string().trim().min(1).max(80).optional(),name:z.string().trim().min(1).max(200).optional(),subtype:z.string().trim().max(120).nullable().optional(),status:z.enum(['active','inactive']).optional()}).refine(v=>Object.keys(v).length>0,{message:'At least one field is required.'});

const journalLineSchema=z.object({accountId:z.string().uuid(),debitCents:z.coerce.number().int().min(0).default(0),creditCents:z.coerce.number().int().min(0).default(0),memo:z.string().trim().max(1000).nullable().optional()}).refine(v=>(v.debitCents>0&&v.creditCents===0)||(v.creditCents>0&&v.debitCents===0),{message:'Each line must contain either a positive debit or a positive credit.'});
export const journalListQuerySchema=paginationQuerySchema.extend({status:z.enum(['draft','posted','reversed','void']).optional(),from:z.string().date().optional(),to:z.string().date().optional(),search:z.string().trim().max(200).optional()});
export const createJournalSchema=z.object({entryNumber:z.string().trim().min(1).max(80),entryDate:z.string().date(),description:z.string().trim().min(1).max(1000),sourceType:z.string().trim().max(80).nullable().optional(),sourceId:z.string().uuid().nullable().optional(),lines:z.array(journalLineSchema).min(2).max(500)});
export const updateJournalSchema=z.object({entryDate:z.string().date().optional(),description:z.string().trim().min(1).max(1000).optional(),lines:z.array(journalLineSchema).min(2).max(500).optional()}).refine(v=>Object.keys(v).length>0,{message:'At least one field is required.'});
export const reverseJournalSchema=z.object({entryNumber:z.string().trim().min(1).max(80),entryDate:z.string().date(),description:z.string().trim().min(1).max(1000).optional()});

export const accountingEventListQuerySchema=paginationQuerySchema.extend({status:z.enum(['pending','posted','failed','ignored']).optional(),eventType:z.string().trim().max(100).optional()});
export const postAccountingEventSchema=z.object({entryNumber:z.string().trim().min(1).max(80),entryDate:z.string().date(),debitAccountId:z.string().uuid(),creditAccountId:z.string().uuid(),description:z.string().trim().max(1000).optional()});
