import { Router } from 'express';
import { z } from 'zod';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createIntercompanySchema,
  intercompanyListQuerySchema,
  updateIntercompanySchema,
} from '../intercompany/admin-intercompany.schemas.js';
import {
  createIntercompany,
  listIntercompany,
  updateIntercompany,
} from '../intercompany/admin-intercompany.service.js';
import {
  archiveBookkeepingAttachment,
  completeBookkeepingAttachment,
  createBookkeepingAttachmentUploadIntent,
  getBookkeepingAttachment,
  getBookkeepingAttachmentDownload,
  listBookkeepingAttachments,
} from './attachment.service.js';
import { listBookkeepingAudit } from './bookkeeping-audit.service.js';
import {
  addReconciliationItemsSchema,
  attachmentBusinessUnitBodySchema,
  attachmentListQuerySchema,
  bookkeepingAuditQuerySchema,
  configuredIntercompanyPostSchema,
  createAttachmentUploadIntentSchema,
  createMileageSchema,
  createReconciliationSchema,
  createRecurringSchema,
  dashboardQuerySchema,
  intercompanyConfigQuerySchema,
  intercompanyReconcileSchema,
  mileageListQuerySchema,
  mileageSummaryQuerySchema,
  reconciliationBodySchema,
  reconciliationCandidatesQuerySchema,
  reconciliationListQuerySchema,
  recurringDueSchema,
  recurringGenerateSchema,
  recurringListQuerySchema,
  reportQuerySchema,
  reportTypeSchema,
  updateIntercompanyConfigSchema,
  updateMileageSchema,
  updateRecurringSchema,
} from './completion.schemas.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import {
  getIntercompanyAccountConfig,
  listIntercompanyEliminations,
  postConfiguredIntercompany,
  reconcileIntercompany,
  updateIntercompanyAccountConfig,
} from './intercompany-completion.service.js';
import {
  archiveBookkeepingMileage,
  createBookkeepingMileage,
  exportBookkeepingMileage,
  getBookkeepingMileageSummary,
  listBookkeepingMileage,
  updateBookkeepingMileage,
} from './mileage-bookkeeping.service.js';
import {
  addReconciliationItems,
  completeReconciliation,
  createReconciliation,
  getReconciliation,
  listReconciliationCandidates,
  listReconciliations,
  removeReconciliationItem,
  reopenReconciliation,
  voidReconciliation,
} from './reconciliation.service.js';
import { getBookkeepingDashboard, getBookkeepingReport } from './reporting-completion.service.js';
import {
  createRecurringBookkeeping,
  generateDueRecurringBookkeeping,
  generateRecurringBookkeeping,
  getRecurringBookkeeping,
  listRecurringBookkeeping,
  updateRecurringBookkeeping,
} from './recurring.service.js';

export const bookkeepingCompletionRouter=Router();
bookkeepingCompletionRouter.use(requireAuth);
const businessUnitQuery=z.object({businessUnitId:z.string().uuid()});

function csvEscape(value:unknown){
  if(value===null||value===undefined)return '';
  const text=typeof value==='object'?JSON.stringify(value):String(value);
  return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}
function toCsv(rows:Record<string,unknown>[]){
  if(rows.length===0)return '';
  const headers=Array.from(new Set(rows.flatMap(row=>Object.keys(row))));
  return [headers.join(','),...rows.map(row=>headers.map(header=>csvEscape(row[header])).join(','))].join('\n');
}
function sendCsv(res:Parameters<Router['get']>[1] extends never?never:any,name:string,rows:Record<string,unknown>[]){
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
  res.send(toCsv(rows));
}

bookkeepingCompletionRouter.get('/dashboard',async(req,res)=>{res.json({data:await getBookkeepingDashboard(req.auth!.userId,dashboardQuerySchema.parse(req.query))});});

bookkeepingCompletionRouter.get('/attachments',async(req,res)=>{res.json(await listBookkeepingAttachments(req.auth!.userId,attachmentListQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/attachments/upload-intent',async(req,res)=>{const data=await createBookkeepingAttachmentUploadIntent(req.auth!.userId,createAttachmentUploadIntentSchema.parse(req.body));res.status(201).json({data});});
bookkeepingCompletionRouter.get('/attachments/:attachmentId',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);res.json({data:await getBookkeepingAttachment(req.auth!.userId,businessUnitId,requireRouteParam(req,'attachmentId'))});});
bookkeepingCompletionRouter.post('/attachments/:attachmentId/complete',async(req,res)=>{const {businessUnitId}=attachmentBusinessUnitBodySchema.parse(req.body);res.json({data:await completeBookkeepingAttachment(req.auth!.userId,businessUnitId,requireRouteParam(req,'attachmentId'))});});
bookkeepingCompletionRouter.get('/attachments/:attachmentId/download',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);res.json({data:await getBookkeepingAttachmentDownload(req.auth!.userId,businessUnitId,requireRouteParam(req,'attachmentId'))});});
bookkeepingCompletionRouter.post('/attachments/:attachmentId/archive',async(req,res)=>{const {businessUnitId}=attachmentBusinessUnitBodySchema.parse(req.body);res.json({data:await archiveBookkeepingAttachment(req.auth!.userId,businessUnitId,requireRouteParam(req,'attachmentId'))});});

bookkeepingCompletionRouter.get('/mileage',async(req,res)=>{res.json(await listBookkeepingMileage(req.auth!.userId,mileageListQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/mileage',async(req,res)=>{res.status(201).json({data:await createBookkeepingMileage(req.auth!.userId,createMileageSchema.parse(req.body))});});
bookkeepingCompletionRouter.patch('/mileage/:mileageId',async(req,res)=>{res.json({data:await updateBookkeepingMileage(req.auth!.userId,requireRouteParam(req,'mileageId'),updateMileageSchema.parse(req.body))});});
bookkeepingCompletionRouter.post('/mileage/:mileageId/archive',async(req,res)=>{const {businessUnitId}=attachmentBusinessUnitBodySchema.parse(req.body);res.json({data:await archiveBookkeepingMileage(req.auth!.userId,businessUnitId,requireRouteParam(req,'mileageId'))});});
bookkeepingCompletionRouter.get('/mileage/summary',async(req,res)=>{res.json({data:await getBookkeepingMileageSummary(req.auth!.userId,mileageSummaryQuerySchema.parse(req.query))});});
bookkeepingCompletionRouter.get('/mileage/export.csv',async(req,res)=>{const rows=await exportBookkeepingMileage(req.auth!.userId,mileageSummaryQuerySchema.parse(req.query));sendCsv(res,'mileage.csv',rows as unknown as Record<string,unknown>[]);});

bookkeepingCompletionRouter.get('/reconciliations',async(req,res)=>{res.json(await listReconciliations(req.auth!.userId,reconciliationListQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/reconciliations',async(req,res)=>{res.status(201).json({data:await createReconciliation(req.auth!.userId,createReconciliationSchema.parse(req.body))});});
bookkeepingCompletionRouter.get('/reconciliations/:reconciliationId',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);res.json({data:await getReconciliation(req.auth!.userId,businessUnitId,requireRouteParam(req,'reconciliationId'))});});
bookkeepingCompletionRouter.get('/reconciliations/:reconciliationId/candidates',async(req,res)=>{res.json(await listReconciliationCandidates(req.auth!.userId,requireRouteParam(req,'reconciliationId'),reconciliationCandidatesQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/reconciliations/:reconciliationId/items',async(req,res)=>{const input=addReconciliationItemsSchema.parse(req.body);res.json({data:await addReconciliationItems(req.auth!.userId,input.businessUnitId,requireRouteParam(req,'reconciliationId'),input.journalLineIds)});});
bookkeepingCompletionRouter.delete('/reconciliations/:reconciliationId/items/:itemId',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);res.json({data:await removeReconciliationItem(req.auth!.userId,businessUnitId,requireRouteParam(req,'reconciliationId'),requireRouteParam(req,'itemId'))});});
bookkeepingCompletionRouter.post('/reconciliations/:reconciliationId/complete',async(req,res)=>{const input=reconciliationBodySchema.parse(req.body);const id=requireRouteParam(req,'reconciliationId');const result=await runIdempotent({userId:req.auth!.userId,operation:`reconciliation.complete:${id}`,key:normalizeIdempotencyKey(req.get('Idempotency-Key')),payload:input,execute:()=>completeReconciliation(req.auth!.userId,input.businessUnitId,id)});res.setHeader('Idempotency-Replayed',String(result.replayed));res.status(result.status).json({data:result.value});});
bookkeepingCompletionRouter.post('/reconciliations/:reconciliationId/reopen',async(req,res)=>{const {businessUnitId}=reconciliationBodySchema.parse(req.body);res.json({data:await reopenReconciliation(req.auth!.userId,businessUnitId,requireRouteParam(req,'reconciliationId'))});});
bookkeepingCompletionRouter.post('/reconciliations/:reconciliationId/void',async(req,res)=>{const {businessUnitId}=reconciliationBodySchema.parse(req.body);res.json({data:await voidReconciliation(req.auth!.userId,businessUnitId,requireRouteParam(req,'reconciliationId'))});});
bookkeepingCompletionRouter.get('/reconciliations/:reconciliationId/history',async(req,res)=>{const id=requireRouteParam(req,'reconciliationId');const parsed=bookkeepingAuditQuerySchema.parse({...req.query,resourceType:'reconciliation_session',resourceId:id});res.json(await listBookkeepingAudit(req.auth!.userId,parsed));});

bookkeepingCompletionRouter.get('/reports/export',async(req,res)=>{const query=reportQuerySchema.parse(req.query);const types=['trial-balance','profit-loss','balance-sheet','cash-flow','general-ledger'] as const;const reports=[] as Array<{type:string;value:unknown}>;for(const type of types)reports.push({type,value:await getBookkeepingReport(req.auth!.userId,type,{...query,format:'json'})});if(query.format==='csv'){const text=reports.map(section=>`# ${section.type}\n${toCsv((((section.value as {data?:unknown[]}).data??[]) as Record<string,unknown>[]))}`).join('\n\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="bookkeeping-export.csv"');res.send(text);return;}res.json({data:reports});});
bookkeepingCompletionRouter.get('/reports/:reportType',async(req,res)=>{const type=reportTypeSchema.parse(requireRouteParam(req,'reportType'));const query=reportQuerySchema.parse(req.query);const report=await getBookkeepingReport(req.auth!.userId,type,query);if(query.format==='csv'){sendCsv(res,`${type}.csv`,((((report as {data?:unknown[]}).data??[]) as Record<string,unknown>[])));return;}res.json({data:report});});

bookkeepingCompletionRouter.get('/intercompany/eliminations',async(req,res)=>{const q=z.object({from:z.string().date().optional(),to:z.string().date().optional()}).parse(req.query);res.json({data:await listIntercompanyEliminations(req.auth!.userId,q)});});
bookkeepingCompletionRouter.get('/intercompany/config',async(req,res)=>{const {businessUnitId}=intercompanyConfigQuerySchema.parse(req.query);res.json({data:await getIntercompanyAccountConfig(req.auth!.userId,businessUnitId)});});
bookkeepingCompletionRouter.put('/intercompany/config',async(req,res)=>{res.json({data:await updateIntercompanyAccountConfig(req.auth!.userId,updateIntercompanyConfigSchema.parse(req.body))});});
bookkeepingCompletionRouter.get('/intercompany',async(req,res)=>{res.json(await listIntercompany(req.auth!.userId,intercompanyListQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/intercompany',async(req,res)=>{res.status(201).json({data:await createIntercompany(req.auth!.userId,createIntercompanySchema.parse(req.body))});});
bookkeepingCompletionRouter.patch('/intercompany/:intercompanyId',async(req,res)=>{res.json({data:await updateIntercompany(req.auth!.userId,requireRouteParam(req,'intercompanyId'),updateIntercompanySchema.parse(req.body))});});
bookkeepingCompletionRouter.post('/intercompany/:intercompanyId/post',async(req,res)=>{const id=requireRouteParam(req,'intercompanyId');const input=configuredIntercompanyPostSchema.parse(req.body);const result=await runIdempotent({userId:req.auth!.userId,operation:`intercompany.post:${id}`,key:normalizeIdempotencyKey(req.get('Idempotency-Key')),payload:input,execute:()=>postConfiguredIntercompany(req.auth!.userId,id,input)});res.setHeader('Idempotency-Replayed',String(result.replayed));res.status(result.status).json({data:result.value});});
bookkeepingCompletionRouter.post('/intercompany/:intercompanyId/reconcile',async(req,res)=>{res.json({data:await reconcileIntercompany(req.auth!.userId,requireRouteParam(req,'intercompanyId'),intercompanyReconcileSchema.parse(req.body))});});

bookkeepingCompletionRouter.get('/recurring',async(req,res)=>{res.json(await listRecurringBookkeeping(req.auth!.userId,recurringListQuerySchema.parse(req.query)));});
bookkeepingCompletionRouter.post('/recurring/generate-due',async(req,res)=>{const input=recurringDueSchema.parse(req.body);const result=await runIdempotent({userId:req.auth!.userId,operation:`recurring.generate-due:${input.businessUnitId}:${input.throughDate??'today'}`,key:normalizeIdempotencyKey(req.get('Idempotency-Key')),payload:input,execute:()=>generateDueRecurringBookkeeping(req.auth!.userId,input)});res.setHeader('Idempotency-Replayed',String(result.replayed));res.json({data:result.value});});
bookkeepingCompletionRouter.post('/recurring',async(req,res)=>{res.status(201).json({data:await createRecurringBookkeeping(req.auth!.userId,createRecurringSchema.parse(req.body))});});
bookkeepingCompletionRouter.get('/recurring/:recurringId',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);res.json({data:await getRecurringBookkeeping(req.auth!.userId,businessUnitId,requireRouteParam(req,'recurringId'))});});
bookkeepingCompletionRouter.patch('/recurring/:recurringId',async(req,res)=>{res.json({data:await updateRecurringBookkeeping(req.auth!.userId,requireRouteParam(req,'recurringId'),updateRecurringSchema.parse(req.body))});});
bookkeepingCompletionRouter.delete('/recurring/:recurringId',async(req,res)=>{const {businessUnitId}=businessUnitQuery.parse(req.query);const data=await updateRecurringBookkeeping(req.auth!.userId,requireRouteParam(req,'recurringId'),{businessUnitId,enabled:false});res.json({data});});
bookkeepingCompletionRouter.post('/recurring/:recurringId/generate',async(req,res)=>{const id=requireRouteParam(req,'recurringId');const input=recurringGenerateSchema.parse(req.body);const result=await runIdempotent({userId:req.auth!.userId,operation:`recurring.generate:${id}`,key:normalizeIdempotencyKey(req.get('Idempotency-Key')),payload:input,execute:()=>generateRecurringBookkeeping(req.auth!.userId,id,input)});res.setHeader('Idempotency-Replayed',String(result.replayed));res.json({data:result.value});});
bookkeepingCompletionRouter.post('/recurring/:recurringId/post-now',async(req,res)=>{const id=requireRouteParam(req,'recurringId');const parsed=recurringGenerateSchema.parse(req.body);const input={...parsed,post:true};const result=await runIdempotent({userId:req.auth!.userId,operation:`recurring.post-now:${id}`,key:normalizeIdempotencyKey(req.get('Idempotency-Key')),payload:input,execute:()=>generateRecurringBookkeeping(req.auth!.userId,id,input)});res.setHeader('Idempotency-Replayed',String(result.replayed));res.json({data:result.value});});

bookkeepingCompletionRouter.get('/audit',async(req,res)=>{const query=bookkeepingAuditQuerySchema.parse(req.query);const result=await listBookkeepingAudit(req.auth!.userId,query);if(query.format==='csv'){sendCsv(res,'bookkeeping-audit.csv',result.data as unknown as Record<string,unknown>[]);return;}res.json(result);});
