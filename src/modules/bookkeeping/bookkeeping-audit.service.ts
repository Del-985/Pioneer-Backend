import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { paginationMeta } from '../../lib/pagination.js';
import { assertBookkeepingBusinessUnit, assertBookkeepingLegalEntity } from './bookkeeping-authorization.service.js';
import { bookkeepingAuditQuerySchema } from './completion.schemas.js';

type AuditQuery=z.infer<typeof bookkeepingAuditQuerySchema>;
type Row={id:string;actor_user_id:string|null;actor_name:string|null;legal_entity_id:string|null;business_unit_id:string|null;action:string;resource_type:string;resource_id:string|null;metadata:unknown;ip_address:string|null;user_agent:string|null;created_at:Date};

const financialResourceTypes=[
  'ledger_account','journal_entry','accounting_period','expense','revenue_record','bookkeeping_transfer',
  'reconciliation_session','recurring_bookkeeping_template','intercompany_transaction','intercompany_account_config',
  'bookkeeping_attachment','mileage_log','account_opening_balance','accounting_event',
];

export async function listBookkeepingAudit(userId:string,q:AuditQuery){
  if(q.businessUnitId)await assertBookkeepingBusinessUnit(userId,q.businessUnitId,'bookkeeping.audit.read');
  if(q.legalEntityId)await assertBookkeepingLegalEntity(userId,q.legalEntityId,'bookkeeping.audit.read');
  const result=await pool.query<Row>(
    `SELECT al.id,al.actor_user_id,u.display_name AS actor_name,al.legal_entity_id,al.business_unit_id,
            CASE WHEN al.action LIKE 'bookkeeping.%' THEN al.action ELSE 'bookkeeping.'||al.action END AS action,
            al.resource_type,al.resource_id,al.metadata,al.ip_address::text,al.user_agent,al.created_at
     FROM audit_log al LEFT JOIN users u ON u.id=al.actor_user_id LEFT JOIN business_units bu ON bu.id=al.business_unit_id
     WHERE (al.action LIKE 'bookkeeping.%' OR al.resource_type=ANY($10::text[]))
       AND ($2::uuid IS NULL OR al.business_unit_id=$2)
       AND ($3::uuid IS NULL OR al.legal_entity_id=$3 OR bu.legal_entity_id=$3)
       AND ($4::uuid IS NULL OR al.actor_user_id=$4)
       AND ($5::text IS NULL OR al.action=$5 OR 'bookkeeping.'||al.action=$5)
       AND ($6::text IS NULL OR al.resource_type=$6)
       AND ($7::uuid IS NULL OR al.resource_id=$7)
       AND ($8::timestamptz IS NULL OR al.created_at >= $8)
       AND ($9::timestamptz IS NULL OR al.created_at <= $9)
       AND EXISTS (
         SELECT 1 FROM user_role_assignments ura
         JOIN roles r ON r.id=ura.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
         WHERE ura.user_id=$1 AND p.key='bookkeeping.audit.read' AND (
           (r.scope='platform' AND ura.legal_entity_id IS NULL AND ura.business_unit_id IS NULL)
           OR (r.scope='legal_entity' AND (al.legal_entity_id=ura.legal_entity_id OR bu.legal_entity_id=ura.legal_entity_id))
           OR (r.scope='business_unit' AND al.business_unit_id=ura.business_unit_id)
         )
       )
     ORDER BY al.created_at DESC LIMIT $11 OFFSET $12`,
    [userId,q.businessUnitId??null,q.legalEntityId??null,q.actorUserId??null,q.action??null,q.resourceType??null,q.resourceId??null,q.from??null,q.to??null,financialResourceTypes,q.limit,q.offset]
  );
  const data=result.rows.map(row=>({id:row.id,actor:row.actor_user_id?{id:row.actor_user_id,name:row.actor_name}:null,legalEntityId:row.legal_entity_id,businessUnitId:row.business_unit_id,action:row.action,resourceType:row.resource_type,resourceId:row.resource_id,metadata:row.metadata,ipAddress:row.ip_address,userAgent:row.user_agent,createdAt:row.created_at}));
  return{data,meta:paginationMeta(q,result.rows.length)};
}
