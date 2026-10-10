import assert from 'node:assert/strict';
import test from 'node:test';
import {calculateTax2026,federalIncome2026,ohioIncomeAugust2026,centsRatio,
 SS_WAGE_BASE_CENTS,ADDITIONAL_MEDICARE_THRESHOLD_CENTS} from
 '../src/modules/employees/payroll-tax-math.js';

const election={
 federalStatus:'single' as const,federalTwoJobs:false,
 federalStep3CreditsCents:0,federalStep4aIncomeCents:0,
 federalStep4bDeductionsCents:0,federalStep4cExtraCents:0,
 ohioIt4Exemptions:1,schoolDistrictCode:'none',schoolDistrictBasis:'none' as const,
 schoolDistrictRateBps:0,toledoWorkplaceConfirmed:true,
};
function make(grossCents:number){
 return{grossCents,voluntaryDeductionsCents:0,reimbursementCents:0,
  reimbursementsVerifiedNonTaxable:false,payPeriods:26,periodEnd:'2026-10-05',
  periodYear:2026,election,history:{
    priorSocialSecurityWagesCents:0,priorMedicareWagesCents:0,
  }};
}
test('2026 IRS automated worksheet matches official annual brackets and Ohio computer method',()=>{
 const gross=192308; // $50,000 annualized for a 26-period worker
 assert.equal(federalIncome2026(gross,26,election),14692);
 assert.equal(ohioIncomeAugust2026(gross,26,1),4283);
 const result=calculateTax2026(make(gross));
 assert.equal(result.federalIncomeCents,14692);
 assert.equal(result.ohioIncomeCents,4283);
 assert.equal(result.toledoIncomeCents,4808);
 assert.equal(result.socialSecurityCents,11923);
 assert.equal(result.medicareCents,2788);
 assert.equal(result.additionalMedicareCents,0);
 assert.equal(result.employerSocialSecurityCents,11923);
 assert.equal(result.employerMedicareCents,2788);
 assert.equal(result.totalWithholdingCents,38494);
 assert.equal(result.projectedNetCents,153814);
 assert.equal(result.canDisburse,false);
 assert.equal(result.otherEmployerTaxesStatus,'not_calculated');
});
test('2026 federal W-4 adjustments and multiple-jobs checkbox alter results',()=>{
 const base=federalIncome2026(192308,26,election);
 assert.equal(federalIncome2026(192308,26,{...election,federalStep4cExtraCents:3500}),
  base+3500);
 assert.ok(federalIncome2026(192308,26,{...election,federalTwoJobs:true})>base);
 assert.ok(federalIncome2026(192308,26,{...election,
  federalStep3CreditsCents:200000})<base);
 assert.equal(federalIncome2026(0,26,{...election,federalStep4cExtraCents:500}),500);
});
test('Social Security wage base and Additional Medicare threshold use verified prior wages',()=>{
 const g=100000; // $1,000
 const priorSS=SS_WAGE_BASE_CENTS-50000;
 const priorMed=ADDITIONAL_MEDICARE_THRESHOLD_CENTS-50000;
 const r=calculateTax2026({...make(g),history:{
  priorSocialSecurityWagesCents:priorSS,priorMedicareWagesCents:priorMed,
 }});
 assert.equal(r.socialSecurityCents,3100);
 assert.equal(r.employerSocialSecurityCents,3100);
 assert.equal(r.additionalMedicareCents,450);
 const beyond=calculateTax2026({...make(g),history:{
  priorSocialSecurityWagesCents:SS_WAGE_BASE_CENTS+100000,
  priorMedicareWagesCents:ADDITIONAL_MEDICARE_THRESHOLD_CENTS+100000,
 }});
 assert.equal(beyond.socialSecurityCents,0);
 assert.equal(beyond.additionalMedicareCents,900);
 assert.equal(beyond.employerMedicareCents,1450);
});
test('Earned-income district rates and separate reimbursements are explicit inputs',()=>{
 const x=calculateTax2026({...make(100000),voluntaryDeductionsCents:1250,
  reimbursementCents:1500,reimbursementsVerifiedNonTaxable:true,
  election:{...election,schoolDistrictCode:'1234',schoolDistrictBasis:'earned_income',
    schoolDistrictRateBps:150}});
 assert.equal(x.schoolIncomeCents,1500);
 assert.equal(x.projectedNetCents,100000-x.totalWithholdingCents-1250+1500);
 assert.throws(()=>calculateTax2026({...make(100000),reimbursementCents:100}));
});
test('Unsupported jurisdictions, missing YTD, odd periods and unsafe withholding fail closed',()=>{
 assert.throws(()=>calculateTax2026({...make(10000),periodEnd:'2026-07-31'}));
 assert.throws(()=>calculateTax2026({...make(10000),periodYear:2027}));
 assert.throws(()=>calculateTax2026({...make(10000),payPeriods:24}));
 assert.throws(()=>calculateTax2026({...make(10000),election:{
  ...election,toledoWorkplaceConfirmed:false}}));
 assert.throws(()=>calculateTax2026({...make(10000),election:{
  ...election,schoolDistrictCode:'1234',schoolDistrictBasis:'traditional',
  schoolDistrictRateBps:150}}));
 assert.throws(()=>calculateTax2026({...make(10000),voluntaryDeductionsCents:20000}));
 assert.equal(centsRatio(199,250),5);
});

test('Ohio 2026 supplemental bonus withholding uses 2.75% instead of regular wage formula',()=>{
 const flat=calculateTax2026(make(100000));
 const supplement=calculateTax2026({
   ...make(100000),ohioSupplementalWagesCents:20000,
 });
 assert.equal(supplement.ohioSupplementalWagesCents,20000);
 assert.equal(supplement.ohioIncomeCents,1790);
 assert.equal(flat.ohioIncomeCents,1560);
 assert.equal(supplement.federalIncomeCents,flat.federalIncomeCents);
 assert.equal(supplement.toledoIncomeCents,flat.toledoIncomeCents);
 assert.equal(supplement.socialSecurityCents,flat.socialSecurityCents);
 assert.throws(()=>calculateTax2026({
   ...make(100000),ohioSupplementalWagesCents:100001,
 }),/supplemental wages/i);
});
