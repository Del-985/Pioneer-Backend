import assert from 'node:assert/strict';
import test from 'node:test';
import {calculateTax2026,federalIncome2026,ohioIncomeAugust2026,centsRatio,
 calculateEmployerTaxes,SS_WAGE_BASE_CENTS,ADDITIONAL_MEDICARE_THRESHOLD_CENTS} from
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
  reimbursementsVerifiedNonTaxable:false,payPeriods:26,payDate:'2026-10-09',election,history:{
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
 assert.throws(()=>calculateTax2026({...make(10000),payDate:'2026-07-31'}));
 assert.throws(()=>calculateTax2026({...make(10000),payDate:'2027-01-01'}));
 assert.throws(()=>calculateTax2026({...make(10000),payPeriods:24}));
 assert.throws(()=>calculateTax2026({...make(10000),election:{
  ...election,toledoWorkplaceConfirmed:false}}));

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

const employerTaxes={ohioUiRateBps:285,futaEffectiveRateBps:60,verified:true,
 recordReference:'2026 assigned Ohio rate notice and verified FUTA credit eligibility'};
test('Traditional district exemptions differ from earned-income districts and never create negative tax',()=>{
 const input={...make(100000),election:{...election,schoolDistrictCode:'1234',
  schoolDistrictBasis:'traditional' as const,schoolDistrictRateBps:150}};
 assert.equal(calculateTax2026(input).schoolIncomeCents,1463); // ($1000 - $25) * 1.5%
 assert.equal(calculateTax2026({...input,payPeriods:52}).schoolIncomeCents,1481);
 assert.equal(calculateTax2026({...input,grossCents:1000}).schoolIncomeCents,0);
 assert.equal(calculateTax2026({...input,election:{...input.election,schoolDistrictBasis:'earned_income'}}).schoolIncomeCents,1500);
});
test('Current-year federal exemption affects federal income only and Ohio extra withholding is honored',()=>{
 const input={...make(100000),election:{...election,federalExempt:true,
  federalExemptionYear:2026,ohioExtraCents:500}};
 const r=calculateTax2026(input);
 assert.equal(r.federalIncomeCents,0);
 assert.equal(r.ohioIncomeCents,2060);
 assert.equal(r.socialSecurityCents,6200);
 assert.equal(r.medicareCents,1450);
 assert.equal(r.toledoIncomeCents,2500);
 assert.throws(()=>calculateTax2026({...input,election:{...input.election,federalExemptionYear:2025}}));
 assert.throws(()=>calculateTax2026({...input,election:{...input.election,federalStep4cExtraCents:1}}));
});
test('Actual payday selects the tax year and invalid calendar dates are rejected',()=>{
 assert.throws(()=>calculateTax2026({...make(100000),payDate:'2027-01-02'}));
 assert.throws(()=>calculateTax2026({...make(100000),payDate:'2026-09-31'}));
 assert.throws(()=>calculateTax2026({...make(100000),payDate:'2026-07-31'}));
 assert.doesNotThrow(()=>calculateTax2026({...make(100000),payDate:'2026-08-01'}));
});
test('Employer unemployment uses independent wage bases without changing take-home pay',()=>{
 const base=make(100000),history={...base.history,priorFutaWagesCents:650000,priorOhioUiWagesCents:875000};
 const r=calculateTax2026({...base,history,employerTaxes});
 assert.equal(r.employerFutaCents,300);
 assert.equal(r.employerOhioUiCents,713);
 assert.equal(r.projectedNetCents,calculateTax2026(base).projectedNetCents);
 assert.equal(r.otherEmployerTaxesStatus,'calculated_from_verified_rates');
 assert.equal(calculateEmployerTaxes(100000,{...history,priorFutaWagesCents:700000,priorOhioUiWagesCents:900000},employerTaxes).employerFutaCents,0);
 assert.equal(calculateEmployerTaxes(100000,history,{...employerTaxes,futaEffectiveRateBps:600}).employerFutaCents,3000);
 assert.throws(()=>calculateTax2026({...base,employerTaxes}));
 assert.throws(()=>calculateTax2026({...base,history,employerTaxes:{...employerTaxes,verified:false}}));
 assert.throws(()=>calculateTax2026({...base,history,employerTaxes:{...employerTaxes,futaEffectiveRateBps:0}}));
});
