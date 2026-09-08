import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { createPaymentSchema, paymentListQuerySchema, updatePaymentSchema } from './admin-payment.schemas.js';

type ListQuery=z.infer<typeof paymentListQuerySchema>;
type CreateInput=z.infer<typeof createPaymentSchema>;
type UpdateInput=z.infer<typeof updatePaymentSchema>;
type PaymentRow={id:string;invoice_id:string;amount_cents:string;currency:string;payment_method:string;status:'pending'|'completed'|'refunded'|'failed'|'void';reference:string|null;received_at:Date;notes:string|null;created_at:Date;updated_at:Date};
type InvoiceContext={id:string;legal_entity_id:string;currency:string;total_cents:string;status:string};

function map(row:PaymentRow){return{id:row.id,invoiceId:row.invoice_id,amountCents:Number(row.amount_cents),currency:row.currency,paymentMethod:row.payment_method,status:row.status,reference:row.reference,receivedAt:row.received_at,notes:row.notes,createdAt:row.created_at,updatedAt:row.updated_at};}

async function requireInvoice(client:PoolClient,businessUnitId:string,invoiceId:string):Promise<InvoiceContext>{
  const result=await client.query<InvoiceContext>(`SELECT i.id,bu.legal_entity_id,i.currency,i.total_cents::text,i.status FROM invoices i JOIN business_units bu ON bu.id=i.business_unit_id WHERE i.id=$1 AND i.business_unit_id=$2`,[invoiceId,businessUnitId]);
  const invoice=result.rows[0];if(!invoice)throw new HttpError(400,'INVALID_INVOICE','Invoice does not belong to this business unit.');if(invoice.status==='void')throw new HttpError(409,'VOID_INVOICE','Payments cannot be applied to a void invoice.');return invoice;
}

async function recalculateInvoice(client:PoolClient,invoiceId:string){
  const paidResult=await client.query<{paid:string}>(`SELECT COALESCE(sum(amount_cents) FILTER (WHERE status='completed'),0)::text AS paid FROM payments WHERE invoice_id=$1`,[invoiceId]);
  const paid=Number(paidResult.rows[0]?.paid??0);
  const invoiceResult=await client.query<{total_cents:string;status:string}>(`SELECT total_cents::text,status FROM invoices WHERE id=$1 FOR UPDATE`,[invoiceId]);
  const invoice=invoiceResult.rows[0];if(!invoice)return;
  const total=Number(invoice.total_cents);if(paid>total)throw new HttpError(409,'PAYMENT_EXCEEDS_INVOICE','Completed payments exceed the invoice total.');
  const nextStatus=invoice.status==='void'?'void':paid>=total&&total>0?'paid':paid>0?'partial':invoice.status==='paid'||invoice.status==='partial'?'sent':invoice.status;
  await client.query('UPDATE invoices SET amount_paid_cents=$2,status=$3 WHERE id=$1',[invoiceId,paid,nextStatus]);
}

async function syncAccountingEvent(client:PoolClient,businessUnitId:string,payment:PaymentRow,legalEntityId:string){
  if(payment.status==='completed'){
    await client.query(`INSERT INTO accounting_events (legal_entity_id,business_unit_id,event_type,source_type,source_id,amount_cents,metadata) VALUES ($1,$2,'payment.completed','payment',$3,$4,$5::jsonb) ON CONFLICT (source_type,source_id,event_type) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,status=CASE WHEN accounting_events.status='posted' THEN 'posted' ELSE 'pending' END,metadata=EXCLUDED.metadata`,[legalEntityId,businessUnitId,payment.id,payment.amount_cents,JSON.stringify({invoiceId:payment.invoice_id,paymentMethod:payment.payment_method})]);
  }else{
    await client.query(`UPDATE accounting_events SET status=CASE WHEN status='posted' THEN status ELSE 'ignored' END,updated_at=now() WHERE source_type='payment' AND source_id=$1 AND event_type='payment.completed'`,[payment.id]);
  }
}

export async function listPayments(userId:string,businessUnitId:string,query:ListQuery){await assertBusinessUnitPermission(userId,businessUnitId,'payments.read');const result=await pool.query<PaymentRow>(`SELECT id,invoice_id,amount_cents::text,currency,payment_method,status,reference,received_at,notes,created_at,updated_at FROM payments WHERE business_unit_id=$1 AND ($2::uuid IS NULL OR invoice_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::timestamptz IS NULL OR received_at >= $4) AND ($5::timestamptz IS NULL OR received_at <= $5) ORDER BY received_at DESC LIMIT $6 OFFSET $7`,[businessUnitId,query.invoiceId??null,query.status??null,query.from??null,query.to??null,query.limit,query.offset]);return{data:result.rows.map(map),meta:paginationMeta(query,result.rows.length)};}

export async function createPayment(userId:string,businessUnitId:string,input:CreateInput){await assertBusinessUnitPermission(userId,businessUnitId,'payments.write');const client=await pool.connect();try{await client.query('BEGIN');const invoice=await requireInvoice(client,businessUnitId,input.invoiceId);if(input.currency!==invoice.currency)throw new HttpError(400,'CURRENCY_MISMATCH','Payment currency must match the invoice currency.');const result=await client.query<PaymentRow>(`INSERT INTO payments (business_unit_id,invoice_id,amount_cents,currency,payment_method,status,reference,received_at,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()),$9) RETURNING id,invoice_id,amount_cents::text,currency,payment_method,status,reference,received_at,notes,created_at,updated_at`,[businessUnitId,input.invoiceId,input.amountCents,input.currency,input.paymentMethod,input.status,input.reference??null,input.receivedAt??null,input.notes??null]);const row=result.rows[0];if(!row)throw new HttpError(500,'PAYMENT_CREATE_FAILED','Payment could not be created.');await recalculateInvoice(client,input.invoiceId);await syncAccountingEvent(client,businessUnitId,row,invoice.legal_entity_id);await client.query('COMMIT');await writeAuditEvent({actorUserId:userId,businessUnitId,action:'payment.created',resourceType:'payment',resourceId:row.id,metadata:{invoiceId:row.invoice_id,amountCents:Number(row.amount_cents),status:row.status}});return map(row);}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}

export async function updatePayment(userId:string,businessUnitId:string,paymentId:string,input:UpdateInput){await assertBusinessUnitPermission(userId,businessUnitId,'payments.write');const client=await pool.connect();try{await client.query('BEGIN');const currentResult=await client.query<PaymentRow>(`SELECT id,invoice_id,amount_cents::text,currency,payment_method,status,reference,received_at,notes,created_at,updated_at FROM payments WHERE id=$1 AND business_unit_id=$2 FOR UPDATE`,[paymentId,businessUnitId]);const current=currentResult.rows[0];if(!current)throw new HttpError(404,'PAYMENT_NOT_FOUND','Payment not found.');const invoice=await requireInvoice(client,businessUnitId,current.invoice_id);const result=await client.query<PaymentRow>(`UPDATE payments SET status=$3,reference=$4,notes=$5 WHERE id=$1 AND business_unit_id=$2 RETURNING id,invoice_id,amount_cents::text,currency,payment_method,status,reference,received_at,notes,created_at,updated_at`,[paymentId,businessUnitId,input.status??current.status,input.reference===undefined?current.reference:input.reference,input.notes===undefined?current.notes:input.notes]);const row=result.rows[0]!;await recalculateInvoice(client,current.invoice_id);await syncAccountingEvent(client,businessUnitId,row,invoice.legal_entity_id);await client.query('COMMIT');await writeAuditEvent({actorUserId:userId,businessUnitId,action:'payment.updated',resourceType:'payment',resourceId:paymentId,metadata:{status:row.status}});return map(row);}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
