import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import { employeeJob, employeeJobs, employeeProfile } from '../src/modules/employees/employee-portal.service.js';
import { getMyReport,updateMyJob,reviewReport } from '../src/modules/employees/employee-field.service.js';
import { saveAvailability,listAvailability,respondToShift } from '../src/modules/employees/employee-scheduling.service.js';
import { createRoute } from '../src/modules/employees/employee-routes.service.js';

const ids = {
  entity: randomUUID(),
  firstUnit: randomUUID(),
  secondUnit: randomUUID(),
  staff: randomUUID(),
  manager: randomUUID(),
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
      [[ids.staff, ids.otherUser, ids.manager]]);
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
  await pool.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,\'Test Manager\')',
    [ids.manager, 'employee-test-manager-' + ids.manager + '@example.com']);
  await pool.query(`INSERT INTO user_role_assignments(user_id,role_id,business_unit_id)
    SELECT $1,id,$2 FROM roles WHERE key='business_admin'`,
    [ids.manager,ids.firstUnit]);
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

  // v0.2: worker can report only against assigned jobs; manager approval is separate.
  await assert.rejects(
    updateMyJob(ids.staff, ids.otherJob, { action: 'start' }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404
  );
  assert.equal((await updateMyJob(ids.staff, ids.assignedJob, { action:'acknowledge' })).data.status,'acknowledged');
  assert.equal((await updateMyJob(ids.staff, ids.assignedJob, { action:'start' })).data.status,'in_progress');
  assert.equal((await updateMyJob(ids.staff, ids.assignedJob, {
    action:'submit',completionNotes:'Driveway cleared',saltApplied:true,saltAmountLbs:3,
  })).data.status,'submitted');
  assert.equal((await getMyReport(ids.staff, ids.assignedJob)).data?.status,'submitted');
  assert.equal((await pool.query<{status:string}>('SELECT status FROM work_orders WHERE id=$1',
    [ids.assignedJob])).rows[0]?.status,'in_progress',
    'Worker-submitted jobs must await management approval');
  await assert.rejects(
    updateMyJob(ids.staff, ids.assignedJob, { action:'submit' }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409
  );

  const pending=(await getMyReport(ids.staff,ids.assignedJob)).data!;
  assert.equal((await reviewReport(ids.manager,ids.firstUnit,pending.id,
    { decision:'approve',managerNotes:'Cleared for closeout' })).data.status,'approved');
  assert.equal((await pool.query<{status:string}>('SELECT status FROM work_orders WHERE id=$1',
    [ids.assignedJob])).rows[0]?.status,'completed',
    'Manager approval should close a single-worker job');

  // Availability supports overnight ranges and cannot be written into other units.
  await saveAvailability(ids.staff, { businessUnitId:ids.firstUnit,
    slots:[{weekday:5,startTime:'21:00',endTime:'06:00',available:true,notes:'Overnight'}] });
  const available=await listAvailability(ids.staff,ids.firstUnit,true);
  assert.equal(available.data.length,1);
  assert.equal(available.data[0]?.startTime,'21:00:00');
  await assert.rejects(
    saveAvailability(ids.staff,{businessUnitId:ids.secondUnit,slots:[]}),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 403
  );

  // Shift capacity is enforced server-side, even with an offered second worker.
  const shiftId=(await pool.query<{id:string}>(`
    INSERT INTO employee_shifts(business_unit_id,title,starts_at,ends_at,capacity)
    VALUES($1,'Overnight snow',now()+interval '1 day',now()+interval '2 days',1)
    RETURNING id`,[ids.firstUnit])).rows[0]!.id;
  await pool.query(`
    INSERT INTO employee_shift_offers(shift_id,business_unit_id,employee_id)
    VALUES($1,$2,$3),($1,$2,$4)`,
    [shiftId,ids.firstUnit,ids.firstEmployee,ids.otherEmployee]);
  assert.equal((await respondToShift(ids.staff,shiftId,'accepted')).status,'accepted');
  await assert.rejects(
    respondToShift(ids.otherUser,shiftId,'accepted'),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409
  );

  // Route crew members may read jobs shared with their crew, but nobody else.
  const route=await createRoute(ids.manager,ids.firstUnit,{
    name:'Test Route',startsAt:null,notes:null,
    employeeIds:[ids.otherEmployee],workOrderIds:[ids.assignedJob],
  });
  assert.ok(route.id);
  await assert.rejects(
    createRoute(ids.manager,ids.firstUnit,{
      name:'Cross-unit Route',employeeIds:[ids.otherUnitEmployee],workOrderIds:[],
    }),
    (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400
  );
  assert.equal((await employeeJob(ids.otherUser,ids.assignedJob)).id,ids.assignedJob);

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
