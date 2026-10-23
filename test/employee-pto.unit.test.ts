import test from 'node:test';
import assert from 'node:assert/strict';
import {detroitDate,addCalendarDays,validatePtoRange,ptoCreateSchema,ptoReviewSchema}
 from '../src/modules/employees/employee-pto.service.js';

function codeOf(code:string){
 return (err:unknown)=>Boolean(err&&typeof err==='object'&&'code' in err&&(err as {code:string}).code===code);
}
test('PTO uses calendar days for the seven-day advance notice',()=>{
 assert.equal(addCalendarDays('2026-10-23',7),'2026-10-30');
 assert.equal(addCalendarDays('2026-12-28',7),'2027-01-04');
 assert.equal(detroitDate(new Date('2026-10-23T02:00:00Z')),'2026-10-22');
 assert.doesNotThrow(()=>validatePtoRange('2026-10-30','2026-10-30',8,7,'2026-10-23'));
 assert.throws(()=>validatePtoRange('2026-10-29','2026-10-29',8,7,'2026-10-23'),codeOf('PTO_NOTICE_REQUIRED'));
 assert.throws(()=>validatePtoRange('2026-10-30','2026-10-29',8,7,'2026-10-23'),codeOf('PTO_DATE_RANGE'));
 assert.throws(()=>validatePtoRange('2026-10-30','2026-10-30',25,7,'2026-10-23'),codeOf('PTO_HOURS_RANGE'));
});
test('PTO request accepts only real dates and 15-minute time increments',()=>{
 const data={businessUnitId:'33333333-3333-4333-8333-333333333333',
   startDate:'2026-11-02',endDate:'2026-11-03',requestedHours:12,note:'Vacation'};
 assert.equal(ptoCreateSchema.parse(data).requestedHours,12);
 assert.equal(ptoCreateSchema.safeParse({...data,startDate:'2026-02-30'}).success,false);
 assert.equal(ptoCreateSchema.safeParse({...data,requestedHours:1.1}).success,false);
 assert.equal(ptoCreateSchema.safeParse({...data,requestedHours:-1}).success,false);
 assert.equal(ptoReviewSchema.safeParse({decision:'deny',note:''}).success,false);
 assert.equal(ptoReviewSchema.safeParse({decision:'approve',note:''}).success,true);
});
