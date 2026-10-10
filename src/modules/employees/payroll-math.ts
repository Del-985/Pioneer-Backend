// Monetary arithmetic uses integer cents and seconds, without floating-point dollar math.
// Overtime is an ESTIMATE by the clock-in week, not a certified payroll calculation.
export type PayInput = {
  id:string;
  employeeId:string;
  clockInAt:Date;
  workedSeconds:number;
  hourlyCents:number;
  multiplierBps:number;
  rateId:string;
  // Same-person hours across the legal entity for workweek accumulation.
  personKey:string;
  businessUnitId:string;
};
export type PayCalculated=PayInput&{
  regularSeconds:number;overtimeSeconds:number;regularCents:number;overtimeCents:number;grossCents:number;
};
export const WEEK_THRESHOLD_SECONDS=40*3600;
export const OVERTIME_WEEK_TIMEZONE='America/Detroit';
export function localWeekKey(date:Date){
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:OVERTIME_WEEK_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(date);
  const get=(type:string)=>parts.find(p=>p.type===type)?.value??'';
  const day=new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
  return day.toISOString().slice(0,10);
}
export function roundRatio(amount:bigint,denominator:bigint){
  if(amount<0n||denominator<=0n)throw new Error('Invalid money input');
  return Number((amount+denominator/2n)/denominator);
}
export function payrollLineCents(seconds:number,rateCents:number,multiplierBps=10000){
  if(!Number.isSafeInteger(seconds)||seconds<0||!Number.isSafeInteger(rateCents)||rateCents<0||
    !Number.isSafeInteger(multiplierBps)||multiplierBps<10000)
    throw new Error('Invalid pay data');
  return roundRatio(BigInt(seconds)*BigInt(rateCents)*BigInt(multiplierBps),3600n*10000n);
}
export function calculateGrossLines(allEntries:PayInput[]):PayCalculated[]{
  const ordered=[...allEntries].sort((a,b)=>a.clockInAt.getTime()-b.clockInAt.getTime()||
    a.id.localeCompare(b.id));
  const used=new Map<string,number>();
  return ordered.map(entry=>{
    if(!Number.isSafeInteger(entry.workedSeconds)||entry.workedSeconds<=0)
      throw new Error('Approved entry must have positive hours');
    const key=entry.personKey+'|'+localWeekKey(entry.clockInAt);
    const prior=used.get(key)||0;
    const regularSeconds=Math.max(0,Math.min(entry.workedSeconds,WEEK_THRESHOLD_SECONDS-prior));
    const overtimeSeconds=entry.workedSeconds-regularSeconds;
    used.set(key,prior+entry.workedSeconds);
    const regularCents=payrollLineCents(regularSeconds,entry.hourlyCents);
    const overtimeCents=payrollLineCents(overtimeSeconds,entry.hourlyCents,entry.multiplierBps);
    return{...entry,regularSeconds,overtimeSeconds,regularCents,overtimeCents,
      grossCents:regularCents+overtimeCents};
  });
}
