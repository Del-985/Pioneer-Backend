import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createInvoiceSchema, invoiceListQuerySchema, updateInvoiceSchema } from './admin-invoice.schemas.js';

type ListQuery = z.infer<typeof invoiceListQuerySchema>;
type CreateInput = z.infer<typeof createInvoiceSchema>;
type UpdateInput = z.infer<typeof updateInvoiceSchema>;
type LineInput = CreateInput['lines'][number];

type InvoiceRow = {
  id: string; customer_id: string; customer_name?: string; work_order_id: string | null; invoice_number: string;
  status: 'draft'|'sent'|'partial'|'paid'|'overdue'|'void'; currency: string; subtotal_cents: string;
  tax_cents: string; total_cents: string; amount_paid_cents: string; issued_at: Date|null; due_at: Date|null;
  notes: string|null; created_at: Date; updated_at: Date;
};
type LineRow = { id:string; position:number; description:string; quantity:string; unit_price_cents:string; line_total_cents:string };

function calculateLines(lines: LineInput[]) {
  const calculated = lines.map((line, position) => {
    const lineTotalCents = Math.round(line.quantity * line.unitPriceCents);
    if (!Number.isSafeInteger(lineTotalCents)) throw new HttpError(400, 'AMOUNT_TOO_LARGE', 'An invoice line exceeds supported numeric precision.');
    return { ...line, position, lineTotalCents };
  });
  const subtotal = calculated.reduce((sum, line) => sum + line.lineTotalCents, 0);
  if (!Number.isSafeInteger(subtotal)) throw new HttpError(400, 'AMOUNT_TOO_LARGE', 'Invoice total exceeds supported numeric precision.');
  return { calculated, subtotal };
}

async function validateCustomer(client: PoolClient, businessUnitId: string, customerId: string) {
  const result = await client.query('SELECT 1 FROM customers WHERE id=$1 AND business_unit_id=$2', [customerId, businessUnitId]);
  if (!result.rows[0]) throw new HttpError(400, 'INVALID_CUSTOMER', 'Customer does not belong to this business unit.');
}
async function validateWorkOrder(client: PoolClient, businessUnitId: string, workOrderId: string | null | undefined) {
  if (!workOrderId) return;
  const result = await client.query('SELECT 1 FROM work_orders WHERE id=$1 AND business_unit_id=$2', [workOrderId, businessUnitId]);
  if (!result.rows[0]) throw new HttpError(400, 'INVALID_WORK_ORDER', 'Work order does not belong to this business unit.');
}
function mapSummary(row: InvoiceRow) {
  return { id:row.id,customerId:row.customer_id,customerName:row.customer_name??null,workOrderId:row.work_order_id,
    invoiceNumber:row.invoice_number,status:row.status,currency:row.currency,subtotalCents:Number(row.subtotal_cents),
    taxCents:Number(row.tax_cents),totalCents:Number(row.total_cents),amountPaidCents:Number(row.amount_paid_cents),
    issuedAt:row.issued_at,dueAt:row.due_at,notes:row.notes,createdAt:row.created_at,updatedAt:row.updated_at };
}
function mapLine(row: LineRow) { return { id:row.id,position:row.position,description:row.description,quantity:Number(row.quantity),unitPriceCents:Number(row.unit_price_cents),lineTotalCents:Number(row.line_total_cents) }; }

async function load(businessUnitId:string,invoiceId:string) {
  const result=await pool.query<InvoiceRow>(`SELECT i.*,c.display_name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1 AND i.business_unit_id=$2`,[invoiceId,businessUnitId]);
  const row=result.rows[0]; if(!row) throw new HttpError(404,'INVOICE_NOT_FOUND','Invoice not found.');
  const lines=await pool.query<LineRow>(`SELECT id,position,description,quantity::text,unit_price_cents::text,line_total_cents::text FROM invoice_lines WHERE invoice_id=$1 ORDER BY position,id`,[invoiceId]);
  return {...mapSummary(row),lines:lines.rows.map(mapLine)};
}

export async function listInvoices(userId:string,businessUnitId:string,query:ListQuery){
  await assertBusinessUnitPermission(userId,businessUnitId,'invoices.read');
  const result=await pool.query<InvoiceRow>(`SELECT i.*,c.display_name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.business_unit_id=$1 AND ($2::text IS NULL OR i.status=$2) AND ($3::uuid IS NULL OR i.customer_id=$3) AND ($4::text IS NULL OR i.invoice_number ILIKE '%'||$4||'%' OR c.display_name ILIKE '%'||$4||'%') ORDER BY i.created_at DESC LIMIT $5 OFFSET $6`,[businessUnitId,query.status??null,query.customerId??null,query.search||null,query.limit,query.offset]);
  return {data:result.rows.map(mapSummary),meta:paginationMeta(query,result.rows.length)};
}
export async function getInvoice(userId:string,businessUnitId:string,invoiceId:string){await assertBusinessUnitPermission(userId,businessUnitId,'invoices.read');return load(businessUnitId,invoiceId);}

export async function createInvoice(userId:string,businessUnitId:string,input:CreateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'invoices.write'); const {calculated,subtotal}=calculateLines(input.lines); const total=subtotal+input.taxCents;
  const client=await pool.connect(); try{await client.query('BEGIN');await validateCustomer(client,businessUnitId,input.customerId);await validateWorkOrder(client,businessUnitId,input.workOrderId);
    const result=await client.query<{id:string}>(`INSERT INTO invoices (business_unit_id,customer_id,work_order_id,invoice_number,currency,subtotal_cents,tax_cents,total_cents,issued_at,due_at,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[businessUnitId,input.customerId,input.workOrderId??null,input.invoiceNumber,input.currency,subtotal,input.taxCents,total,input.issuedAt??null,input.dueAt??null,input.notes??null]);
    const id=result.rows[0]?.id;if(!id)throw new HttpError(500,'INVOICE_CREATE_FAILED','Invoice could not be created.');for(const line of calculated){await client.query(`INSERT INTO invoice_lines (invoice_id,position,description,quantity,unit_price_cents,line_total_cents) VALUES ($1,$2,$3,$4,$5,$6)`,[id,line.position,line.description,line.quantity,line.unitPriceCents,line.lineTotalCents]);}
    await client.query('COMMIT');await writeAuditEvent({actorUserId:userId,businessUnitId,action:'invoice.created',resourceType:'invoice',resourceId:id,metadata:{invoiceNumber:input.invoiceNumber,totalCents:total}});return load(businessUnitId,id);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function updateInvoice(userId:string,businessUnitId:string,invoiceId:string,input:UpdateInput){
  await assertBusinessUnitPermission(userId,businessUnitId,'invoices.write');const current=await load(businessUnitId,invoiceId);if(current.status==='paid'&&input.lines)throw new HttpError(409,'PAID_INVOICE_LOCKED','Line items on a paid invoice cannot be changed.');
  const client=await pool.connect();try{await client.query('BEGIN');await validateWorkOrder(client,businessUnitId,input.workOrderId);let subtotal=current.subtotalCents;if(input.lines){const calc=calculateLines(input.lines);subtotal=calc.subtotal;await client.query('DELETE FROM invoice_lines WHERE invoice_id=$1',[invoiceId]);for(const line of calc.calculated){await client.query(`INSERT INTO invoice_lines (invoice_id,position,description,quantity,unit_price_cents,line_total_cents) VALUES ($1,$2,$3,$4,$5,$6)`,[invoiceId,line.position,line.description,line.quantity,line.unitPriceCents,line.lineTotalCents]);}}
    const tax=input.taxCents??current.taxCents;const total=subtotal+tax;if(current.amountPaidCents>total && (input.status??current.status)!=='void')throw new HttpError(409,'INVOICE_BELOW_PAYMENTS','Invoice total cannot be reduced below completed payments.');
    await client.query(`UPDATE invoices SET work_order_id=$3,status=$4,subtotal_cents=$5,tax_cents=$6,total_cents=$7,issued_at=$8,due_at=$9,notes=$10 WHERE id=$1 AND business_unit_id=$2`,[invoiceId,businessUnitId,input.workOrderId===undefined?current.workOrderId:input.workOrderId,input.status??current.status,subtotal,tax,total,input.issuedAt===undefined?current.issuedAt:input.issuedAt,input.dueAt===undefined?current.dueAt:input.dueAt,input.notes===undefined?current.notes:input.notes]);
    await client.query('COMMIT');await writeAuditEvent({actorUserId:userId,businessUnitId,action:'invoice.updated',resourceType:'invoice',resourceId:invoiceId,metadata:{status:input.status??current.status,totalCents:total}});return load(businessUnitId,invoiceId);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
