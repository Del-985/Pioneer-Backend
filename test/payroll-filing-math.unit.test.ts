import assert from 'node:assert/strict';
import test from 'node:test';
import {filingFigures,type FilingPayment} from '../src/modules/employees/payroll-filing-math.js';
const wage=(v:Partial<FilingPayment>={}):FilingPayment=>({id:'one',personKey:'person',payDate:'2026-10-09',periodStart:'2026-09-28',periodEnd:'2026-10-05',gross:100000,federal:10000,ss:6200,medicare:1450,additional:0,employerSs:6200,employerMedicare:1450,ohio:1000,toledo:2500,school:1000,district:'4801',priorSs:0,priorMedicare:0,...v});
test('941 combines employer-wide payroll by payday and separates deposits from liability',()=>{
 const r=filingFigures([wage(),wage({id:'two',payDate:'2026-11-06',priorSs:100000,priorMedicare:100000}),wage({id:'outside',payDate:'2026-09-30'})],4,30000,1000);
 assert.equal(r.lines.line2,200000);assert.equal(r.lines.line12,50600);assert.equal(r.lines.line13,31000);assert.equal(r.lines.line14,19600);
 assert.equal(r.monthly.reduce((n,m)=>n+m.federalLiability,0),r.lines.line12);
 assert.equal(r.monthly[0]?.districts['4801'],1000);assert.equal(r.census,0);assert.deepEqual(r.problems,[]);
});
test('wage caps are derived from evidence, not reverse-engineered from rounded withholding',()=>{
 const r=filingFigures([wage({priorSs:18400000,priorMedicare:19950000,ss:3100,employerSs:3100,additional:450})],4,0,0);
 assert.equal(r.lines.line5aWages,50000);assert.equal(r.lines.line5dWages,50000);assert.equal(r.lines.line5dTax,450);assert.deepEqual(r.problems,[]);
});
test('fractions-of-cents adjustment applies only to employee share',()=>{
 const a=wage({gross:101,federal:0,ss:6,employerSs:6,medicare:1,employerMedicare:1,ohio:0,toledo:3,school:0});
 const r=filingFigures([a,{...a,id:'two',priorSs:101,priorMedicare:101}],4,0,0);
 assert.equal(r.lines.line5e,31);assert.equal(r.lines.line7,-2);assert.equal(r.lines.line12,29);
 assert.equal(r.monthly.reduce((n,m)=>n+m.federalLiability,0),29);
 assert.equal(r.lines.line13,0);
});
test('invalid withholding and unsafe totals are rejected, open-quarter census is not all employees',()=>{
 assert.equal(filingFigures([wage({ss:1})],4,0,0).problems.length,1);
 assert.throws(()=>filingFigures([wage({gross:Number.MAX_SAFE_INTEGER+1})],4,0,0));
 const r=filingFigures([wage({periodStart:'2026-12-07',periodEnd:'2026-12-14',payDate:'2026-12-18'})],4,0,0);
 assert.equal(r.census,1);assert.equal(filingFigures([],3,0,0).lines.line12,0);
});
