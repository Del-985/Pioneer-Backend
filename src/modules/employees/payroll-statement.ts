// Pure, escaped HTML for a portable printable statement. No external assets or scripts.
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(v:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)/100);
const hours=(v:unknown)=>(Number(v)/3600).toFixed(4).replace(/\.?0+$/,'')||'0';
export function statementHtml(payment:{id:string;status:string;statement:any}){
 const s=payment.statement,a=s.amounts;
 const taxNames:Record<string,string>={federal_income_cents:'Federal income tax',ohio_income_cents:'Ohio income tax',
  toledo_income_cents:'Toledo income tax',school_income_cents:'School district income tax ('+s.schoolDistrictCode+')',
  social_security_cents:'Social Security',medicare_cents:'Medicare',additional_medicare_cents:'Additional Medicare'};
 const rows=(items:Array<[string,unknown]>)=>items.map(([label,value])=>`<tr><td>${esc(label)}</td><td>${esc(money(value))}</td></tr>`).join('');
 const periodLast=new Date(s.periodEndExclusive+'T12:00:00Z');periodLast.setUTCDate(periodLast.getUTCDate()-1);
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Pay Statement ${esc(s.payDate)}</title><style>body{font:15px system-ui,sans-serif;color:#162335;max-width:900px;margin:35px auto;padding:20px}h1{margin-bottom:4px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{padding:9px;border-bottom:1px solid #ccc;text-align:left}td:last-child,th:last-child{text-align:right}.total{font-weight:bold}.note{font-size:12px;color:#465366}.address{white-space:pre-line}.reversed{border:3px solid #a00;padding:12px;color:#a00;font-weight:bold}@media print{body{margin:0;padding:10px}tr{break-inside:avoid}h2{break-after:avoid}}</style>
 <h1>Earnings and Deductions Statement</h1><p>${esc(s.employerName)}</p>
 ${payment.status==='reversed'?'<p class="reversed">REVERSED PAYMENT RECORD — retain for history; not evidence of current payment.</p>':''}
 <h2>${esc(s.employeeName)}</h2><p class="address">${esc(s.employeeAddress)}</p>
 <p>Pay date: ${esc(s.payDate)}<br>Pay period: ${esc(s.periodStart)} through ${esc(periodLast.toISOString().slice(0,10))}</p>
 <table><tbody>${rows([['Gross wages',a.gross_cents],['Tax withholding',a.total_withholding_cents],['Voluntary deductions',a.voluntary_deductions_cents],['Non-taxable reimbursements',a.reimbursement_cents],['Net paid',a.projected_net_cents]])}</tbody></table>
 <h2>Hourly Earnings</h2><p>Total hours: ${esc(hours(s.regularSeconds+s.overtimeSeconds))}; hours above forty in a workweek: ${esc(hours(s.overtimeSeconds))}.</p>
 <table><thead><tr><th>Week starting</th><th>Base hourly rate</th><th>Regular hours</th><th>Overtime hours</th><th>Overtime rate</th><th>Wages</th></tr></thead><tbody>
 ${s.earnings.map((e:any)=>`<tr><td>${esc(e.weekStarting)}</td><td>${esc(money(e.hourlyCents))}</td><td>${esc(hours(e.regularSeconds))}</td><td>${esc(hours(e.overtimeSeconds))}</td><td>${esc(money(e.hourlyCents*e.overtimeMultiplierBps/10000))}</td><td>${esc(money(e.regularCents+e.overtimeCents))}</td></tr>`).join('')}</tbody></table>
 <h2>Additions and Deductions</h2><table><thead><tr><th>Purpose</th><th>Amount</th></tr></thead><tbody>
 ${rows(Object.entries(taxNames).map(([key,name])=>[name,a[key]]))}
 ${rows((s.deductions??[]).map((d:any)=>['Deduction: '+d.label,d.amountCents]))}
 ${rows((s.additions??[]).map((d:any)=>[(d.category==='reimbursement'?'Reimbursement: ':'Gross wage addition: ')+d.description,d.amountCents]))}
 </tbody></table><p class="note">Wage additions are already included in gross wages. Reimbursements are added after deductions. Employer taxes are not employee deductions.</p>
 <p class="note">Statement ${esc(payment.id)}. Retain a copy for your records.</p></html>`;
}
