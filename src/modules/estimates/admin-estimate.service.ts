import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createEstimateSchema, estimateListQuerySchema, updateEstimateSchema } from './admin-estimate.schemas.js';

type ListQuery=z.infer<typeof estimateListQuerySchema>;
type CreateInput=z.infer<typeof createEstimateSchema>;
type UpdateInput=z.infer<typeof updateEstimateSchema>;
type LineInput=CreateInput['lines'][number];

type EstimateRow={id:string;customer_id:string;customer_name?:string;estimate_number:string;status:string;currency:string;subtotal_cents:string;tax_cents:string;total_cents:string;valid_until:string|null;notes:string|null;created_at:Date;updated_at:Date};
type LineRow={id:string;position:number;description:string;quantity:string;unit_price_cents:string;line_total_cents:string};

function calculateLines(lines:LineInput[]){
  const calculated=lines.map((line,index)=>{
    const total=Math.round(line.quantity*line.unitPriceCents);
    if(!Number.isSafeInteger(total)) throw new HttpError(400,'AMOUNT_TOO_LARGE','An estimate line exceeds supported numeric precision.');
    return {...line,position:index,lineTotalCents:total};
  });
  const subtotal=calculated.reduce((sum,line)=>sum+line.lineTotalCents,0);
  if(!Number.isSafeInteger(subtotal)) throw new HttpError(400,'AMOUNT_TOO_LARGE','Estimate total exceeds supported numeric precision.');
  return {calculated,subtotal};
}

async function validateCustomer(client:PoolClient,businessUnitId:string,customerId:string){
  const result=await client.query('SELECT 1 FROM customers WHERE id=$1 AND business_unit_id=$2',[customerId,businessUnitId]);
  if(!result.rows[0]) throw new HttpError(400,'INVALID_CUSTOMER','Customer does not belong to this business unit.');
}

function mapSummary(row:EstimateRow){return {id:row.id,customerId:row.customer_id,customerName:row.customer_name??null,estimateNumber:row.estimate_number,status:row.status,currency:row.currency,subtotalCents:Number(row.subtotal_cents),taxCents:Number(row.tax_cents),totalCents:Number(row.total_cents),validUntil:row.valid_until,notes:row.notes,createdAt:row.created_at,updatedAt:row.updated_at};}
function mapLine(row:LineRow){return{id:row.id,position:row.position,description:row.description,quantity:Number(row.quantity),unitPriceCents:Number(row.unit_price_cents),lineTotalCents:Number(row.line_total_cents)};}

async function loadEstimate(businessUnitId:string,estimateId:string){
  const result=await pool.query<EstimateRow>(`SELECT e.*,c.display_name AS customer_name FROM estimates e JOIN customers c ON c.id=e.customer_id WHERE e.id=$1 AND e.business_unit_id=$2`,[estimateId,businessUnitId]);
  const row=result.rows[0]; if(!row) throw new HttpError(404,'ESTIMATE_NOT_FOUND','Estimate not found.');
  const lines=await pool.query<LineRow>(`SELECT id,position,description,quantity::text,unit_price_cents::text,line_total_cents::text FROM estimate_lines WHERE estimate_id=$1 ORDER BY position,id`,[estimateId]);
  return {...mapSummary(row),lines:lines.rows.map(mapLine)};
}

export async function listEstimates(userId:string,businessUnitId:string,query:ListQuery){
  await assertBusinessUnitPermission(userId,businessUnitId,'estimates.read');
  const result=await pool.query<EstimateRow>(
    `SELECT e.*,c.display_name AS customer_name FROM estimates e JOIN customers c ON c.id=e.customer_id
     WHERE e.business_unit_id=$1 AND ($2::text IS NULL OR e.status=$2) AND ($3::uuid IS NULL OR e.customer_id=$3)
       AND ($4::text IS NULL OR e.estimate_number ILIKE '%'||$4||'%' OR c.display_name ILIKE '%'||$4||'%')
     ORDER BY e.created_at DESC LIMIT $5 OFFSET $6`,
    [businessUnitId,query.status??null,query.customerId??null,query.search||null,query.limit,query.offset]);
  return {data:result.rows.map(mapSummary),meta:paginationMeta(query,result.rows.length)};
}

export async function getEstimate(userId:string,businessUnitId:string,estimateId:string){await assertBusinessUnitPermission(userId,businessUnitId,'estimates.read');return loadEstimate(businessUnitId,estimateId);}

export async function createEstimate(userId:string,businessUnitId:string,input:CreateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'estimates.write');
  const {calculated,subtotal}=calculateLines(input.lines); const total=subtotal+input.taxCents;
  const client=await pool.connect();
  try{await client.query('BEGIN');await validateCustomer(client,businessUnitId,input.customerId);
    const result=await client.query<{id:string}>(
      `INSERT INTO estimates (business_unit_id,customer_id,estimate_number,currency,subtotal_cents,tax_cents,total_cents,valid_until,notes,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [businessUnitId,input.customerId,input.estimateNumber,input.currency,subtotal,input.taxCents,total,input.validUntil??null,input.notes??null,userId]);
    const id=result.rows[0]?.id; if(!id) throw new HttpError(500,'ESTIMATE_CREATE_FAILED','Estimate could not be created.');
    for(const line of calculated){await client.query(`INSERT INTO estimate_lines (estimate_id,position,description,quantity,unit_price_cents,line_total_cents) VALUES ($1,$2,$3,$4,$5,$6)`,[id,line.position,line.description,line.quantity,line.unitPriceCents,line.lineTotalCents]);}
    await client.query('COMMIT'); await writeAuditEvent({actorUserId:userId,businessUnitId,action:'estimate.created',resourceType:'estimate',resourceId:id,metadata:{estimateNumber:input.estimateNumber,totalCents:total}}); return loadEstimate(businessUnitId,id);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function updateEstimate(userId:string,businessUnitId:string,estimateId:string,input:UpdateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'estimates.write');
  const current=await loadEstimate(businessUnitId,estimateId); const tax=input.taxCents??current.taxCents;
  const client=await pool.connect();
  try{await client.query('BEGIN'); let subtotal=current.subtotalCents;
    if(input.lines){const calc=calculateLines(input.lines);subtotal=calc.subtotal;await client.query('DELETE FROM estimate_lines WHERE estimate_id=$1',[estimateId]);for(const line of calc.calculated){await client.query(`INSERT INTO estimate_lines (estimate_id,position,description,quantity,unit_price_cents,line_total_cents) VALUES ($1,$2,$3,$4,$5,$6)`,[estimateId,line.position,line.description,line.quantity,line.unitPriceCents,line.lineTotalCents]);}}
    await client.query(`UPDATE estimates SET status=$3,tax_cents=$4,subtotal_cents=$5,total_cents=$6,valid_until=$7,notes=$8 WHERE id=$1 AND business_unit_id=$2`,[estimateId,businessUnitId,input.status??current.status,tax,subtotal,subtotal+tax,input.validUntil===undefined?current.validUntil:input.validUntil,input.notes===undefined?current.notes:input.notes]);
    await client.query('COMMIT');await writeAuditEvent({actorUserId:userId,businessUnitId,action:'estimate.updated',resourceType:'estimate',resourceId:estimateId,metadata:{status:input.status??current.status}});return loadEstimate(businessUnitId,estimateId);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
