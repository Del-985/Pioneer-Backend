import { pool } from '../../db/pool.js';

type CustomerRow = {
  id: string;
  display_name: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  status: 'active' | 'inactive';
};

type AnyRecord = Record<string, any>;

export async function getIncomeCustomerSummary(
  businessUnitId: string,
  customerId: string | null | undefined
) {
  if (!customerId) return null;
  const result = await pool.query<CustomerRow>(
    `SELECT id,display_name,company_name,contact_name,email::text,phone,status
     FROM customers
     WHERE id=$1 AND business_unit_id=$2`,
    [customerId, businessUnitId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
  };
}

async function enrichOne(transaction: AnyRecord) {
  if (transaction?.type !== 'income') return transaction;
  const customerId = transaction?.details?.customerId;
  const customer = await getIncomeCustomerSummary(transaction.businessUnitId, customerId);
  return {
    ...transaction,
    customer,
    counterparty: customer?.displayName ?? transaction.counterparty ?? null,
    details: transaction.details ? { ...transaction.details, customer } : transaction.details,
  };
}

export async function enrichTransactionIncomeCustomer(value: unknown): Promise<any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as AnyRecord;
  if (record.transaction && typeof record.transaction === 'object') {
    return { ...record, transaction: await enrichOne(record.transaction) };
  }
  return enrichOne(record);
}
