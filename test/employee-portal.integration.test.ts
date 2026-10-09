import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import { employeeJob, employeeJobs, employeeProfile } from '../src/modules/employees/employee-portal.service.js';

const ids = {
  entity: randomUUID(),
  firstUnit: randomUUID(),
  secondUnit: randomUUID(),
  staff: randomUUID(),
  otherUser: randomUUID(),
  firstEmployee: randomUUID(),
  otherEmployee: randomUUID(),
  otherUnitEmployee: randomUUID(),
  firstCustomer: randomUUID(),
  secondCustomer: randomUUID(),
  assignedJob: randomUUID(),
  otherJob: randomUUID(),
  otherUnitJob: randomUUID(),
};

after(async () => {
  try {
    await pool.query('DELETE FROM work_orders WHERE id = ANY($1::uuid[])',
      [[ids.assignedJob, ids.otherJob, ids.otherUnitJob]]);
    await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])',
      [[ids.firstEmployee, ids.otherEmployee, ids.otherUnitEmployee]]);
    await pool.query('DELETE FROM customers WHERE id = ANY($1::uuid[])',
      [[ids.firstCustomer, ids.secondCustomer]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])',
      [[ids.staff, ids.otherUser]]);
    await pool.query('DELETE FROM business_units WHERE id = ANY($1::uuid[])',
      [[ids.firstUnit, ids.secondUnit]]);
    await pool.query('DELETE FROM legal_entities WHERE id = $1', [ids.entity]);
  } finally {
    await pool.end();
  }
});

test('employee self-service enforces identity, assignment, status and business-unit isolation', async () => {
  await pool.query(
    "INSERT INTO legal_entities (id, legal_name, display_name, slug) VALUES ($1,'Employee Test Entity','Employee Test Entity',$2)",
    [ids.entity, 'employee-test-' + ids.entity.slice(0, 8)]
  );
  await pool.query(
    `INSERT INTO business_units (id, legal_entity_id, name, slug)
     VALUES ($1, $3, 'First Employee Unit', $4), ($2, $3, 'Second Employee Unit', $5)`,
    [ids.firstUnit, ids.secondUnit, ids.entity,
      'employee-first-' + ids.firstUnit.slice(0, 8),
      'employee-second-' + ids.secondUnit.slice(0, 8)]
  );
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES
      ($1, $3, 'Assigned Staff'), ($2, $4, 'Different Employee')`,
    [ids.staff, ids.otherUser,
      'employee-test-' + ids.staff + '@example.com',
      'employee-test-' + ids.otherUser + '@example.com']
  );
  await pool.query(
    `INSERT INTO customers (id, business_unit_id, display_name) VALUES
       ($1, $3, 'First Customer'), ($2, $4, 'Second Customer')`,
    [ids.firstCustomer, ids.secondCustomer, ids.firstUnit, ids.secondUnit]
  );
  await pool.query(
    `INSERT INTO employees (id, business_unit_id, user_id, display_name, email, employee_number) VALUES
       ($1, $4, $6, 'Assigned Staff', 'staff@example.com', 'TEST-001'),
       ($2, $4, $7, 'Different Staff', 'different@example.com', 'TEST-002'),
       ($3, $5, $7, 'Other Unit Staff', 'otherunit@example.com', 'TEST-003')`,
    [ids.firstEmployee, ids.otherEmployee, ids.otherUnitEmployee,
      ids.firstUnit, ids.secondUnit, ids.staff, ids.otherUser]
  );
  await pool.query(
    `INSERT INTO work_orders (
        id, business_unit_id, customer_id, assigned_employee_id, work_order_number, title, status
     ) VALUES
       ($1, $4, $6, $8, 'STAFF-ONE', 'My Assigned Job', 'scheduled'),
       ($2, $4, $6, $9, 'STAFF-TWO', 'Someone Else Job', 'scheduled'),
       ($3, $5, $7, $10, 'STAFF-THREE', 'Other Business Job', 'scheduled')`,
    [ids.assignedJob, ids.otherJob, ids.otherUnitJob,
      ids.firstUnit, ids.secondUnit, ids.firstCustomer, ids.secondCustomer,
      ids.firstEmployee, ids.otherEmployee, ids.otherUnitEmployee]
  );

  const profile = await employeeProfile(ids.staff, {
    email: 'staff@example.com',
    displayName: 'Assigned Staff',
  });
  assert.equal(profile.employment.length, 1);
  assert.equal(profile.employment[0]?.businessUnitId, ids.firstUnit);

  const jobs = await employeeJobs(ids.staff, { limit: 50, offset: 0 });
  assert.deepEqual(jobs.data.map((row) => row.id), [ids.assignedJob]);
  assert.equal(jobs.data[0]?.workOrderNumber, 'STAFF-ONE');
  assert.equal((await employeeJob(ids.staff, ids.assignedJob)).id, ids.assignedJob);

  await assert.rejects(
    employeeJob(ids.staff, ids.otherJob),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
  await assert.rejects(
    employeeJob(ids.staff, ids.otherUnitJob),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
  await assert.rejects(
    employeeJobs(ids.staff, { limit: 50, offset: 0, businessUnitId: ids.secondUnit }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403
  );

  await pool.query("UPDATE employees SET status='terminated' WHERE id=$1", [ids.firstEmployee]);
  await assert.rejects(
    employeeProfile(ids.staff, { email: 'staff@example.com', displayName: 'Assigned Staff' }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403
  );
  await assert.rejects(
    employeeJobs(ids.staff, { limit: 50, offset: 0 }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403
  );
});
