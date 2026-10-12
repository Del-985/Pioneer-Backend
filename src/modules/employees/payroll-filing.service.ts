import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {pool} from '../../db/pool.js';
import {HttpError} from '../../lib/http-error.js';
import {assertLegalEntityPermission} from '../access/authorization.service.js';
import {filingFigures,quarterDates,type FilingPayment} from './payroll-filing-math.js';
const ascii=(max:number)=>z.string().trim().min(1).max(max).regex(/^[\x20-\x7e]+$/,'Use standard printable characters for the IRS form');
export const filingInputSchema=z.object({year:z.literal(2026),quarter:z.union([z.literal(3),z.literal(4)]),
 ein:z.string().regex(/^\d{2}-?\d{7}$/).transform(x=>x.replace('-','')).refine(x=>!/^0+$/.test(x),'Enter an assigned EIN'),
 street:ascii(55),city:ascii(35),state:z.literal('OH'),zip:z.string().regex(/^\d{5}(-\d{4})?$/),
 signerName:ascii(35),signerTitle:ascii(35),phone:z.string().regex(/^[0-9()+ .-]{10,20}$/),
 depositSchedule:z.enum(['monthly','semiweekly']),priorQuarterTaxCents:z.number().int().min(0).max(5000000000),
 federalDepositIds:z.array(z.string().uuid()).max(500).refine(x=>new Set(x).size===x.length,'Duplicate deposit selection'),
 priorCreditCents:z.number().int().min(0).max(5000000000).default(0),creditEvidence:z.string().trim().max(500).default(''),
 censusEmployees:z.number().int().min(0).max(100000),seasonalEmployer:z.boolean().default(false),
 ohioAccount:z.string().trim().max(40).default(''),toledoAccount:z.string().trim().max(40).default(''),
 allWagesIncluded:z.literal(true),ordinaryPayrollOnly:z.literal(true),form941Required:z.literal(true),
 originalReturn:z.literal(true),depositsReconciled:z.literal(true),censusVerified:z.literal(true),applyOverpaymentToNextReturn:z.literal(true),
 reviewReference:z.string().trim().min(12).max(500),
}).strict().refine(x=>!x.priorCreditCents||x.creditEvidence.length>=12,'Retain evidence for prior return credits');
type Input=z.infer<typeof filingInputSchema>;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=(s:string)=>new HttpError(409,'FILING_REVIEW_REQUIRED',s);
function canonical(x:any):any{if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
async function scoped(user:string,unit:string){
 const q=await pool.query('SELECT legal_entity_id FROM business_units WHERE id=$1',[unit]);
 if(!q.rows[0])throw new HttpError(404,'BUSINESS_NOT_FOUND','Business not found');
 const id=q.rows[0].legal_entity_id;await assertLegalEntityPermission(user,id,'payroll.filing.prepare');return id;
}
async function transaction<T>(fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function source(c:PoolClient,entity:string,quarter:number){
 await c.query('SELECT id FROM legal_entities WHERE id=$1 FOR UPDATE',[entity]);
 const {start,end}=quarterDates(quarter);
 const name=(await c.query('SELECT legal_name FROM legal_entities WHERE id=$1',[entity])).rows[0].legal_name;
 const units=(await c.query('SELECT id,name FROM business_units WHERE legal_entity_id=$1 ORDER BY id',[entity])).rows;
 const payments=(await c.query(`SELECT p.id,p.person_key,p.business_unit_id,p.pay_date::text,p.statement,
  v.id AS reversal_id,l.opening_id,o.prior_social_security_wages_cents::text,o.prior_medicare_wages_cents::text
  FROM payroll_payments p LEFT JOIN payroll_payment_reversals v ON v.payment_id=p.id
  JOIN payroll_tax_employee_lines l ON l.calculation_id=p.calculation_id AND l.employee_id=p.employee_id
  JOIN payroll_tax_opening_wages o ON o.id=l.opening_id
  WHERE p.legal_entity_id=$1 AND p.pay_date BETWEEN $2 AND $3 ORDER BY p.pay_date,p.id`,[entity,start,end])).rows;
 const records=(await c.query(`SELECT id,kind,authority,form_name,period_start::text,period_end::text,completed_on::text,
  amount_cents::text,confirmation_reference FROM payroll_tax_external_records
  WHERE legal_entity_id=$1 AND period_start<=$3 AND period_end>=$2 ORDER BY id`,[entity,start,end])).rows;
 const outstanding=(await c.query(`SELECT t.id,l.employee_id,t.status FROM payroll_tax_calculations t
  JOIN payroll_tax_employee_lines l ON l.calculation_id=t.id
  WHERE t.legal_entity_id=$1 AND t.status<>'void' AND t.pay_date BETWEEN $2 AND $3
  AND NOT EXISTS(SELECT 1 FROM payroll_payments p WHERE p.calculation_id=t.id AND p.employee_id=l.employee_id) ORDER BY t.id,l.employee_id`,[entity,start,end])).rows;
 const providers=(await c.query(`SELECT r.id FROM payroll_provider_results r JOIN payroll_provider_batches b ON b.id=r.batch_id
  WHERE b.legal_entity_id=$1 AND r.paid_on BETWEEN $2 AND $3 AND r.payment_status='paid' ORDER BY r.id`,[entity,start,end])).rows;
 return{name,units,payments,records,outstanding,providers};
}
function calculate(src:Awaited<ReturnType<typeof source>>,input:Input){
 const {start,end}=quarterDates(input.quarter);
 const blockers:string[]=[];
 if(!/^[\x20-\x7e]{1,55}$/.test(src.name))blockers.push('Employer legal name needs manual form preparation because of its length or characters.');
 const deposits=input.federalDepositIds.map(id=>{const r=src.records.find(x=>x.id===id);
  if(!r||r.kind!=='remittance'||r.authority!=='irs'||r.period_start<start||r.period_end>end||r.amount_cents===null)
   throw fail('Select only IRS remittances wholly assigned to this quarter; split or reconcile ambiguous records first.');return r;});
 const payments:FilingPayment[]=src.payments.filter(p=>!p.reversal_id).map(p=>{const s=p.statement,a=s.amounts;
  return{id:p.id,personKey:p.person_key,payDate:p.pay_date,periodStart:s.periodStart,periodEnd:s.periodEndExclusive,
   gross:Number(a.gross_cents),federal:Number(a.federal_income_cents),ss:Number(a.social_security_cents),medicare:Number(a.medicare_cents),additional:Number(a.additional_medicare_cents),
   employerSs:Number(a.employer_social_security_cents),employerMedicare:Number(a.employer_medicare_cents),
   ohio:Number(a.ohio_income_cents),toledo:Number(a.toledo_income_cents),school:Number(a.school_income_cents),district:s.schoolDistrictCode,
   priorSs:Number(p.prior_social_security_wages_cents),priorMedicare:Number(p.prior_medicare_wages_cents)};});
 const figures=filingFigures(payments,input.quarter,deposits.reduce((n,r)=>n+Number(r.amount_cents),0),input.priorCreditCents);
 blockers.push(...figures.problems);
 if(src.outstanding.length)blockers.push('Resolve '+src.outstanding.length+' unpaid or unrecorded withholding lines for the quarter.');
 if(src.providers.length)blockers.push('Legacy provider-paid payroll is outside this preparation engine; reconcile/import it before preparing a return.');
 if(src.payments.some(p=>p.reversal_id))blockers.push('Reversed wages require independent tax correction review; automatic original-return preparation is blocked.');
 if(src.records.some(r=>r.kind==='filing'&&r.authority==='irs'))blockers.push('A federal filing is already logged for this period. Review whether an amended return is required.');
 if(input.depositSchedule!=='monthly')blockers.push('Semiweekly depositors need Schedule B, which is not generated in this release.');
 if(figures.monthly.some(m=>m.federalLiability>=10000000))blockers.push('Potential $100,000 deposit-rule exposure requires a deposit-schedule review and Schedule B.');
 // The cumulative employer-wide wage history must advance within each person.
 // Same-day payments are reconciled as a group, independent of UUID sort order.
 for(const person of new Set(payments.map(p=>p.personKey))){
  const rows=payments.filter(p=>p.personKey===person).sort((a,b)=>a.priorMedicare-b.priorMedicare||a.payDate.localeCompare(b.payDate));
  for(let i=1;i<rows.length;i++)if(rows[i]!.priorMedicare!==rows[i-1]!.priorMedicare+rows[i-1]!.gross)
   blockers.push('Prior wages do not reconcile between this employee’s recorded payments: '+rows[i]!.id);
 }
 return{version:'2026-quarterly-v1',year:2026,quarter:input.quarter,employerName:src.name,
  units:src.units,figures,blockers:[...new Set(blockers)],deposits,externalRecords:src.records,
  paymentIds:payments.map(p=>p.id),censusDifference:input.censusEmployees!==figures.census,
  scope:'All business units of this legal employer; ordinary cash payroll recorded in Pioneer.',
  stateLocalNote:'Transfer the dated withholding schedules to the required Ohio/school-district/Toledo filing. Filing frequency and account assignments must be verified with each agency. This schedule is not an agency return.',
  annualNote:'Form 940, W-2/W-3, Ohio annual reconciliations and unemployment wage-detail returns are not generated by this quarterly packet.'};
}
async function audit(c:PoolClient,user:string,entity:string,id:string,action:string){await c.query(`INSERT INTO audit_log(actor_user_id,legal_entity_id,action,resource_type,resource_id,metadata)
 VALUES($1,$2,$3,'payroll_filing_packet',$4,'{}')`,[user,entity,action,id]);}
export async function filingContext(user:string,unit:string,quarter:number){const entity=await scoped(user,unit);
 return transaction(async c=>{const s=await source(c,entity,quarter);return{data:{entityId:entity,employerName:s.name,units:s.units,
  deposits:s.records.filter(x=>x.kind==='remittance'&&x.authority==='irs'),paymentCount:s.payments.filter(p=>!p.reversal_id).length}};});}
export async function prepareFiling(user:string,unit:string,raw:z.input<typeof filingInputSchema>){
 const input=filingInputSchema.parse(raw),entity=await scoped(user,unit);
 return transaction(async c=>{const src=await source(c,entity,input.quarter),snapshot=calculate(src,input),hash=digest(canonical(src));
  const r=await c.query(`INSERT INTO payroll_filing_packets(legal_entity_id,created_from_business_unit_id,tax_year,quarter,inputs,source_digest,snapshot,created_by_user_id)
  VALUES($1,$2,2026,$3,$4::jsonb,$5,$6::jsonb,$7) RETURNING id`,[entity,unit,input.quarter,JSON.stringify(input),hash,JSON.stringify(snapshot),user]);
  await audit(c,user,entity,r.rows[0].id,'payroll.filing.prepared');return{data:{id:r.rows[0].id,...snapshot,status:'draft'}};
 });
}
export async function listFilings(user:string,unit:string){const entity=await scoped(user,unit);
 const r=await pool.query(`SELECT p.id,p.tax_year,p.quarter,p.created_at,r.reviewed_at FROM payroll_filing_packets p
 LEFT JOIN payroll_filing_reviews r ON r.packet_id=p.id WHERE p.legal_entity_id=$1 ORDER BY p.created_at DESC LIMIT 100`,[entity]);return{data:r.rows};}
async function loadPacket(c:PoolClient,entity:string,id:string){const r=await c.query(`SELECT p.*,r.reviewed_at FROM payroll_filing_packets p
 LEFT JOIN payroll_filing_reviews r ON r.packet_id=p.id WHERE p.id=$1 AND p.legal_entity_id=$2`,[id,entity]);
 if(!r.rows[0])throw new HttpError(404,'FILING_NOT_FOUND','Filing packet not found');return r.rows[0];}
function closed(quarter:number){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date())>quarterDates(quarter).end;}
export async function filingDetail(user:string,unit:string,id:string){const entity=await scoped(user,unit);return transaction(async c=>{
 const p=await loadPacket(c,entity,id),src=await source(c,entity,p.quarter);
 const stale=digest(canonical(src))!==p.source_digest;
 return{data:{id:p.id,...p.snapshot,inputs:p.inputs,stale,periodClosed:closed(p.quarter),status:p.reviewed_at?'reviewed':'draft',reviewedAt:p.reviewed_at}};
});}
export async function reviewFiling(user:string,unit:string,id:string){const entity=await scoped(user,unit);return transaction(async c=>{
 const srcEntity=await c.query('SELECT id FROM legal_entities WHERE id=$1 FOR UPDATE',[entity]);void srcEntity;
 const p=await loadPacket(c,entity,id),src=await source(c,entity,p.quarter);
 if(digest(canonical(src))!==p.source_digest)throw fail('Payroll or deposit evidence changed. Prepare a new packet.');
 if(!closed(p.quarter))throw fail('The quarter is still open. Keep this as a planning draft.');
 if(p.snapshot.blockers.length)throw fail(p.snapshot.blockers.join(' '));
 await c.query('INSERT INTO payroll_filing_reviews(packet_id,reviewed_by_user_id) VALUES($1,$2) ON CONFLICT(packet_id) DO NOTHING',[id,user]);
 await audit(c,user,entity,id,'payroll.filing.reviewed');return{data:{id,status:'reviewed',filed:false}};
});}
export async function download941(user:string,unit:string,id:string){
 const entity=await scoped(user,unit);return transaction(async c=>{
 const p=await loadPacket(c,entity,id),src=await source(c,entity,p.quarter);
 if(!p.reviewed_at||!closed(p.quarter)||p.snapshot.blockers.length)throw fail('Review a complete, closed-quarter packet before downloading the unsigned return.');
 if(digest(canonical(src))!==p.source_digest)throw fail('This packet is stale. Prepare and review a new packet.');
 const {form941Pdf}=await import('./payroll-filing-pdf.js');
 const pdf=await form941Pdf({...p.snapshot,inputs:p.inputs});
 await audit(c,user,entity,id,'payroll.filing.pdf_downloaded');
 return{filename:'Form-941-2026-Q'+p.quarter+'-unsigned.pdf',pdf};
 });
}
