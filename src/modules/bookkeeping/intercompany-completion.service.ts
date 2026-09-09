import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import {
  assertBookkeepingAccountScope,
  assertBookkeepingBusinessUnit,
  assertBookkeepingLegalEntity,
} from './bookkeeping-authorization.service.js';

type IntercompanyRow={
  id:string;from_legal_entity_id:string;to_legal_entity_id:string;
  from_business_unit_id:string|null;to_business_unit_id:string|null;transaction_date:string;
  amount_cents:string;description:string;status:'draft'|'posted'|'settled'|'void';
  from_journal_entry_id:string|null;to_journal_entry_id:string|null;reconciled_at:Date|null;
};

type ConfigRow={legal_entity_id:string;due_from_account_id:string;due_to_account_id:string;created_at:Date;updated_at:Date};

export async function getIntercompanyAccountConfig(userId:string,businessUnitId:string){
  const context=await assertBookkeepingBusinessUnit(userId,businessUnitId,'bookkeeping.read');
  const result=await pool.query<ConfigRow>(`SELECT legal_entity_id,due_from_account_id,due_to_account_id,created_at,updated_at FROM intercompany_account_configs WHERE legal_entity_id=$1`,[context.legalEntityId]);
  const row=result.rows[0];
  return row?{legalEntityId:row.legal_entity_id,dueFromAccountId:row.due_from_account_id,dueToAccountId:row.due_to_account_id,createdAt:row.created_at,updatedAt:row.updated_at}:null;
}

export async function updateIntercompanyAccountConfig(userId:string,input:{businessUnitId:string;dueFromAccountId:string;dueToAccountId:string}){
  const context=await assertBookkeepingBusinessUnit(userId,input.businessUnitId,'bookkeeping.adjust');
  await assertBookkeepingLegalEntity(userId,context.legalEntityId,'bookkeeping.adjust');
  await assertBookkeepingAccountScope(userId,input.businessUnitId,input.dueFromAccountId,'bookkeeping.adjust');
  await assertBookkeepingAccountScope(userId,input.businessUnitId,input.dueToAccountId,'bookkeeping.adjust');
  const result=await pool.query<ConfigRow>(
    `INSERT INTO intercompany_account_configs (legal_entity_id,due_from_account_id,due_to_account_id,created_by_user_id,updated_by_user_id)
     VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (legal_entity_id) DO UPDATE SET due_from_account_id=EXCLUDED.due_from_account_id,due_to_account_id=EXCLUDED.due_to_account_id,updated_by_user_id=EXCLUDED.updated_by_user_id
     RETURNING legal_entity_id,due_from_account_id,due_to_account_id,created_at,updated_at`,
    [context.legalEntityId,input.dueFromAccountId,input.dueToAccountId,userId]
  );
  const row=result.rows[0]!;
  await writeAuditEvent({actorUserId:userId,legalEntityId:context.legalEntityId,businessUnitId:input.businessUnitId,
    action:'bookkeeping.intercompany.config.updated',resourceType:'intercompany_account_config',resourceId:context.legalEntityId,
    metadata:{dueFromAccountId:input.dueFromAccountId,dueToAccountId:input.dueToAccountId}});
  return {legalEntityId:row.legal_entity_id,dueFromAccountId:row.due_from_account_id,dueToAccountId:row.due_to_account_id,createdAt:row.created_at,updatedAt:row.updated_at};
}

async function loadTransaction(id:string){
  const result=await pool.query<IntercompanyRow>(
    `SELECT id,from_legal_entity_id,to_legal_entity_id,from_business_unit_id,to_business_unit_id,transaction_date::text,
            amount_cents::text,description,status,from_journal_entry_id,to_journal_entry_id,reconciled_at
     FROM intercompany_transactions WHERE id=$1`,[id]
  );
  const row=result.rows[0];if(!row)throw new HttpError(404,'INTERCOMPANY_NOT_FOUND','Intercompany transaction not found.');return row;
}

async function configForEntity(entityId:string){
  const result=await pool.query<ConfigRow>(`SELECT legal_entity_id,due_from_account_id,due_to_account_id,created_at,updated_at FROM intercompany_account_configs WHERE legal_entity_id=$1`,[entityId]);
  const row=result.rows[0];if(!row)throw new HttpError(409,'INTERCOMPANY_CONFIG_REQUIRED','Both legal entities require intercompany due-to/due-from account configuration before posting.');return row;
}

export async function postConfiguredIntercompany(userId:string,id:string,input:{fromEntryNumber:string;toEntryNumber:string;fromOffsetAccountId:string;toOffsetAccountId:string}){
  const tx=await loadTransaction(id);
  if(tx.status!=='draft')throw new HttpError(409,'INTERCOMPANY_NOT_DRAFT','Only draft intercompany transactions can be posted.');
  if(!tx.from_business_unit_id||!tx.to_business_unit_id)throw new HttpError(409,'INTERCOMPANY_SCOPE_MISSING','Intercompany business-unit scope is missing.');
  await assertBusinessUnitPermission(userId,tx.from_business_unit_id,'intercompany.write');
  await assertBusinessUnitPermission(userId,tx.to_business_unit_id,'intercompany.write');
  await assertBookkeepingBusinessUnit(userId,tx.from_business_unit_id,'bookkeeping.post');
  await assertBookkeepingBusinessUnit(userId,tx.to_business_unit_id,'bookkeeping.post');
  await assertBookkeepingAccountScope(userId,tx.from_business_unit_id,input.fromOffsetAccountId,'bookkeeping.post');
  await assertBookkeepingAccountScope(userId,tx.to_business_unit_id,input.toOffsetAccountId,'bookkeeping.post');
  const fromConfig=await configForEntity(tx.from_legal_entity_id);
  const toConfig=await configForEntity(tx.to_legal_entity_id);
  const amount=Number(tx.amount_cents);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const from=await client.query<{id:string}>(
      `INSERT INTO journal_entries (legal_entity_id,business_unit_id,entry_number,entry_date,description,source_type,source_id,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'intercompany_transaction',$6,$7) RETURNING id`,
      [tx.from_legal_entity_id,tx.from_business_unit_id,input.fromEntryNumber,tx.transaction_date,tx.description,tx.id,userId]
    );
    const to=await client.query<{id:string}>(
      `INSERT INTO journal_entries (legal_entity_id,business_unit_id,entry_number,entry_date,description,source_type,source_id,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,'intercompany_transaction',$6,$7) RETURNING id`,
      [tx.to_legal_entity_id,tx.to_business_unit_id,input.toEntryNumber,tx.transaction_date,tx.description,tx.id,userId]
    );
    const fromId=from.rows[0]?.id;const toId=to.rows[0]?.id;
    if(!fromId||!toId)throw new HttpError(500,'INTERCOMPANY_JOURNAL_FAILED','Intercompany journals could not be created.');
    await client.query(`INSERT INTO journal_lines (journal_entry_id,account_id,debit_cents,credit_cents,memo) VALUES ($1,$2,$3,0,$4),($1,$5,0,$3,$4)`,[fromId,fromConfig.due_from_account_id,amount,tx.description,input.fromOffsetAccountId]);
    await client.query(`INSERT INTO journal_lines (journal_entry_id,account_id,debit_cents,credit_cents,memo) VALUES ($1,$2,$3,0,$4),($1,$5,0,$3,$4)`,[toId,input.toOffsetAccountId,amount,tx.description,toConfig.due_to_account_id]);
    await client.query(`UPDATE journal_entries SET status='posted' WHERE id IN ($1,$2)`,[fromId,toId]);
    const updated=await client.query<IntercompanyRow>(
      `UPDATE intercompany_transactions SET status='posted',from_journal_entry_id=$2,to_journal_entry_id=$3 WHERE id=$1 AND status='draft'
       RETURNING id,from_legal_entity_id,to_legal_entity_id,from_business_unit_id,to_business_unit_id,transaction_date::text,amount_cents::text,description,status,from_journal_entry_id,to_journal_entry_id,reconciled_at`,
      [id,fromId,toId]
    );
    if(!updated.rows[0])throw new HttpError(409,'INTERCOMPANY_POST_RACE','Intercompany transaction changed while posting.');
    await client.query('COMMIT');
    await writeAuditEvent({actorUserId:userId,action:'bookkeeping.intercompany.posted',resourceType:'intercompany_transaction',resourceId:id,
      metadata:{fromLegalEntityId:tx.from_legal_entity_id,toLegalEntityId:tx.to_legal_entity_id,fromJournalEntryId:fromId,toJournalEntryId:toId,sharedTransactionId:id}});
    return {id,status:'posted' as const,sharedTransactionId:id,fromJournalEntryId:fromId,toJournalEntryId:toId};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function reconcileIntercompany(userId:string,id:string,input:{fromBusinessUnitId:string;toBusinessUnitId:string}){
  const tx=await loadTransaction(id);
  if(tx.status!=='posted')throw new HttpError(409,'INTERCOMPANY_NOT_POSTED','Only posted intercompany transactions can be reconciled.');
  if(tx.from_business_unit_id!==input.fromBusinessUnitId||tx.to_business_unit_id!==input.toBusinessUnitId)throw new HttpError(404,'INTERCOMPANY_NOT_FOUND','Intercompany transaction not found in the selected books.');
  await assertBusinessUnitPermission(userId,input.fromBusinessUnitId,'intercompany.write');
  await assertBusinessUnitPermission(userId,input.toBusinessUnitId,'intercompany.write');
  await assertBookkeepingBusinessUnit(userId,input.fromBusinessUnitId,'bookkeeping.reconcile');
  await assertBookkeepingBusinessUnit(userId,input.toBusinessUnitId,'bookkeeping.reconcile');
  const journals=await pool.query<{id:string;status:string}>(`SELECT id,status FROM journal_entries WHERE id IN ($1,$2)`,[tx.from_journal_entry_id,tx.to_journal_entry_id]);
  if(journals.rows.length!==2||journals.rows.some(row=>row.status!=='posted'))throw new HttpError(409,'INTERCOMPANY_JOURNALS_NOT_POSTED','Both intercompany journals must remain posted to reconcile the transaction.');
  await pool.query(`UPDATE intercompany_transactions SET status='settled',reconciled_at=now(),reconciled_by_user_id=$2 WHERE id=$1`,[id,userId]);
  await writeAuditEvent({actorUserId:userId,action:'bookkeeping.intercompany.reconciled',resourceType:'intercompany_transaction',resourceId:id,
    metadata:{fromLegalEntityId:tx.from_legal_entity_id,toLegalEntityId:tx.to_legal_entity_id}});
  return {id,status:'settled' as const,reconciled:true};
}

export async function listIntercompanyEliminations(userId:string,input:{from?:string;to?:string}){
  const access=await pool.query<{allowed:boolean}>(
    `SELECT EXISTS(SELECT 1 FROM user_role_assignments ura JOIN roles r ON r.id=ura.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE ura.user_id=$1 AND p.key='intercompany.read' AND r.scope='platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL) AS allowed`,[userId]
  );
  if(!access.rows[0]?.allowed)throw new HttpError(403,'FORBIDDEN','Platform intercompany access is required for consolidation eliminations.');
  const result=await pool.query<{
    transaction_id:string;transaction_date:string;description:string;amount_cents:string;from_legal_entity_id:string;to_legal_entity_id:string;from_journal_entry_id:string;to_journal_entry_id:string;
  }>(
    `SELECT id AS transaction_id,transaction_date::text,description,amount_cents::text,from_legal_entity_id,to_legal_entity_id,from_journal_entry_id,to_journal_entry_id
     FROM intercompany_transactions WHERE status IN ('posted','settled')
       AND ($1::date IS NULL OR transaction_date >= $1) AND ($2::date IS NULL OR transaction_date <= $2)
     ORDER BY transaction_date,id`,[input.from??null,input.to??null]
  );
  return result.rows.map(row=>({transactionId:row.transaction_id,transactionDate:row.transaction_date,description:row.description,amountCents:Number(row.amount_cents),fromLegalEntityId:row.from_legal_entity_id,toLegalEntityId:row.to_legal_entity_id,fromJournalEntryId:row.from_journal_entry_id,toJournalEntryId:row.to_journal_entry_id,eliminationSourceType:'intercompany_transaction'}));
}
