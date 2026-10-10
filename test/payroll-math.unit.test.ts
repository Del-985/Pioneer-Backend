import assert from 'node:assert/strict';
import test from 'node:test';
import {calculateGrossLines,payrollLineCents,localWeekKey} from '../src/modules/employees/payroll-math.js';

test('integer-cent gross payroll rounds and splits overtime after 40 clock-in-week hours',()=>{
  const person='person-A';
  const mk=(id:string,start:string,seconds:number)=>({
    id,employeeId:'staff-A',businessUnitId:'unit-1',personKey:person,
    clockInAt:new Date(start),workedSeconds:seconds,hourlyCents:2000,
    multiplierBps:15000,rateId:'rate-one',
  });
  const entries=calculateGrossLines([
    mk('b','2026-03-03T15:00:00Z',25*3600),
    mk('a','2026-03-02T15:00:00Z',20*3600),
  ]);
  assert.deepEqual(entries.map(x=>[x.id,x.regularSeconds,x.overtimeSeconds,x.grossCents]),[
    ['a',20*3600,0,40000],
    ['b',20*3600,5*3600,55000],
  ]);
  assert.equal(entries.reduce((total,x)=>total+x.grossCents,0),95000);
  assert.equal(payrollLineCents(1800,1999),1000);
  assert.equal(payrollLineCents(3600,2000,15000),3000);
});
test('payroll carries different shifts in a new workweek to a fresh threshold',()=>{
  const rows=calculateGrossLines([
    {id:'one',employeeId:'a',businessUnitId:'u',personKey:'person',
      rateId:'r',clockInAt:new Date('2026-03-07T13:00:00Z'),workedSeconds:42*3600,
      hourlyCents:1800,multiplierBps:15000},
    {id:'two',employeeId:'a',businessUnitId:'u',personKey:'person',
      rateId:'r',clockInAt:new Date('2026-03-09T13:00:00Z'),workedSeconds:8*3600,
      hourlyCents:1800,multiplierBps:15000},
  ]);
  assert.equal(rows[0]?.overtimeSeconds,7200);
  assert.equal(rows[1]?.overtimeSeconds,0);
  assert.equal(localWeekKey(new Date('2026-03-08T06:59:00Z')),'2026-03-02');
  assert.equal(localWeekKey(new Date('2026-03-09T06:00:00Z')),'2026-03-09');
});
