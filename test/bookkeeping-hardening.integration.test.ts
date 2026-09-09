import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import { listBookkeepingAccountsForBusinessUnit } from '../src/modules/bookkeeping/account-response.service.js';
import { bookkeepingAccountListQuerySchema } from '../src/modules/bookkeeping/accounts.schemas.js';
import { enrichTransactionIncomeCustomer } from '../src/modules/bookkeeping/income-customer.service.js';
import {
  createLegacyBookkeepingMileage,
  listBookkeepingMileageCompat,
} from '../src/modules/bookkeeping/mileage-compat.service.js';
import { createTransactionSchema } from '../src/modules/bookkeeping/transaction.schemas.js';
import {
  createBookkeepingTransaction,
  getBookkeepingTransaction,
  postBookkeepingTransaction,
} from '../src/modules/bookkeeping/transaction.service.js';

const ids = {
  entity: randomUUID(),
  unit: randomUUID(),
  otherUnit: randomUUID(),
  user: randomUUID(),
  cash: randomUUID(),
  savings: randomUUID(),
  revenue: randomUUID(),
  expense: randomUUID(),
  customer: randomUUID(),
  otherCustomer: randomUUID(),
};

after(async () => {
  await pool.query(`DELETE FROM mileage_logs WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM vehicles WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM bookkeeping_transfers WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM revenue_records WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM journal_entries WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM customers WHERE business_unit_id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM ledger_accounts WHERE legal_entity_id=$1`, [ids.entity]);
  await pool.query(`DELETE FROM audit_log WHERE actor_user_id=$1 OR business_unit_id IN ($2,$3)`, [ids.user, ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM user_role_assignments WHERE user_id=$1`, [ids.user]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [ids.user]);
  await pool.query(`DELETE FROM business_units WHERE id IN ($1,$2)`, [ids.unit, ids.otherUnit]);
  await pool.query(`DELETE FROM legal_entities WHERE id=$1`, [ids.entity]);
  await pool.end();
});

async function seed() {
  await pool.query(
    `INSERT INTO legal_entities (id,legal_name,display_name,slug)
     VALUES ($1,'Hardening Test Entity','Hardening Test Entity',$2)`,
    [ids.entity, `hardening-${ids.entity.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO business_units (id,legal_entity_id,name,slug)
     VALUES
       ($1,$3,'Hardening Unit',$4),
       ($2,$3,'Other Hardening Unit',$5)`,
    [
      ids.unit,
      ids.otherUnit,
      ids.entity,
      `hardening-unit-${ids.unit.slice(0, 8)}`,
      `hardening-other-${ids.otherUnit.slice(0, 8)}`,
    ]
  );
  await pool.query(
    `INSERT INTO users (id,email,display_name,password_hash)
     VALUES ($1,$2,'Hardening Test User','test-only')`,
    [ids.user, `hardening-${ids.user.slice(0, 8)}@example.com`]
  );
  await pool.query(
    `INSERT INTO user_role_assignments (user_id,role_id)
     SELECT $1,id FROM roles WHERE key='platform_admin'`,
    [ids.user]
  );
  await pool.query(
    `INSERT INTO ledger_accounts (id,legal_entity_id,code,name,account_type)
     VALUES
       ($1,$5,'1000','Cash','asset'),
       ($2,$5,'1010','Savings','asset'),
       ($3,$5,'4000','Service Revenue','revenue'),
       ($4,$5,'5000','Operating Expense','expense')`,
    [ids.cash, ids.savings, ids.revenue, ids.expense, ids.entity]
  );
  await pool.query(
    `INSERT INTO customers (id,business_unit_id,display_name,email)
     VALUES
       ($1,$3,'Primary Customer','primary@example.com'),
       ($2,$4,'Other Customer','other@example.com')`,
    [ids.customer, ids.otherCustomer, ids.unit, ids.otherUnit]
  );
}

test('bookkeeping hardening enforces account/customer scope and supports legacy mileage', async () => {
  await seed();

  await assert.rejects(
    createBookkeepingTransaction(
      ids.user,
      createTransactionSchema.parse({
        type: 'transfer',
        businessUnitId: ids.unit,
        transactionDate: '2026-09-09',
        description: 'Invalid revenue to savings transfer',
        amountCents: 1000,
        fromAccountId: ids.revenue,
        toAccountId: ids.savings,
      })
    ),
    /source account must be an asset or liability/i
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO revenue_records (
         legal_entity_id,business_unit_id,revenue_date,customer_id,description,amount_cents,
         revenue_account_id,deposit_account_id
       ) VALUES ($1,$2,'2026-09-09',$3,'Cross-unit customer',1000,$4,$5)`,
      [ids.entity, ids.unit, ids.otherCustomer, ids.revenue, ids.cash]
    ),
    /same business unit/i
  );

  const income = await createBookkeepingTransaction(
    ids.user,
    createTransactionSchema.parse({
      type: 'income',
      businessUnitId: ids.unit,
      transactionDate: '2026-09-09',
      description: 'Customer payment',
      amountCents: 5000,
      customerId: ids.customer,
      incomeAccountId: ids.revenue,
      depositAccountId: ids.cash,
    })
  );
  await postBookkeepingTransaction(ids.user, income.id, {
    businessUnitId: ids.unit,
    entryNumber: 'INC-HARDENING-1',
  });

  const enriched = await enrichTransactionIncomeCustomer(
    await getBookkeepingTransaction(ids.user, income.id)
  );
  assert.equal(enriched.customer?.id, ids.customer);
  assert.equal(enriched.customer?.displayName, 'Primary Customer');
  assert.equal(enriched.counterparty, 'Primary Customer');

  const accounts = await listBookkeepingAccountsForBusinessUnit(
    ids.user,
    ids.unit,
    bookkeepingAccountListQuerySchema.parse({ limit: 100, offset: 0 })
  );
  const cash = accounts.data.find((account) => account.id === ids.cash);
  assert.equal(cash?.balanceCents, 5000);
  assert.equal(cash?.normalBalance, 'debit');
  assert.equal(cash?.accountTypeMutable, false);

  const mileage = await createLegacyBookkeepingMileage(ids.user, {
    businessUnitId: ids.unit,
    date: '2026-09-09',
    vehicle: 'Work Truck',
    purpose: 'Supply run',
    startOdometer: 1000,
    endOdometer: 1012.5,
  });
  assert.equal(mileage.date, '2026-09-09');
  assert.equal(mileage.vehicle, 'Work Truck');
  assert.equal(mileage.miles, 12.5);
  assert.ok(mileage.vehicleId);

  const mileageRows = await listBookkeepingMileageCompat(ids.user, {
    businessUnitId: ids.unit,
    limit: 100,
    offset: 0,
  });
  assert.equal(mileageRows.data.length, 1);
  assert.equal(mileageRows.data[0]?.vehicle, 'Work Truck');
  assert.equal(mileageRows.data[0]?.businessUnitName, 'Hardening Unit');
});
