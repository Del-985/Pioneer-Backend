// 2026 internal tax-withholding REVIEW arithmetic.
// Primary references:
// IRS Publication 15-T (2026), Worksheet 1A and Automated Payroll tables:
// https://www.irs.gov/publications/p15t
// IRS Publication 15 (2026) Social Security and Medicare:
// https://www.irs.gov/publications/p15
// Ohio Optional Computer Formula, effective 2026-08-01:
// https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/employer_withholding/2026%20Withholding%20Tables/WHT_OptionalComputerFormula_2026.pdf
// Toledo 2.5% qualifying wages: https://toledo.oh.gov/pay-taxes
// Returns tax estimates; never authorizes money movement or filing.
export const RULE_SET='2026-federal-ohio-aug-toledo-v2' as const;
export const SS_WAGE_BASE_CENTS=18_450_000;
export const ADDITIONAL_MEDICARE_THRESHOLD_CENTS=20_000_000;
type FilingStatus='single'|'married_joint'|'head_of_household';
export type Election={
 federalStatus:FilingStatus;federalTwoJobs:boolean;
 federalExempt?:boolean;federalExemptionYear?:number;ohioExtraCents?:number;
 federalStep3CreditsCents:number;federalStep4aIncomeCents:number;
 federalStep4bDeductionsCents:number;federalStep4cExtraCents:number;
 ohioIt4Exemptions:number;
 schoolDistrictCode:string;schoolDistrictBasis:'none'|'earned_income'|'traditional';
 schoolDistrictRateBps:number;toledoWorkplaceConfirmed:boolean;
};
export type WageHistory={priorSocialSecurityWagesCents:number;priorMedicareWagesCents:number;
 priorFutaWagesCents?:number;priorOhioUiWagesCents?:number};
export type EmployerTaxSettings={
 ohioUiRateBps:number;futaEffectiveRateBps:number;verified:boolean;recordReference:string;
};
export type TaxInput={
 grossCents:number;voluntaryDeductionsCents:number;reimbursementCents:number;
 // Bonuses, commissions and retroactive payments may require Ohio's
 // supplemental withholding rate rather than regular wage tables.
 ohioSupplementalWagesCents?:number;
 payPeriods:number;payDate:string;
 employerTaxes?:EmployerTaxSettings;
 election:Election;history:WageHistory;
 reimbursementsVerifiedNonTaxable:boolean;
};
type Band={from:number;base:number;rate:number};
const bands:{[status in FilingStatus]:{normal:Band[];twoJobs:Band[]}}={
 married_joint:{
  normal:[[0,0,0],[19300,0,0.10],[44100,2480,0.12],[120100,11600,0.22],
    [230700,35932,0.24],[422850,82048,0.32],[531750,116896,0.35],
    [788000,206583.50,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
  twoJobs:[[0,0,0],[16100,0,0.10],[28500,1240,0.12],[66500,5800,0.22],
    [121800,17966,0.24],[217875,41024,0.32],[272325,58448,0.35],
    [400450,103291.75,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
 },
 single:{
  normal:[[0,0,0],[7500,0,0.10],[19900,1240,0.12],[57900,5800,0.22],
    [113200,17966,0.24],[209275,41024,0.32],[263725,58448,0.35],
    [648100,192979.25,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
  twoJobs:[[0,0,0],[8050,0,0.10],[14250,620,0.12],[33250,2900,0.22],
    [60900,8983,0.24],[108938,20512,0.32],[136163,29224,0.35],
    [328350,96489.63,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
 },
 head_of_household:{
  normal:[[0,0,0],[15550,0,0.10],[33250,1770,0.12],[83000,7740,0.22],
    [121250,16155,0.24],[217300,39207,0.32],[271750,56631,0.35],
    [656150,191171,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
  twoJobs:[[0,0,0],[12075,0,0.10],[20925,885,0.12],[45800,3870,0.22],
    [64925,8077.50,0.24],[112950,19603.50,0.32],[140175,28315.50,0.35],
    [332375,95585.50,0.37]].map(([from,base,rate])=>({from:from!,base:base!,rate:rate!})),
 },
};
export function centsRatio(cents:number,bps:number,denom=10000):number{
 if(!Number.isSafeInteger(cents)||cents<0||!Number.isSafeInteger(bps)||bps<0||
  !Number.isSafeInteger(denom)||denom<=0)throw new Error('Invalid tax arithmetic');
 const result=(BigInt(cents)*BigInt(bps)+BigInt(denom)/2n)/BigInt(denom);
 if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Unsafe payroll tax amount');
 return Number(result);
}
export function federalIncome2026(wageCents:number,periods:number,e:Election){
 if(![52,26].includes(periods))throw new Error('Unsupported pay frequency');
 if(e.federalExempt)return 0;
 const adjustment=(e.federalTwoJobs?0:e.federalStatus==='married_joint'?1_290_000:860_000);
 const annual=Math.max(0,wageCents*periods+e.federalStep4aIncomeCents-
   e.federalStep4bDeductionsCents-adjustment);
 const selected=bands[e.federalStatus]?.[e.federalTwoJobs?'twoJobs':'normal'];
 if(!selected)throw new Error('Invalid W-4 status');
 const b=[...selected].reverse().find(r=>annual>=r.from*100);
 if(!b)throw new Error('Invalid federal bracket');
 const baseCents=Math.round(b.base*100);
 const annualTax=baseCents+centsRatio(annual-b.from*100,Math.round(b.rate*10000));
 // Worksheet 1A: tentative per period less annual credits / pay periods;
 // then add the extra withholding amount for the current period.
 const netAnnual=Math.max(0,annualTax-e.federalStep3CreditsCents);
 const tentative=Number((BigInt(netAnnual)+BigInt(periods)/2n)/BigInt(periods));
 return tentative+e.federalStep4cExtraCents;
}
export function ohioIncomeAugust2026(wageCents:number,periods:number,exemptions:number){
 if(![26,52].includes(periods))throw new Error('Unsupported pay frequency');
 const annual=Math.max(0,wageCents*periods-exemptions*65000);
 let withholdingAnnual:number;
 if(annual<=2_605_000)withholdingAnnual=centsRatio(annual,160);
 else if(annual<=10_000_000)withholdingAnnual=41680+
  centsRatio(annual-2_605_000,299);
 else withholdingAnnual=262791+centsRatio(annual-10_000_000,340);
 return Math.floor((withholdingAnnual*2+periods)/(2*periods));
}
function assertValid(i:TaxInput){
 const values=[i.grossCents,i.voluntaryDeductionsCents,i.reimbursementCents,
  i.ohioSupplementalWagesCents??0,
  i.history.priorSocialSecurityWagesCents,i.history.priorMedicareWagesCents,
  i.election.federalStep3CreditsCents,i.election.federalStep4aIncomeCents,
  i.election.federalStep4bDeductionsCents,i.election.federalStep4cExtraCents,
  i.election.ohioExtraCents??0];
 if(values.some(x=>!Number.isSafeInteger(x)||x<0||x>5_000_000_000))
  throw new Error('Invalid taxable wages, prior wages or W-4 amounts');
 if((i.ohioSupplementalWagesCents??0)>0&&
   i.history.priorMedicareWagesCents+i.grossCents>=100_000_000)
  throw new Error('High annual compensation with supplemental wages requires separate federal review');
 if(i.grossCents<i.voluntaryDeductionsCents)
  throw new Error('Voluntary deductions cannot exceed wages');
 if((i.ohioSupplementalWagesCents??0)>i.grossCents)
  throw new Error('Ohio supplemental wages cannot exceed gross wages');
 if(i.reimbursementCents>0&&!i.reimbursementsVerifiedNonTaxable)
  throw new Error('Reimbursement tax status must be reviewed before calculating taxes');
 const paid=new Date(i.payDate+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(i.payDate)||!Number.isFinite(paid.getTime())||
  paid.toISOString().slice(0,10)!==i.payDate||![26,52].includes(i.payPeriods)||
  i.payDate<'2026-08-01'||i.payDate>'2026-12-31')
  throw new Error('Supported actual pay dates are August 1–December 31, 2026');
 if(i.election.federalExempt && (i.election.federalExemptionYear!==2026||
  i.election.federalTwoJobs||i.election.federalStep3CreditsCents||
  i.election.federalStep4aIncomeCents||i.election.federalStep4bDeductionsCents||
  i.election.federalStep4cExtraCents))
  throw new Error('Exempt W-4 requires a current-year signed claim and no conflicting steps 2–4');
 if(!i.election.toledoWorkplaceConfirmed)
  throw new Error('All wages in the register must be verified taxable Toledo work');
 if(!Number.isSafeInteger(i.election.ohioIt4Exemptions)||
  i.election.ohioIt4Exemptions<0||i.election.ohioIt4Exemptions>100)
  throw new Error('Invalid Ohio exemption count');
 if(i.election.schoolDistrictBasis==='earned_income'||i.election.schoolDistrictBasis==='traditional'){
  if(!/^\d{4}$/.test(i.election.schoolDistrictCode)||
    !Number.isInteger(i.election.schoolDistrictRateBps)||
    i.election.schoolDistrictRateBps<=0||i.election.schoolDistrictRateBps>500)
    throw new Error('Invalid or unverified school district configuration');
 }else if(i.election.schoolDistrictCode!=='none'||
   i.election.schoolDistrictRateBps!==0)
  throw new Error('Verify school district tax applicability before calculating');
}
export function calculateTax2026(i:TaxInput){
 assertValid(i);
 const {grossCents:g,election:e,history:h,payPeriods:p}=i;
 const fed=federalIncome2026(g,p,e);
 // Ohio Admin. Code 5703-7-10: supplemental compensation (e.g., bonuses)
 // is withheld at the maximum statutory 2026 income tax rate of 2.75%.
 // Only regular compensation goes through the 2026 computer formula.
 const supplemental=i.ohioSupplementalWagesCents??0;
 const ohio=ohioIncomeAugust2026(g-supplemental,p,e.ohioIt4Exemptions)+
  centsRatio(supplemental,275)+(e.ohioExtraCents??0);
 const toledo=centsRatio(g,250);
 // Ohio SDIT computer method: traditional districts allow $650/year per
 // IT-4 exemption; earned-income districts allow no exemption reduction.
 const schoolBase=e.schoolDistrictBasis==='traditional'?
  Math.max(0,g-e.ohioIt4Exemptions*(65000/p)):g;
 const school=e.schoolDistrictBasis!=='none'?centsRatio(schoolBase,e.schoolDistrictRateBps):0;
 const employer=calculateEmployerTaxes(g,h,i.employerTaxes);
 const ssWages=Math.min(g,Math.max(0,SS_WAGE_BASE_CENTS-
  h.priorSocialSecurityWagesCents));
 const employeeSS=centsRatio(ssWages,620);
 const medicare=centsRatio(g,145);
 const addMedWages=Math.max(0,h.priorMedicareWagesCents+g-
  ADDITIONAL_MEDICARE_THRESHOLD_CENTS)-
  Math.max(0,h.priorMedicareWagesCents-ADDITIONAL_MEDICARE_THRESHOLD_CENTS);
 const additionalMedicare=centsRatio(addMedWages,90);
 const total=fed+ohio+toledo+school+employeeSS+medicare+additionalMedicare;
 const projectedNet=g-total-i.voluntaryDeductionsCents+i.reimbursementCents;
 if(projectedNet<0)throw new Error('Withholding exceeds available wages; manual review required');
 if(!Number.isSafeInteger(total)||!Number.isSafeInteger(projectedNet))
  throw new Error('Withholding arithmetic exceeds safe limits');
 return{
  grossCents:g,federalIncomeCents:fed,ohioIncomeCents:ohio,
  toledoIncomeCents:toledo,schoolIncomeCents:school,
  socialSecurityCents:employeeSS,medicareCents:medicare,
  additionalMedicareCents:additionalMedicare,totalWithholdingCents:total,
  voluntaryDeductionsCents:i.voluntaryDeductionsCents,
  reimbursementCents:i.reimbursementCents,
  ohioSupplementalWagesCents:i.ohioSupplementalWagesCents??0,
  projectedNetCents:projectedNet,
  employerSocialSecurityCents:employeeSS,employerMedicareCents:medicare,
  ruleVersion:RULE_SET,canDisburse:false,
  ...employer,bankVerified:false,
 };
}

// FUTA credit eligibility is an employer fact, not inferred from Ohio residency.
// Ohio's assigned total rate must include the technology/customer-service fee.
export function calculateEmployerTaxes(gross:number,h:WageHistory,settings?:EmployerTaxSettings){
 if(!settings)return {employerFutaCents:0,employerOhioUiCents:0,
  otherEmployerTaxesStatus:'not_calculated' as const};
 if(!settings.verified||settings.recordReference.trim().length<12||
  !Number.isInteger(settings.ohioUiRateBps)||settings.ohioUiRateBps<0||settings.ohioUiRateBps>1500||
  !Number.isInteger(settings.futaEffectiveRateBps)||settings.futaEffectiveRateBps<60||settings.futaEffectiveRateBps>600)
  throw new Error('Verify assigned Ohio total UI rate and effective FUTA rate/credit evidence');
 for(const amount of [h.priorFutaWagesCents,h.priorOhioUiWagesCents])
  if(!Number.isSafeInteger(amount)||amount!<0||amount!>5_000_000_000)
   throw new Error('Verify prior FUTA and Ohio UI wages for this legal employer and pay year');
 return {
  employerFutaCents:centsRatio(Math.min(gross,Math.max(0,700000-h.priorFutaWagesCents!)),settings.futaEffectiveRateBps),
  employerOhioUiCents:centsRatio(Math.min(gross,Math.max(0,900000-h.priorOhioUiWagesCents!)),settings.ohioUiRateBps),
  otherEmployerTaxesStatus:'calculated_from_verified_rates' as const,
 };
}
