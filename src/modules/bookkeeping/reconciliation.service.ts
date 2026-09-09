import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { paginationMeta } from '../../lib/pagination.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { assertBookkeepingAccountScope, assertBookkeepingBusinessUnit, type BookkeepingPermission } from './bookkeeping-authorization.service.js';
import {
  createReconciliationSchema,
  reconciliationCandidatesQuerySchema,
  reconciliationListQuerySchema,
} from './completion.schemas.js';

type ListQuery = z.infer<typeof reconciliationListQuerySchema>;
type CandidateQuery = z.infer<typeof reconciliationCandidatesQuerySchema>;
type CreateInput = z.infer<typeof createReconciliationSchema>;

type SessionRow = {
  id: string;
  legal_entity_id: string;
  business_unit_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  statement_date: string;
  opening_balance_cents: string;
  ending_balance_cents: string;
  calculated_balance_cents: string | null;
  difference_cents: string | null;
  tolerance_cents: string;
  status: 'draft' | 'completed' | 'reopened' | 'void';
  notes: string | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapSession(row: SessionRow) {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    businessUnitId: row.business_unit_id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    statementDate: row.statement_date,
    openingBalanceCents: Number(row.opening_balance_cents),
    endingBalanceCents: Number(row.ending_balance_cents),
    calculatedBalanceCents: row.calculated_balance_cents === null ? null : Number(row.calculated_balance_cents),
    differenceCents: row.difference_cents === null ? null : Number(row.difference_cents),
    toleranceCents: Number(row.tolerance_cents),
    status: row.status,
    notes: row.notes,
    completedAt: row.completed_at,
    completedByUserId: row.completed_by_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const sessionSelect = `
  SELECT rs.id,rs.legal_entity_id,rs.business_unit_id,rs.account_id,
         la.code AS account_code,la.name AS account_name,rs.statement_date::text,
         rs.opening_balance_cents::text,rs.ending_balance_cents::text,
         rs.calculated_balance_cents::text,rs.difference_cents::text,rs.tolerance_cents::text,
         rs.status,rs.notes,rs.completed_at,rs.completed_by_user_id,rs.created_by_user_id,
         rs.created_at,rs.updated_at
  FROM reconciliation_sessions rs
  JOIN ledger_accounts la ON la.id=rs.account_id`;

async function loadSession(
  userId: string,
  businessUnitId: string,
  reconciliationId: string,
  permission: BookkeepingPermission
) {
  await assertBookkeepingBusinessUnit(userId, businessUnitId, permission);
  const result = await pool.query<SessionRow>(
    `${sessionSelect} WHERE rs.id=$1 AND rs.business_unit_id=$2`,
    [reconciliationId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'RECONCILIATION_NOT_FOUND', 'Reconciliation session not found.');
  return row;
}

async function itemsForSession(reconciliationId: string) {
  const result = await pool.query<{
    id: string;
    journal_line_id: string;
    journal_entry_id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    debit_cents: string;
    credit_cents: string;
    cleared_at: Date;
  }>(
    `SELECT ri.id,ri.journal_line_id,jl.journal_entry_id,je.entry_number,je.entry_date::text,
            je.description,jl.debit_cents::text,jl.credit_cents::text,ri.cleared_at
     FROM reconciliation_items ri
     JOIN journal_lines jl ON jl.id=ri.journal_line_id
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE ri.reconciliation_id=$1
     ORDER BY je.entry_date,je.entry_number,ri.created_at`,
    [reconciliationId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    journalLineId: row.journal_line_id,
    journalEntryId: row.journal_entry_id,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    description: row.description,
    debitCents: Number(row.debit_cents),
    creditCents: Number(row.credit_cents),
    clearedAt: row.cleared_at,
  }));
}

async function calculateSession(row: SessionRow) {
  const accountTypeResult = await pool.query<{ account_type: string }>(
    `SELECT account_type FROM ledger_accounts WHERE id=$1`,
    [row.account_id]
  );
  const accountType = accountTypeResult.rows[0]?.account_type;
  if (!accountType) throw new HttpError(409, 'RECONCILIATION_ACCOUNT_MISSING', 'Reconciliation account no longer exists.');
  const normalDebit = accountType === 'asset' || accountType === 'expense';
  const totals = await pool.query<{ movement: string }>(
    `SELECT COALESCE(sum(
       CASE WHEN $2::boolean THEN jl.debit_cents-jl.credit_cents
            ELSE jl.credit_cents-jl.debit_cents END
     ),0)::bigint::text AS movement
     FROM reconciliation_items ri
     JOIN journal_lines jl ON jl.id=ri.journal_line_id
     WHERE ri.reconciliation_id=$1`,
    [row.id, normalDebit]
  );
  const movement = Number(totals.rows[0]?.movement ?? 0);
  const calculated = Number(row.opening_balance_cents) + movement;
  const difference = calculated - Number(row.ending_balance_cents);
  return { movementCents: movement, calculatedBalanceCents: calculated, differenceCents: difference };
}

export async function listReconciliations(userId: string, query: ListQuery) {
  await assertBookkeepingBusinessUnit(userId, query.businessUnitId, 'bookkeeping.read');
  const result = await pool.query<SessionRow>(
    `${sessionSelect}
     WHERE rs.business_unit_id=$1
       AND ($2::uuid IS NULL OR rs.account_id=$2)
       AND ($3::text IS NULL OR rs.status=$3)
     ORDER BY rs.statement_date DESC,rs.created_at DESC
     LIMIT $4 OFFSET $5`,
    [query.businessUnitId,query.accountId ?? null,query.status ?? null,query.limit,query.offset]
  );
  return { data: result.rows.map(mapSession), meta: paginationMeta(query, result.rows.length) };
}

export async function createReconciliation(userId: string, input: CreateInput) {
  const context = await assertBookkeepingAccountScope(userId,input.businessUnitId,input.accountId,'bookkeeping.reconcile');
  const result = await pool.query<SessionRow>(
    `INSERT INTO reconciliation_sessions (
       legal_entity_id,business_unit_id,account_id,statement_date,opening_balance_cents,
       ending_balance_cents,tolerance_cents,notes,created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,legal_entity_id,business_unit_id,account_id,
       (SELECT code FROM ledger_accounts WHERE id=account_id) AS account_code,
       (SELECT name FROM ledger_accounts WHERE id=account_id) AS account_name,
       statement_date::text,opening_balance_cents::text,ending_balance_cents::text,
       calculated_balance_cents::text,difference_cents::text,tolerance_cents::text,status,notes,
       completed_at,completed_by_user_id,created_by_user_id,created_at,updated_at`,
    [context.legalEntityId,input.businessUnitId,input.accountId,input.statementDate,input.openingBalanceCents,input.endingBalanceCents,input.toleranceCents,input.notes ?? null,userId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(500, 'RECONCILIATION_CREATE_FAILED', 'Reconciliation session could not be created.');
  await writeAuditEvent({
    actorUserId:userId,legalEntityId:context.legalEntityId,businessUnitId:input.businessUnitId,
    action:'bookkeeping.reconciliation.created',resourceType:'reconciliation_session',resourceId:row.id,
    metadata:{accountId:input.accountId,statementDate:input.statementDate,endingBalanceCents:input.endingBalanceCents},
  });
  return mapSession(row);
}

export async function getReconciliation(userId: string, businessUnitId: string, reconciliationId: string) {
  const row = await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.read');
  const calculation = await calculateSession(row);
  return { ...mapSession(row), ...calculation, items: await itemsForSession(row.id) };
}

export async function listReconciliationCandidates(
  userId: string,
  reconciliationId: string,
  query: CandidateQuery
) {
  const row = await loadSession(userId,query.businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if (!['draft','reopened'].includes(row.status)) {
    throw new HttpError(409,'RECONCILIATION_LOCKED','Only open reconciliation sessions can select cleared items.');
  }
  const result = await pool.query<{
    journal_line_id:string;journal_entry_id:string;entry_number:string;entry_date:string;description:string;
    debit_cents:string;credit_cents:string;memo:string|null;
  }>(
    `SELECT jl.id AS journal_line_id,je.id AS journal_entry_id,je.entry_number,je.entry_date::text,
            je.description,jl.debit_cents::text,jl.credit_cents::text,jl.memo
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.business_unit_id=$1 AND je.status='posted' AND jl.account_id=$2
       AND je.entry_date <= $3
       AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.journal_line_id=jl.id)
     ORDER BY je.entry_date,je.entry_number,jl.id
     LIMIT $4 OFFSET $5`,
    [query.businessUnitId,row.account_id,row.statement_date,query.limit,query.offset]
  );
  return {
    data: result.rows.map((candidate)=>({
      journalLineId:candidate.journal_line_id,journalEntryId:candidate.journal_entry_id,
      entryNumber:candidate.entry_number,entryDate:candidate.entry_date,description:candidate.description,
      debitCents:Number(candidate.debit_cents),creditCents:Number(candidate.credit_cents),memo:candidate.memo,
    })),
    meta: paginationMeta(query,result.rows.length),
  };
}

export async function addReconciliationItems(
  userId:string,
  businessUnitId:string,
  reconciliationId:string,
  journalLineIds:string[]
) {
  const row=await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if (!['draft','reopened'].includes(row.status)) throw new HttpError(409,'RECONCILIATION_LOCKED','Completed reconciliation sessions cannot be changed.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const lineId of journalLineIds){
      await client.query(
        `INSERT INTO reconciliation_items (reconciliation_id,journal_line_id,created_by_user_id)
         VALUES ($1,$2,$3) ON CONFLICT (reconciliation_id,journal_line_id) DO NOTHING`,
        [reconciliationId,lineId,userId]
      );
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const calculation=await calculateSession(row);
  await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId,
    action:'bookkeeping.reconciliation.items_added',resourceType:'reconciliation_session',resourceId:reconciliationId,
    metadata:{journalLineIds,calculation}});
  return { ...calculation, items:await itemsForSession(reconciliationId) };
}

export async function removeReconciliationItem(userId:string,businessUnitId:string,reconciliationId:string,itemId:string){
  const row=await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if (!['draft','reopened'].includes(row.status)) throw new HttpError(409,'RECONCILIATION_LOCKED','Completed reconciliation sessions cannot be changed.');
  const result=await pool.query<{journal_line_id:string}>(
    `DELETE FROM reconciliation_items WHERE id=$1 AND reconciliation_id=$2 RETURNING journal_line_id`,[itemId,reconciliationId]
  );
  if(!result.rows[0])throw new HttpError(404,'RECONCILIATION_ITEM_NOT_FOUND','Reconciliation item not found.');
  const calculation=await calculateSession(row);
  await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId,
    action:'bookkeeping.reconciliation.item_removed',resourceType:'reconciliation_session',resourceId:reconciliationId,
    metadata:{journalLineId:result.rows[0].journal_line_id,calculation}});
  return { ...calculation, items:await itemsForSession(reconciliationId) };
}

export async function completeReconciliation(userId:string,businessUnitId:string,reconciliationId:string){
  const row=await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if(!['draft','reopened'].includes(row.status))throw new HttpError(409,'RECONCILIATION_NOT_OPEN','Only open reconciliation sessions can be completed.');
  const calculation=await calculateSession(row);
  if(Math.abs(calculation.differenceCents)>Number(row.tolerance_cents)){
    throw new HttpError(409,'RECONCILIATION_OUT_OF_BALANCE','Reconciliation difference exceeds the configured tolerance.',calculation);
  }
  const updated=await pool.query<SessionRow>(
    `UPDATE reconciliation_sessions rs
     SET status='completed',calculated_balance_cents=$3,difference_cents=$4,completed_at=now(),completed_by_user_id=$5
     WHERE rs.id=$1 AND rs.business_unit_id=$2 AND rs.status IN ('draft','reopened')
     RETURNING rs.id,rs.legal_entity_id,rs.business_unit_id,rs.account_id,
       (SELECT code FROM ledger_accounts WHERE id=rs.account_id) AS account_code,
       (SELECT name FROM ledger_accounts WHERE id=rs.account_id) AS account_name,
       rs.statement_date::text,rs.opening_balance_cents::text,rs.ending_balance_cents::text,
       rs.calculated_balance_cents::text,rs.difference_cents::text,rs.tolerance_cents::text,rs.status,rs.notes,
       rs.completed_at,rs.completed_by_user_id,rs.created_by_user_id,rs.created_at,rs.updated_at`,
    [reconciliationId,businessUnitId,calculation.calculatedBalanceCents,calculation.differenceCents,userId]
  );
  const result=updated.rows[0];
  if(!result)throw new HttpError(409,'RECONCILIATION_COMPLETE_FAILED','Reconciliation could not be completed.');
  await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId,
    action:'bookkeeping.reconciliation.completed',resourceType:'reconciliation_session',resourceId:reconciliationId,
    metadata:calculation});
  return { ...mapSession(result),items:await itemsForSession(reconciliationId) };
}

export async function reopenReconciliation(userId:string,businessUnitId:string,reconciliationId:string){
  const row=await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if(row.status!=='completed')throw new HttpError(409,'RECONCILIATION_NOT_COMPLETED','Only completed reconciliation sessions can be reopened.');
  await pool.query(
    `UPDATE reconciliation_sessions SET status='reopened',completed_at=NULL,completed_by_user_id=NULL WHERE id=$1`,
    [reconciliationId]
  );
  await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId,
    action:'bookkeeping.reconciliation.reopened',resourceType:'reconciliation_session',resourceId:reconciliationId});
  return getReconciliation(userId,businessUnitId,reconciliationId);
}

export async function voidReconciliation(userId:string,businessUnitId:string,reconciliationId:string){
  const row=await loadSession(userId,businessUnitId,reconciliationId,'bookkeeping.reconcile');
  if(row.status==='completed')throw new HttpError(409,'RECONCILIATION_COMPLETED','Completed reconciliation sessions must be reopened before voiding.');
  await pool.query(`UPDATE reconciliation_sessions SET status='void' WHERE id=$1`,[reconciliationId]);
  await writeAuditEvent({actorUserId:userId,legalEntityId:row.legal_entity_id,businessUnitId,
    action:'bookkeeping.reconciliation.voided',resourceType:'reconciliation_session',resourceId:reconciliationId});
  return {id:reconciliationId,status:'void' as const};
}
