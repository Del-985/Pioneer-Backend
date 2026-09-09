import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBookkeepingBusinessUnit, assertBookkeepingLegalEntity } from './bookkeeping-authorization.service.js';
import { dashboardQuerySchema, reportQuerySchema, reportTypeSchema } from './completion.schemas.js';
import { listBookkeepingTransactions } from './transaction.service.js';

type ReportQuery = z.infer<typeof reportQuerySchema>;
type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
type ReportType = z.infer<typeof reportTypeSchema>;

const accessibleUnitsCte = `
WITH accessible_units AS (
  SELECT DISTINCT bu.id,bu.legal_entity_id
  FROM business_units bu
  WHERE EXISTS (
    SELECT 1
    FROM user_role_assignments ura
    JOIN roles r ON r.id=ura.role_id
    JOIN role_permissions rp ON rp.role_id=r.id
    JOIN permissions p ON p.id=rp.permission_id
    WHERE ura.user_id=$1 AND p.key='bookkeeping.read'
      AND (
        (r.scope='platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
        OR (r.scope='legal_entity' AND ura.legal_entity_id=bu.legal_entity_id)
        OR (r.scope='business_unit' AND ura.business_unit_id=bu.id)
      )
  )
)`;

async function assertScope(userId:string, businessUnitId?:string, legalEntityId?:string){
  if(businessUnitId) await assertBookkeepingBusinessUnit(userId,businessUnitId,'bookkeeping.read');
  if(legalEntityId) await assertBookkeepingLegalEntity(userId,legalEntityId,'bookkeeping.read');
}

function scopeInfo(query:{businessUnitId?:string|undefined;legalEntityId?:string|undefined}){
  return {
    type: query.businessUnitId ? 'business_unit' : query.legalEntityId ? 'legal_entity' : 'all_businesses',
    businessUnitId: query.businessUnitId ?? null,
    legalEntityId: query.legalEntityId ?? null,
    intercompanyEliminated: !query.businessUnitId && !query.legalEntityId,
    readOnly: true,
  };
}

function journalScopePredicate(alias='je'){
  return `${alias}.business_unit_id IN (SELECT id FROM accessible_units)
    AND ($2::uuid IS NULL OR ${alias}.business_unit_id=$2)
    AND ($3::uuid IS NULL OR ${alias}.legal_entity_id=$3)`;
}

export async function getBookkeepingReport(userId:string, reportType:ReportType, query:ReportQuery){
  await assertScope(userId,query.businessUnitId,query.legalEntityId);
  if(reportType==='trial-balance') return trialBalance(userId,query);
  if(reportType==='profit-loss') return profitLoss(userId,query);
  if(reportType==='balance-sheet') return balanceSheet(userId,query);
  if(reportType==='cash-flow') return cashFlow(userId,query);
  if(reportType==='general-ledger') return generalLedger(userId,query);
  return accountRegister(userId,query);
}

async function trialBalance(userId:string,query:ReportQuery){
  const asOf=query.asOf ?? query.to ?? new Date().toISOString().slice(0,10);
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const result=await pool.query<{
    account_id:string;code:string;name:string;account_type:string;debits:string;credits:string;
  }>(
    `${accessibleUnitsCte}
     SELECT la.id AS account_id,la.code,la.name,la.account_type,
            COALESCE(sum(jl.debit_cents),0)::bigint::text AS debits,
            COALESCE(sum(jl.credit_cents),0)::bigint::text AS credits
     FROM ledger_accounts la
     JOIN journal_lines jl ON jl.account_id=la.id
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.status IN ('posted','reversed') AND je.entry_date <= $4
       AND ${journalScopePredicate()}
       AND ($5::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')
     GROUP BY la.id,la.code,la.name,la.account_type
     HAVING COALESCE(sum(jl.debit_cents),0)<>0 OR COALESCE(sum(jl.credit_cents),0)<>0
     ORDER BY la.code,la.name`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,asOf,eliminate]
  );
  const data=result.rows.map(r=>({accountId:r.account_id,code:r.code,name:r.name,accountType:r.account_type,debitCents:Number(r.debits),creditCents:Number(r.credits),netDebitCents:Number(r.debits)-Number(r.credits)}));
  return {report:'trial-balance',scope:scopeInfo(query),asOf,data,totals:{debitCents:data.reduce((s,r)=>s+r.debitCents,0),creditCents:data.reduce((s,r)=>s+r.creditCents,0)}};
}

async function profitLoss(userId:string,query:ReportQuery){
  const to=query.to ?? new Date().toISOString().slice(0,10);
  const from=query.from ?? `${to.slice(0,4)}-01-01`;
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const result=await pool.query<{
    account_id:string;code:string;name:string;account_type:'revenue'|'expense';current_amount:string;compare_amount:string;
  }>(
    `${accessibleUnitsCte}
     SELECT la.id AS account_id,la.code,la.name,la.account_type,
       COALESCE(sum(CASE WHEN je.entry_date BETWEEN $4 AND $5 THEN
         CASE WHEN la.account_type='revenue' THEN jl.credit_cents-jl.debit_cents ELSE jl.debit_cents-jl.credit_cents END
       ELSE 0 END),0)::bigint::text AS current_amount,
       COALESCE(sum(CASE WHEN $6::date IS NOT NULL AND je.entry_date BETWEEN $6 AND $7 THEN
         CASE WHEN la.account_type='revenue' THEN jl.credit_cents-jl.debit_cents ELSE jl.debit_cents-jl.credit_cents END
       ELSE 0 END),0)::bigint::text AS compare_amount
     FROM ledger_accounts la
     JOIN journal_lines jl ON jl.account_id=la.id
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.status IN ('posted','reversed') AND la.account_type IN ('revenue','expense')
       AND ${journalScopePredicate()}
       AND ($8::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')
       AND (je.entry_date BETWEEN $4 AND $5 OR ($6::date IS NOT NULL AND je.entry_date BETWEEN $6 AND $7))
     GROUP BY la.id,la.code,la.name,la.account_type
     ORDER BY CASE la.account_type WHEN 'revenue' THEN 0 ELSE 1 END,la.code`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,from,to,query.compareFrom??null,query.compareTo??null,eliminate]
  );
  const data=result.rows.map(r=>({accountId:r.account_id,code:r.code,name:r.name,accountType:r.account_type,amountCents:Number(r.current_amount),compareAmountCents:query.compareFrom?Number(r.compare_amount):null}));
  const revenue=data.filter(r=>r.accountType==='revenue').reduce((s,r)=>s+r.amountCents,0);
  const expenses=data.filter(r=>r.accountType==='expense').reduce((s,r)=>s+r.amountCents,0);
  const compareRevenue=data.filter(r=>r.accountType==='revenue').reduce((s,r)=>s+(r.compareAmountCents??0),0);
  const compareExpenses=data.filter(r=>r.accountType==='expense').reduce((s,r)=>s+(r.compareAmountCents??0),0);
  return {report:'profit-loss',scope:scopeInfo(query),from,to,comparison:query.compareFrom?{from:query.compareFrom,to:query.compareTo}:null,data,totals:{revenueCents:revenue,expenseCents:expenses,netIncomeCents:revenue-expenses,compareRevenueCents:query.compareFrom?compareRevenue:null,compareExpenseCents:query.compareFrom?compareExpenses:null,compareNetIncomeCents:query.compareFrom?compareRevenue-compareExpenses:null}};
}

async function balanceSheet(userId:string,query:ReportQuery){
  const asOf=query.asOf ?? query.to ?? new Date().toISOString().slice(0,10);
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const result=await pool.query<{
    account_id:string;code:string;name:string;account_type:'asset'|'liability'|'equity';amount:string;
  }>(
    `${accessibleUnitsCte}
     SELECT la.id AS account_id,la.code,la.name,la.account_type,
       COALESCE(sum(CASE WHEN la.account_type='asset' THEN jl.debit_cents-jl.credit_cents ELSE jl.credit_cents-jl.debit_cents END),0)::bigint::text AS amount
     FROM ledger_accounts la
     JOIN journal_lines jl ON jl.account_id=la.id
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.status IN ('posted','reversed') AND je.entry_date <= $4
       AND la.account_type IN ('asset','liability','equity') AND ${journalScopePredicate()}
       AND ($5::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')
     GROUP BY la.id,la.code,la.name,la.account_type
     ORDER BY CASE la.account_type WHEN 'asset' THEN 0 WHEN 'liability' THEN 1 ELSE 2 END,la.code`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,asOf,eliminate]
  );
  const earningsResult=await pool.query<{earnings:string}>(
    `${accessibleUnitsCte}
     SELECT COALESCE(sum(CASE WHEN la.account_type='revenue' THEN jl.credit_cents-jl.debit_cents WHEN la.account_type='expense' THEN -(jl.debit_cents-jl.credit_cents) ELSE 0 END),0)::bigint::text AS earnings
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN ledger_accounts la ON la.id=jl.account_id
     WHERE je.status IN ('posted','reversed') AND je.entry_date <= $4 AND ${journalScopePredicate()}
       AND ($5::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,asOf,eliminate]
  );
  const data=result.rows.map(r=>({accountId:r.account_id,code:r.code,name:r.name,accountType:r.account_type,amountCents:Number(r.amount)}));
  const currentEarnings=Number(earningsResult.rows[0]?.earnings??0);
  const assets=data.filter(r=>r.accountType==='asset').reduce((s,r)=>s+r.amountCents,0);
  const liabilities=data.filter(r=>r.accountType==='liability').reduce((s,r)=>s+r.amountCents,0);
  const equity=data.filter(r=>r.accountType==='equity').reduce((s,r)=>s+r.amountCents,0)+currentEarnings;
  return {report:'balance-sheet',scope:scopeInfo(query),asOf,data,currentEarnings:{name:'Current Earnings',amountCents:currentEarnings},totals:{assetCents:assets,liabilityCents:liabilities,equityCents:equity,balanceCheckCents:assets-liabilities-equity}};
}

async function cashFlow(userId:string,query:ReportQuery){
  const to=query.to ?? new Date().toISOString().slice(0,10);
  const from=query.from ?? `${to.slice(0,4)}-01-01`;
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const result=await pool.query<{category:string;amount:string}>(
    `${accessibleUnitsCte}
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM journal_lines ox JOIN ledger_accounts oa ON oa.id=ox.account_id WHERE ox.journal_entry_id=je.id AND ox.id<>jl.id AND oa.account_type IN ('revenue','expense')) THEN 'operating'
       WHEN EXISTS (SELECT 1 FROM journal_lines ox JOIN ledger_accounts oa ON oa.id=ox.account_id WHERE ox.journal_entry_id=je.id AND ox.id<>jl.id AND oa.account_type='asset' AND COALESCE(oa.control_type,'')<>'cash') THEN 'investing'
       WHEN EXISTS (SELECT 1 FROM journal_lines ox JOIN ledger_accounts oa ON oa.id=ox.account_id WHERE ox.journal_entry_id=je.id AND ox.id<>jl.id AND oa.account_type IN ('liability','equity')) THEN 'financing'
       ELSE 'operating' END AS category,
       COALESCE(sum(jl.debit_cents-jl.credit_cents),0)::bigint::text AS amount
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.journal_entry_id
     JOIN ledger_accounts cash ON cash.id=jl.account_id AND cash.control_type='cash'
     WHERE je.status IN ('posted','reversed') AND je.entry_date BETWEEN $4 AND $5
       AND ${journalScopePredicate()}
       AND ($6::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')
     GROUP BY category`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,from,to,eliminate]
  );
  const categories={operatingCents:0,investingCents:0,financingCents:0};
  for(const row of result.rows){
    if(row.category==='operating')categories.operatingCents=Number(row.amount);
    else if(row.category==='investing')categories.investingCents=Number(row.amount);
    else if(row.category==='financing')categories.financingCents=Number(row.amount);
  }
  return {report:'cash-flow',scope:scopeInfo(query),from,to,data:result.rows.map(r=>({category:r.category,amountCents:Number(r.amount)})),totals:{...categories,netCashChangeCents:categories.operatingCents+categories.investingCents+categories.financingCents}};
}

async function generalLedger(userId:string,query:ReportQuery){
  const to=query.to ?? new Date().toISOString().slice(0,10);
  const from=query.from ?? '1900-01-01';
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const result=await pool.query<{
    journal_entry_id:string;entry_number:string;entry_date:string;description:string;source_type:string|null;
    account_id:string;code:string;account_name:string;debit_cents:string;credit_cents:string;memo:string|null;business_unit_id:string;legal_entity_id:string;
  }>(
    `${accessibleUnitsCte}
     SELECT je.id AS journal_entry_id,je.entry_number,je.entry_date::text,je.description,je.source_type,
            jl.account_id,la.code,la.name AS account_name,jl.debit_cents::text,jl.credit_cents::text,jl.memo,
            je.business_unit_id,je.legal_entity_id
     FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id JOIN ledger_accounts la ON la.id=jl.account_id
     WHERE je.status IN ('posted','reversed') AND je.entry_date BETWEEN $4 AND $5 AND ${journalScopePredicate()}
       AND ($6::uuid IS NULL OR jl.account_id=$6)
       AND ($7::boolean=false OR COALESCE(je.source_type,'') <> 'intercompany_transaction')
     ORDER BY je.entry_date,je.entry_number,jl.id LIMIT $8 OFFSET $9`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,from,to,query.accountId??null,eliminate,query.limit,query.offset]
  );
  return {report:'general-ledger',scope:scopeInfo(query),from,to,data:result.rows.map(r=>({journalEntryId:r.journal_entry_id,entryNumber:r.entry_number,entryDate:r.entry_date,description:r.description,sourceType:r.source_type,accountId:r.account_id,accountCode:r.code,accountName:r.account_name,debitCents:Number(r.debit_cents),creditCents:Number(r.credit_cents),memo:r.memo,businessUnitId:r.business_unit_id,legalEntityId:r.legal_entity_id})),meta:{limit:query.limit,offset:query.offset,returned:result.rows.length,hasMore:result.rows.length===query.limit}};
}

async function accountRegister(userId:string,query:ReportQuery){
  if(!query.accountId)throw new HttpError(400,'ACCOUNT_ID_REQUIRED','Account register reporting requires accountId.');
  const businessUnitId=query.businessUnitId;
  if(!businessUnitId)throw new HttpError(400,'BUSINESS_UNIT_REQUIRED','Account register reporting requires businessUnitId.');
  await assertBookkeepingBusinessUnit(userId,businessUnitId,'bookkeeping.read');
  const account=await pool.query<{account_type:string;code:string;name:string}>(`SELECT account_type,code,name FROM ledger_accounts la JOIN business_units bu ON bu.legal_entity_id=la.legal_entity_id WHERE la.id=$1 AND bu.id=$2`,[query.accountId,businessUnitId]);
  const info=account.rows[0];if(!info)throw new HttpError(404,'ACCOUNT_NOT_FOUND','Account not found in the selected books.');
  const from=query.from??'1900-01-01';const to=query.to??new Date().toISOString().slice(0,10);
  const normalDebit=info.account_type==='asset'||info.account_type==='expense';
  const opening=await pool.query<{amount:string}>(`SELECT COALESCE(sum(CASE WHEN $4::boolean THEN jl.debit_cents-jl.credit_cents ELSE jl.credit_cents-jl.debit_cents END),0)::bigint::text AS amount FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.status IN ('posted','reversed') AND je.business_unit_id=$1 AND jl.account_id=$2 AND je.entry_date<$3`,[businessUnitId,query.accountId,from,normalDebit]);
  const begin=Number(opening.rows[0]?.amount??0);
  const lines=await pool.query<{journal_line_id:string;journal_entry_id:string;entry_number:string;entry_date:string;description:string;debit_cents:string;credit_cents:string;memo:string|null;movement:string;running:string}>(
    `SELECT jl.id AS journal_line_id,je.id AS journal_entry_id,je.entry_number,je.entry_date::text,je.description,
            jl.debit_cents::text,jl.credit_cents::text,jl.memo,
            (CASE WHEN $5::boolean THEN jl.debit_cents-jl.credit_cents ELSE jl.credit_cents-jl.debit_cents END)::bigint::text AS movement,
            ($6::bigint + sum(CASE WHEN $5::boolean THEN jl.debit_cents-jl.credit_cents ELSE jl.credit_cents-jl.debit_cents END) OVER (ORDER BY je.entry_date,je.entry_number,jl.id ROWS UNBOUNDED PRECEDING))::bigint::text AS running
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.status IN ('posted','reversed') AND je.business_unit_id=$1 AND jl.account_id=$2 AND je.entry_date BETWEEN $3 AND $4
     ORDER BY je.entry_date,je.entry_number,jl.id LIMIT $7 OFFSET $8`,
    [businessUnitId,query.accountId,from,to,normalDebit,begin,query.limit,query.offset]
  );
  return {report:'account-register',scope:scopeInfo({businessUnitId}),account:{id:query.accountId,code:info.code,name:info.name,accountType:info.account_type},from,to,openingBalanceCents:begin,data:lines.rows.map(r=>({journalLineId:r.journal_line_id,journalEntryId:r.journal_entry_id,entryNumber:r.entry_number,entryDate:r.entry_date,description:r.description,debitCents:Number(r.debit_cents),creditCents:Number(r.credit_cents),memo:r.memo,movementCents:Number(r.movement),runningBalanceCents:Number(r.running)})),meta:{limit:query.limit,offset:query.offset,returned:lines.rows.length,hasMore:lines.rows.length===query.limit}};
}

export async function getBookkeepingDashboard(userId:string,query:DashboardQuery){
  await assertScope(userId,query.businessUnitId,query.legalEntityId);
  const asOf=query.asOf??new Date().toISOString().slice(0,10);
  const from=`${asOf.slice(0,4)}-01-01`;
  const eliminate=!query.businessUnitId&&!query.legalEntityId;
  const cash=await pool.query<{account_id:string;code:string;name:string;balance:string}>(
    `${accessibleUnitsCte}
     SELECT la.id AS account_id,la.code,la.name,COALESCE(sum(jl.debit_cents-jl.credit_cents),0)::bigint::text AS balance
     FROM ledger_accounts la JOIN journal_lines jl ON jl.account_id=la.id JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE la.control_type='cash' AND je.status IN ('posted','reversed') AND je.entry_date<=$4 AND ${journalScopePredicate()}
       AND ($5::boolean=false OR COALESCE(je.source_type,'')<>'intercompany_transaction')
     GROUP BY la.id,la.code,la.name ORDER BY la.code`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,asOf,eliminate]
  );
  const plQuery:ReportQuery={from,to:asOf,format:'json',limit:1000,offset:0};
  if(query.businessUnitId)plQuery.businessUnitId=query.businessUnitId;
  if(query.legalEntityId)plQuery.legalEntityId=query.legalEntityId;
  const income=await profitLoss(userId,plQuery);
  const unreconciled=await pool.query<{count:string}>(
    `${accessibleUnitsCte}
     SELECT count(*)::text AS count FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN ledger_accounts la ON la.id=jl.account_id
     WHERE la.control_type='cash' AND je.status='posted' AND je.entry_date<=$4 AND ${journalScopePredicate()}
       AND NOT EXISTS (SELECT 1 FROM reconciliation_items ri WHERE ri.journal_line_id=jl.id)
       AND ($5::boolean=false OR COALESCE(je.source_type,'')<>'intercompany_transaction')`,
    [userId,query.businessUnitId??null,query.legalEntityId??null,asOf,eliminate]
  );
  const txQuery:Parameters<typeof listBookkeepingTransactions>[1]={limit:10,offset:0};
  if(query.businessUnitId)txQuery.businessUnitId=query.businessUnitId;
  if(query.legalEntityId)txQuery.legalEntityId=query.legalEntityId;
  const recent=await listBookkeepingTransactions(userId,txQuery);
  const cashAccounts=cash.rows.map(r=>({accountId:r.account_id,code:r.code,name:r.name,balanceCents:Number(r.balance)}));
  return {scope:scopeInfo(query),asOf,yearToDate:{from,to:asOf,revenueCents:income.totals.revenueCents,expenseCents:income.totals.expenseCents,netIncomeCents:income.totals.netIncomeCents},cashBalanceCents:cashAccounts.reduce((s,r)=>s+r.balanceCents,0),cashAccounts,unreconciledCount:Number(unreconciled.rows[0]?.count??0),recentTransactions:recent.data};
}
