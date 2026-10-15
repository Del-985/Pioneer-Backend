import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {env} from '../src/config/env.js';
import {pool} from '../src/db/pool.js';
import {createPayrollScenario} from '../src/modules/sandbox/scenario.js';
import {filingContext,prepareFiling,reviewFiling,download941} from '../src/modules/employees/payroll-filing.service.js';
import {listPayments,paymentStatement} from '../src/modules/employees/payroll-payments.service.js';
import {processEmailNotifications,processSmsNotifications} from '../src/modules/notifications/notification-delivery.service.js';
test('isolated sandbox produces practice payroll and filing without outbound delivery',{skip:env.APP_ENV!=='sandbox'},async()=>{
 try{
  const user=randomUUID();await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'TEST Manager')",[user,user+'@example.invalid']);
  await pool.query("INSERT INTO user_role_assignments(user_id,role_id) SELECT $1,id FROM roles WHERE key='platform_admin'",[user]);
  const scenario=await createPayrollScenario(user);
  const context=(await filingContext(user,scenario.businessUnitId,3)).data;
  assert.equal(context.paymentCount,1);
  const pay=(await listPayments(user,scenario.businessUnitId)).data[0]!;
  assert.match((await paymentStatement(user,scenario.businessUnitId,pay.id)).data.html,/TEST ONLY/);
  const packet=(await prepareFiling(user,scenario.businessUnitId,{year:2026,quarter:3,ein:'123456789',street:'101 Test Street',city:'Toledo',state:'OH',zip:'43604',signerName:'Test Manager',signerTitle:'Owner',phone:'419-555-0100',depositSchedule:'monthly',priorQuarterTaxCents:0,federalDepositIds:[],censusEmployees:1,allWagesIncluded:true,ordinaryPayrollOnly:true,form941Required:true,originalReturn:true,depositsReconciled:true,censusVerified:true,applyOverpaymentToNextReturn:true,reviewReference:'TEST ONLY - fictional complete payroll reconciliation'})).data;
  assert.equal(packet.figures.lines.line2,80000);assert.deepEqual(packet.blockers,[]);
  await reviewFiling(user,scenario.businessUnitId,packet.id);
  assert.ok((await download941(user,scenario.businessUnitId,packet.id)).pdf.length>10000);
  assert.equal((await processEmailNotifications()).sent,0);assert.equal((await processSmsNotifications()).sent,0);
 }finally{await pool.end();}
});
