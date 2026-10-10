-- Seed clearly named general-ledger accounts in each current legal entity.
-- Future entities can be configured in Books using identical account types.
-- Do not replace any existing account that already uses these account codes.
INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type,subtype)
SELECT id,'2150','Gross Wages Payable','liability','payroll_gross_payable'
FROM legal_entities
ON CONFLICT(legal_entity_id,code) DO NOTHING;
INSERT INTO ledger_accounts(legal_entity_id,code,name,account_type,subtype)
SELECT id,'6200','Gross Wage Expense','expense','payroll_gross_wages'
FROM legal_entities
ON CONFLICT(legal_entity_id,code) DO NOTHING;
