export type FilingPayment={id:string;personKey:string;payDate:string;periodStart:string;periodEnd:string;
 gross:number;federal:number;ss:number;medicare:number;additional:number;employerSs:number;employerMedicare:number;
 ohio:number;toledo:number;school:number;district:string;priorSs:number;priorMedicare:number;};
export function safe(n:number){if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid or unsafe payroll amount');return n;}
const tax=(cents:number,bps:number)=>Number((BigInt(safe(cents))*BigInt(bps)+5000n)/10000n);
export function quarterDates(quarter:number){if(quarter!==3&&quarter!==4)throw new Error('Only 2026 Q3 and Q4 are supported');
 return{start:quarter===3?'2026-07-01':'2026-10-01',end:quarter===3?'2026-09-30':'2026-12-31'};}
export function filingFigures(payments:FilingPayment[],quarter:number,deposits:number,credit:number){
 const {start,end}=quarterDates(quarter);safe(deposits);safe(credit);
 const selected=payments.filter(p=>p.payDate>=start&&p.payDate<=end).sort((a,b)=>a.payDate.localeCompare(b.payDate)||a.id.localeCompare(b.id));
 let gross=0,federal=0,ssBase=0,medBase=0,addBase=0,employeeFica=0;
 const monthly:Array<{month:string;gross:number;federalLiability:number;ohio:number;toledo:number;districts:Record<string,number>}>=[];
 const daily:Record<string,number>={};
 const withholdingByPayday:Record<string,{ohio:number;toledo:number;districts:Record<string,number>}>={};const problems:string[]=[];
 let previousLiability=0;
 for(const p of selected){
  for(const k of ['gross','federal','ss','medicare','additional','employerSs','employerMedicare','ohio','toledo','school','priorSs','priorMedicare'] as const)safe(p[k]);
  const ss=Math.min(p.gross,Math.max(0,18450000-p.priorSs));
  const additional=Math.min(p.gross,Math.max(0,p.priorMedicare+p.gross-20000000));
  if(p.ss!==tax(ss,620)||p.medicare!==tax(p.gross,145)||p.additional!==tax(additional,90)||p.employerSs!==p.ss||p.employerMedicare!==p.medicare)
   problems.push('Payment '+p.id+' does not reconcile to supported FICA wage bases.');
  gross=safe(gross+p.gross);federal=safe(federal+p.federal);ssBase=safe(ssBase+ss);medBase=safe(medBase+p.gross);addBase=safe(addBase+additional);
  employeeFica=safe(employeeFica+p.ss+p.medicare+p.additional);
  // IRS line 7 reconciles the employee share only. Do not silently duplicate
  // the employee rounding adjustment for the employer share.
  const statutory=tax(ssBase,1240)+tax(medBase,290)+tax(addBase,90);
  const rounding=employeeFica-tax(ssBase,620)-tax(medBase,145)-tax(addBase,90);
  const liability=federal+statutory+rounding;
  daily[p.payDate]=(daily[p.payDate]||0)+liability-previousLiability;
  previousLiability=liability;
  const w=withholdingByPayday[p.payDate]??={ohio:0,toledo:0,districts:{}};
  w.ohio=safe(w.ohio+p.ohio);w.toledo=safe(w.toledo+p.toledo);if(p.school)w.districts[p.district]=safe((w.districts[p.district]||0)+p.school);
  const month=p.payDate.slice(0,7);let m=monthly.find(x=>x.month===month);
  if(!m){m={month,gross:0,federalLiability:0,ohio:0,toledo:0,districts:{}};monthly.push(m);}
  m.gross=safe(m.gross+p.gross);m.ohio=safe(m.ohio+p.ohio);m.toledo=safe(m.toledo+p.toledo);
  if(p.school){if(!/^\d{4}$/.test(p.district))problems.push('Missing school district code for withheld tax.');m.districts[p.district]=safe((m.districts[p.district]||0)+p.school);}
 }
 for(const [day,value] of Object.entries(daily)){monthly.find(m=>m.month===day.slice(0,7))!.federalLiability+=value;}
 const firstMonth=quarter===3?7:10;
 for(let i=0;i<3;i++){const month='2026-'+String(firstMonth+i).padStart(2,'0');if(!monthly.some(m=>m.month===month))monthly.push({month,gross:0,federalLiability:0,ohio:0,toledo:0,districts:{}});}
 monthly.sort((a,b)=>a.month.localeCompare(b.month));
 const ssTax=tax(ssBase,1240),medTax=tax(medBase,290),addTax=tax(addBase,90);
 const fica=ssTax+medTax+addTax,rounding=employeeFica-tax(ssBase,620)-tax(medBase,145)-addTax;
 const total=federal+fica+rounding,totalDeposits=safe(deposits+credit);
 const censusDate=quarter===3?'2026-09-12':'2026-12-12';
 const census=new Set(selected.filter(p=>p.periodStart<=censusDate&&p.periodEnd>censusDate).map(p=>p.personKey)).size;
 return{start,end,censusDate,census,employeeCount:new Set(selected.map(p=>p.personKey)).size,paymentCount:selected.length,
  lines:{line2:gross,line3:federal,line5aWages:ssBase,line5aTax:ssTax,line5bWages:0,line5bTax:0,
   line5cWages:medBase,line5cTax:medTax,line5dWages:addBase,line5dTax:addTax,line5e:fica,line5f:0,
   line6:federal+fica,line7:rounding,line8:0,line9:0,line10:total,line11:0,line12:total,line13:totalDeposits,
   line14:Math.max(0,total-totalDeposits),line15:Math.max(0,totalDeposits-total)},
  monthly,daily,withholdingByPayday,problems};
}
