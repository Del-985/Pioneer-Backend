import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pool } from '../src/db/pool.js';
import {
  clockIn,startBreak,endBreak,clockOut,getEmployeeTimesheet,getAdminTimesheets,
  correctTimeEntry,managerCloseOpenTime,manualTimeEntry,reviewTimeEntry,
  getEntryHistory,validateWeekStart,mondayOfLocalWeek,mapTimeEntry,
} from '../src/modules/employees/employee-time.service.js';

const id={
  entity:randomUUID(),firstUnit:randomUUID(),otherUnit:randomUUID(),
  employeeUser:randomUUID(),otherUser:randomUUID(),manager:randomUUID(),viewer:randomUUID(),
  employee:randomUUID(),otherEmployee:randomUUID(),
};
function isError(code:number){
  return (err:unknown)=>typeof err==='object'&&err!==null&&'statusCode' in err&&err.statusCode===code;
}
after(async()=>{
  try{
    await pool.query('DELETE FROM employee_time_entries WHERE employee_id = ANY($1::uuid[])',
      [[id.employee,id.otherEmployee]]);
    await pool.query('DELETE FROM user_role_assignments WHERE user_id=$1',[id.manager]);
    await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])',[[id.employee,id.otherEmployee]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])',
      [[id.employeeUser,id.otherUser,id.manager,id.viewer]]);
    await pool.query('DELETE FROM business_units WHERE id = ANY($1::uuid[])',[[id.firstUnit,id.otherUnit]]);
    await pool.query('DELETE FROM legal_entities WHERE id=$1',[id.entity]);
  }finally{
    await pool.end();
  }
});

test('v0.3 time clock, break transitions, management review, corrections and audit isolation',async()=>{
  const slug='time-test-'+id.entity.slice(0,8);
  await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
    VALUES($1,'Time Clock Test','Time Clock Test',$2)`,[id.entity,slug]);
  await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
    VALUES($1,$3,'Time Unit 1',$4),($2,$3,'Time Unit 2',$5)`,
    [id.firstUnit,id.otherUnit,id.entity,slug+'-1',slug+'-2']);
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES
    ($1,$5,'Test Worker'),($2,$6,'Other Worker'),($3,$7,'Test Manager'),($4,$8,'Business Viewer')`,
    [id.employeeUser,id.otherUser,id.manager,id.viewer,slug+'-worker@example.com',
      slug+'-other@example.com',slug+'-manager@example.com',slug+'-viewer@example.com']);
  await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
    VALUES($1,$3,$5,'Test Worker','TIME-01'),($2,$4,$6,'Other Worker','TIME-02')`,
    [id.employee,id.otherEmployee,id.firstUnit,id.otherUnit,id.employeeUser,id.otherUser]);
  await pool.query(`INSERT INTO user_role_assignments(user_id,role_id,business_unit_id)
    SELECT $1,id,$2 FROM roles WHERE key='business_admin'`,[id.manager,id.firstUnit]);
  await pool.query(`INSERT INTO user_role_assignments(user_id,role_id,business_unit_id)
    SELECT $1,id,$2 FROM roles WHERE key='business_viewer'`,[id.viewer,id.firstUnit]);

  const start=(await clockIn(id.employeeUser,{businessUnitId:id.firstUnit})).data;
  assert.equal(start.reviewStatus,'open');
  assert.equal(start.employeeId,id.employee);
  assert.equal(start.workedHours,0);
  await assert.rejects(clockIn(id.employeeUser,{businessUnitId:id.firstUnit}),isError(409));
  await assert.rejects(startBreak(id.otherUser,id.firstUnit,false),isError(403));

  const b=(await startBreak(id.employeeUser,id.firstUnit,false)).data;
  assert.equal(b.breakPaid,false);
  assert.ok(b.breakStartedAt);
  await assert.rejects(startBreak(id.employeeUser,id.firstUnit,true),isError(409));
  const ended=(await endBreak(id.employeeUser,id.firstUnit)).data;
  assert.equal(ended.breakStartedAt,null);
  await assert.rejects(endBreak(id.employeeUser,id.firstUnit),isError(409));
  const paidBreak=(await startBreak(id.employeeUser,id.firstUnit,true)).data;
  assert.equal(paidBreak.breakPaid,true);
  const closed=(await clockOut(id.employeeUser,id.firstUnit)).data;
  assert.equal(closed.reviewStatus,'submitted');
  assert.equal(closed.clockOutAt instanceof Date,true);
  assert.equal(closed.breakStartedAt,null);
  assert.equal(closed.breakPaid,null);
  await assert.rejects(clockOut(id.employeeUser,id.firstUnit),isError(409));

  const week=mondayOfLocalWeek();
  assert.match(week,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(validateWeekStart(week),week);
  assert.throws(()=>validateWeekStart('2026-10-09'),isError(400));
  const own=await getEmployeeTimesheet(id.employeeUser,id.firstUnit,week);
  assert.equal(own.data.entries[0]?.id,start.id);
  assert.equal(own.data.summary.pendingCount,1);
  assert.equal(own.data.activeEntry,null);
  await assert.rejects(getEmployeeTimesheet(id.otherUser,id.firstUnit,week),isError(403));
  await assert.rejects(getAdminTimesheets(id.manager,id.otherUnit,{weekStart:week}),isError(403));
  await assert.rejects(getAdminTimesheets(id.viewer,id.firstUnit,{weekStart:week}),isError(403));


  const approved=(await reviewTimeEntry(id.manager,id.firstUnit,start.id,
    {decision:'approve',reason:'Verified against dispatch records'})).data;
  assert.equal(approved.reviewStatus,'approved');
  await assert.rejects(reviewTimeEntry(id.manager,id.firstUnit,start.id,
    {decision:'approve'}),isError(409));

  const clockInAt=new Date(start.clockInAt);
  const correctedStart=new Date(clockInAt.getTime()-2*60*60*1000);
  const correctedEnd=new Date(clockInAt.getTime()-15*60*1000);
  const corrected=(await correctTimeEntry(id.manager,id.firstUnit,start.id,{
    clockInAt:correctedStart.toISOString(),clockOutAt:correctedEnd.toISOString(),
    unpaidBreakMinutes:15,paidBreakMinutes:10,
    reason:'Corrected against the verified overnight job log',
  })).data;
  assert.equal(corrected.reviewStatus,'submitted');
  assert.equal(corrected.workedSeconds, (105-15)*60);
  assert.equal(corrected.paidBreakSeconds,10*60);
  assert.equal(corrected.unpaidBreakSeconds,15*60);
  await assert.rejects(correctTimeEntry(id.manager,id.firstUnit,start.id,{
    clockInAt:correctedStart.toISOString(),
    clockOutAt:new Date(correctedStart.getTime()-1000).toISOString(),
    reason:'Invalid reversed clock-out time',
  }),isError(400));

  const returned=(await reviewTimeEntry(id.manager,id.firstUnit,start.id,{
    decision:'return',reason:'Please check the start time against the schedule',
  })).data;
  assert.equal(returned.reviewStatus,'returned');
  assert.equal((await reviewTimeEntry(id.manager,id.firstUnit,start.id,{
    decision:'approve',reason:'Verified after manual review',
  })).data.reviewStatus,'approved');
  const history=await getEntryHistory(id.manager,id.firstUnit,start.id);
  assert.ok(history.data.some(x=>x.action==='clock_in'));
  assert.ok(history.data.some(x=>x.action==='break_start'));
  assert.ok(history.data.some(x=>x.action==='break_end'));
  assert.ok(history.data.some(x=>x.action==='clock_out'));
  assert.ok(history.data.some(x=>x.action==='manager_correct'));
  assert.ok(history.data.some(x=>x.action==='manager_approve'));
  await assert.rejects(getEntryHistory(id.manager,id.otherUnit,start.id),isError(403));

  // Historical overnight shift across the 2026 DST spring-forward transition:
  // 00:30 EST to 03:30 EDT is exactly two hours, not three.
  const manual=(await manualTimeEntry(id.manager,id.firstUnit,{
    employeeId:id.employee,
    clockInAt:'2026-03-08T00:30:00-05:00',
    clockOutAt:'2026-03-08T03:30:00-04:00',
    paidBreakMinutes:0,unpaidBreakMinutes:30,
    reason:'Supervisor verified missing overnight shift from dispatch notes',
  })).data;
  assert.equal(manual.elapsedSeconds,7200);
  assert.equal(manual.workedSeconds,5400);
  assert.equal(manual.reviewStatus,'submitted');
  const historical=await getEmployeeTimesheet(id.employeeUser,id.firstUnit,'2026-03-02');
  assert.equal(historical.data.entries[0]?.id,manual.id);
  assert.equal(historical.data.summary.pendingSeconds,5400);
  await assert.rejects(manualTimeEntry(id.manager,id.firstUnit,{
    employeeId:id.employee,clockInAt:'2026-03-08T01:00:00-05:00',
    clockOutAt:'2026-03-08T01:30:00-05:00',
    reason:'Attempted overlapping manual shift entry',
    paidBreakMinutes:0,unpaidBreakMinutes:0,
  }),isError(409));

  const missed=(await clockIn(id.employeeUser,{businessUnitId:id.firstUnit})).data;
  await pool.query(`UPDATE employee_time_entries SET clock_in_at=now()-interval '18 hours'
    WHERE id=$1`,[missed.id]);
  const alerts=await getAdminTimesheets(id.manager,id.firstUnit,{weekStart:week});
  assert.ok(alerts.data.missedClockOuts.some(x=>x.id===missed.id));
  const original=alerts.data.missedClockOuts.find(x=>x.id===missed.id)!;
  assert.equal(original.missedClockOut,true);
  const resolved=(await managerCloseOpenTime(id.manager,id.firstUnit,missed.id,{
    clockOutAt:new Date(new Date(original.clockInAt).getTime()+4*3600000).toISOString(),
    unpaidBreakMinutes:0,paidBreakMinutes:0,
    reason:'Employee forgot to clock out after snow clearing',
  })).data;
  assert.equal(resolved.reviewStatus,'submitted');
  assert.equal(resolved.workedSeconds,4*3600);
  assert.equal((await getEmployeeTimesheet(id.employeeUser,id.firstUnit,week)).data.activeEntry,null);

  await assert.rejects(manualTimeEntry(id.manager,id.firstUnit,{
    employeeId:id.employee,
    clockInAt:new Date(Date.now()+3600000).toISOString(),
    clockOutAt:new Date(Date.now()+7200000).toISOString(),
    reason:'Should not allow recording hours from a future shift',
    unpaidBreakMinutes:0,paidBreakMinutes:0,
  }),isError(400));

  // An open shift is never silently finalized merely because it exceeds 16 hours.
  const artificial=mapTimeEntry({
    ...(await pool.query('SELECT t.*,e.display_name AS employee_name FROM employee_time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.id=$1',[missed.id])).rows[0],
    clock_out_at:null,clock_in_at:new Date('2026-01-01T00:00:00Z'),
    active_break_started_at:null,active_break_paid:null,unpaid_break_seconds:0,paid_break_seconds:0,
  },new Date('2026-01-01T18:00:00Z'));
  assert.equal(artificial.missedClockOut,true);

  await assert.rejects(clockIn(id.otherUser,{businessUnitId:id.firstUnit}),isError(403));
  await assert.rejects(reviewTimeEntry(id.manager,id.otherUnit,manual.id,
    {decision:'approve'}),isError(403));
});
