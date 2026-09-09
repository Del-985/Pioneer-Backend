import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { assertBookkeepingBusinessUnit } from './bookkeeping-authorization.service.js';
import {
  createRecurringSchema,
  recurringListQuerySchema,
  updateRecurringSchema,
} from './completion.schemas.js';
import { createTransactionSchema } from './transaction.schemas.js';
import {
  createBookkeepingTransaction,
  getBookkeepingTransaction,
  parseBookkeepingTransactionId,
  postBookkeepingTransaction,
} from './transaction.service.js';

type CreateInput=z.infer<typeof createRecurringSchema>;
type ListQuery=z.infer<typeof recurringListQuerySchema>;
type UpdateInput=z.infer<typeof updateRecurringSchema>;
type TxType='expense'|'income'|'transfer'|'manual';

type RecurringRow={
  id:string;legal_entity_id:string;business_unit_id:string;name:string;transaction_type:TxType;
  frequency:'weekly'|'monthly'|'quarterly'|'yearly';interval_count:number;start_date:string;end_date:string|null;
  next_run_date:string;template:Record<string,unknown>;enabled:boolean;created_by_user_id:string|null;created_at:Date;updated_at:Date;
};

function mapRecurring(r:RecurringRow){return{id:r.id,legalEntityId:r.legal_entity_id,businessUnitId:r.business_unit_id,name:r.name,transactionType:r.transaction_type,frequency:r.frequency,intervalCount:r.interval_count,startDate:r.start_date,endDate:r.end_date,nextRunDate:r.next_run_date,template:r.template,enabled:r.enabled,createdByUserId:r.created_by_user_id,createdAt:r.created_at,updatedAt:r.updated_at};}
const selectRecurring=`SELECT id,legal_entity_id,business_unit_id,name,transaction_type,frequency,interval_count,start_date::text,end_date::text,next_run_date::text,template,enabled,created_by_user_id,created_at,updated_at FROM recurring_bookkeeping_templates`;

export async function listRecurringBookkeeping(userId:string,q:ListQuery){
  await assertBookkeepingBusinessUnit(userId,q.businessUnitId,'bookkeeping.read');
  const result=await pool.query<RecurringRow>(`${selectRecurring} WHERE business_unit_id=$1 AND ($2::boolean IS NULL OR enabled=$2) AND ($3::text IS NULL OR transaction_type=$3) ORDER BY enabled DESC,next_run_date,name LIMIT $4 OFFSET $5`,[q.businessUnitId,q.enabled??null,q.transactionType??null,q.limit,q.offset]);
  return{data:result.rows.map(mapRecurring),meta:paginationMeta(q,result.rows.length)};
}

export async function getRecurringBookkeeping(userId:string,businessUnitId:string,id:string){
  await assertBookkeepingBusinessUnit(userId,businessUnitId,'bookkeeping.read');
  const result=await pool.query<RecurringRow>(`${selectRecurring} WHERE id=$1 AND business_unit_id=$2`,[id,businessUnitId]);
  const row=result.rows[0];if(!row)throw new HttpError(404,'RECURRING_NOT_FOUND','Recurring bookkeeping template not found.');
  const runs=await pool.query<{id:string;scheduled_date:string;transaction_type:TxType;transaction_id:string;transaction_key:string;generated_at:Date}>(`SELECT id,scheduled_date::text,transaction_type,transaction_id::text,transaction_key,generated_at FROM recurring_bookkeeping_runs WHERE recurring_id=$1 ORDER BY scheduled_date DESC LIMIT 25`,[id]);
  return{...mapRecurring(row),runs:runs.rows.map(r=>({id:r.id,scheduledDate:r.scheduled_date,transactionType:r.transaction_type,transactionId:r.transaction_id,transactionKey:r.transaction_key,generatedAt:r.generated_at}))};
}

export async function createRecurringBookkeeping(userId:string,input:CreateInput){
  const context=await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.write');
  if(input.endDate&&input.endDate<input.startDate)throw new HttpError(400,'INVALID_RECURRING_DATES','endDate must be on or after startDate.');
  if(input.nextRunDate<input.startDate)throw new HttpError(400,'INVALID_RECURRING_DATES','nextRunDate must be on or after startDate.');
  const result=await pool.query<RecurringRow>(
    `INSERT INTO recurring_bookkeeping_templates (legal_entity_id,business_unit_id,name,transaction_type,frequency,interval_count,start_date,end_date,next_run_date,template,enabled,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     RETURNING id,legal_entity_id,business_unit_id,name,transaction_type,frequency,interval_count,start_date::text,end_date::text,next_run_date::text,template,enabled,created_by_user_id,created_at,updated_at`,
    [context.legalEntityId,input.businessUnitId,input.name,input.transactionType,input.frequency,input.intervalCount,input.startDate,input.endDate??null,input.nextRunDate,JSON.stringify(input.template),input.enabled,userId]
  );
  const row=result.rows[0];if(!row)throw new HttpError(500,'RECURRING_CREATE_FAILED','Recurring bookkeeping template could not be created.');
  await writeAuditEvent({actorUserId:userId,legalEntityId:context.legalEntityId,businessUnitId:input.businessUnitId,action:'bookkeeping.recurring.created',resourceType:'recurring_bookkeeping_template',resourceId:row.id,metadata:{transactionType:input.transactionType,frequency:input.frequency,nextRunDate:input.nextRunDate}});
  return mapRecurring(row);
}

export async function updateRecurringBookkeeping(userId:string,id:string,input:UpdateInput){
  const context=await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.write');
  const currentResult=await pool.query<RecurringRow>(`${selectRecurring} WHERE id=$1 AND business_unit_id=$2`,[id,input.businessUnitId]);
  const current=currentResult.rows[0];if(!current)throw new HttpError(404,'RECURRING_NOT_FOUND','Recurring bookkeeping template not found.');
  const candidate={businessUnitId:current.business_unit_id,transactionType:current.transaction_type,name:input.name??current.name,frequency:input.frequency??current.frequency,intervalCount:input.intervalCount??current.interval_count,startDate:current.start_date,endDate:input.endDate===undefined?current.end_date:input.endDate,nextRunDate:input.nextRunDate??current.next_run_date,enabled:input.enabled??current.enabled,template:input.template??current.template};
  const validated=createRecurringSchema.parse(candidate);
  const result=await pool.query<RecurringRow>(
    `UPDATE recurring_bookkeeping_templates SET name=$3,frequency=$4,interval_count=$5,end_date=$6,next_run_date=$7,enabled=$8,template=$9::jsonb WHERE id=$1 AND business_unit_id=$2
     RETURNING id,legal_entity_id,business_unit_id,name,transaction_type,frequency,interval_count,start_date::text,end_date::text,next_run_date::text,template,enabled,created_by_user_id,created_at,updated_at`,
    [id,input.businessUnitId,validated.name,validated.frequency,validated.intervalCount,validated.endDate??null,validated.nextRunDate,validated.enabled,JSON.stringify(validated.template)]
  );
  const row=result.rows[0]!;
  await writeAuditEvent({actorUserId:userId,legalEntityId:context.legalEntityId,businessUnitId:input.businessUnitId,action:'bookkeeping.recurring.updated',resourceType:'recurring_bookkeeping_template',resourceId:id,metadata:{before:{name:current.name,nextRunDate:current.next_run_date,enabled:current.enabled},after:{name:row.name,nextRunDate:row.next_run_date,enabled:row.enabled}}});
  return mapRecurring(row);
}

function addDays(date:string,days:number){const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function addMonths(date:string,months:number){const original=new Date(`${date}T00:00:00Z`);const day=original.getUTCDate();const d=new Date(Date.UTC(original.getUTCFullYear(),original.getUTCMonth()+months,1));const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString().slice(0,10);}
function advanceDate(row:RecurringRow,date:string){if(row.frequency==='weekly')return addDays(date,7*row.interval_count);if(row.frequency==='monthly')return addMonths(date,row.interval_count);if(row.frequency==='quarterly')return addMonths(date,3*row.interval_count);return addMonths(date,12*row.interval_count);}
function entryNumber(row:RecurringRow,date:string){const prefix=typeof row.template.entryNumberPrefix==='string'?row.template.entryNumberPrefix:`REC-${row.id.slice(0,8)}`;return `${prefix}-${date.replaceAll('-','')}`.slice(0,80);}

function generatedTransactionInput(row:RecurringRow,date:string,post:boolean){
  const t=row.template;
  if(row.transaction_type==='expense')return createTransactionSchema.parse({type:'expense',businessUnitId:row.business_unit_id,transactionDate:date,description:t.description,amountCents:t.amountCents,vendor:t.vendor??null,expenseAccountId:t.expenseAccountId,paymentAccountId:t.paymentAccountId,receiptFileId:t.receiptFileId??null,entryNumber:entryNumber(row,date),post});
  if(row.transaction_type==='income')return createTransactionSchema.parse({type:'income',businessUnitId:row.business_unit_id,transactionDate:date,description:t.description,amountCents:t.amountCents,customerId:t.customerId??null,incomeAccountId:t.incomeAccountId,depositAccountId:t.depositAccountId,entryNumber:entryNumber(row,date),post});
  if(row.transaction_type==='transfer')return createTransactionSchema.parse({type:'transfer',businessUnitId:row.business_unit_id,transactionDate:date,description:t.description,amountCents:t.amountCents,fromAccountId:t.fromAccountId,toAccountId:t.toAccountId,entryNumber:entryNumber(row,date),post});
  return createTransactionSchema.parse({type:'manual',businessUnitId:row.business_unit_id,transactionDate:date,description:t.description,entryNumber:entryNumber(row,date),lines:t.lines,post});
}

async function loadForGeneration(userId:string,businessUnitId:string,id:string){
  await assertBookkeepingBusinessUnit(userId,businessUnitId,'bookkeeping.write');
  const result=await pool.query<RecurringRow>(`${selectRecurring} WHERE id=$1 AND business_unit_id=$2`,[id,businessUnitId]);const row=result.rows[0];if(!row)throw new HttpError(404,'RECURRING_NOT_FOUND','Recurring bookkeeping template not found.');if(!row.enabled)throw new HttpError(409,'RECURRING_DISABLED','Recurring bookkeeping template is disabled.');return row;
}

export async function generateRecurringBookkeeping(userId:string,id:string,input:{businessUnitId:string;scheduledDate?:string;post:boolean}){
  const row=await loadForGeneration(userId,input.businessUnitId,id);
  if(input.post)await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.post');
  const date=input.scheduledDate??row.next_run_date;
  if(date<row.start_date||(row.end_date&&date>row.end_date))throw new HttpError(409,'RECURRING_DATE_OUT_OF_RANGE','Generated date is outside the recurring template range.');

  await pool.query(`DELETE FROM recurring_bookkeeping_runs WHERE recurring_id=$1 AND scheduled_date=$2 AND transaction_key LIKE 'pending:%' AND generated_at < now()-interval '10 minutes'`,[id,date]);
  const reservationId=randomUUID();
  const reserved=await pool.query<{id:string}>(
    `INSERT INTO recurring_bookkeeping_runs (recurring_id,scheduled_date,transaction_type,transaction_id,transaction_key,generated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (recurring_id,scheduled_date) DO NOTHING RETURNING id`,
    [id,date,row.transaction_type,reservationId,`pending:${reservationId}`,userId]
  );
  if(!reserved.rows[0]){
    const existing=await pool.query<{transaction_key:string}>(`SELECT transaction_key FROM recurring_bookkeeping_runs WHERE recurring_id=$1 AND scheduled_date=$2`,[id,date]);
    const key=existing.rows[0]?.transaction_key;if(!key)throw new HttpError(409,'RECURRING_GENERATION_RACE','Recurring generation could not be resolved.');
    if(key.startsWith('pending:'))throw new HttpError(409,'RECURRING_GENERATION_IN_PROGRESS','This recurring occurrence is already being generated.');
    if(input.post){
      const tx=await getBookkeepingTransaction(userId,key);
      if(tx.status==='draft')await postBookkeepingTransaction(userId,key,{businessUnitId:input.businessUnitId,entryNumber:entryNumber(row,date)});
    }
    return{replayed:true,transaction:await getBookkeepingTransaction(userId,key),scheduledDate:date};
  }

  try{
    const transaction=await createBookkeepingTransaction(userId,generatedTransactionInput(row,date,input.post));
    const transactionKey=String(transaction.id);const parsed=parseBookkeepingTransactionId(transactionKey);
    await pool.query(`UPDATE recurring_bookkeeping_runs SET transaction_id=$3,transaction_key=$4 WHERE recurring_id=$1 AND scheduled_date=$2`,[id,date,parsed.sourceId,transactionKey]);
    if(date>=row.next_run_date){const next=advanceDate(row,date);const enabled=!(row.end_date&&next>row.end_date);await pool.query(`UPDATE recurring_bookkeeping_templates SET next_run_date=$2,enabled=$3 WHERE id=$1`,[id,next,enabled]);}
    await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId:row.business_unit_id,action:input.post?'bookkeeping.recurring.posted_now':'bookkeeping.recurring.generated',resourceType:'recurring_bookkeeping_template',resourceId:id,metadata:{scheduledDate:date,transactionId:transactionKey}});
    return{replayed:false,transaction,scheduledDate:date};
  }catch(error){await pool.query(`DELETE FROM recurring_bookkeeping_runs WHERE recurring_id=$1 AND scheduled_date=$2 AND transaction_key=$3`,[id,date,`pending:${reservationId}`]);throw error;}
}

export async function generateDueRecurringBookkeeping(userId:string,input:{businessUnitId:string;throughDate?:string;post:boolean}){
  await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.write');if(input.post)await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.post');
  const through=input.throughDate??new Date().toISOString().slice(0,10);
  const result=await pool.query<{id:string}>(`SELECT id FROM recurring_bookkeeping_templates WHERE business_unit_id=$1 AND enabled=true AND next_run_date<=$2 ORDER BY next_run_date,id LIMIT 100`,[input.businessUnitId,through]);
  const generated=[] as unknown[];
  for(const template of result.rows){generated.push(await generateRecurringBookkeeping(userId,template.id,{businessUnitId:input.businessUnitId,post:input.post}));}
  return{throughDate:through,count:generated.length,generated};
}
