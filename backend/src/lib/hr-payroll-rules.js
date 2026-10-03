export const INITIAL_HR_RULES={normalStart:'07:30',normalEnd:'16:30',paidHoursPerDay:8,otInterval:0.5,minimumOt:0.5,maxDailyOt:6,lateGraceMinutes:30,lateHalfRateUntilMinutes:45,lateThreeQuarterRateUntilMinutes:60,lateIncrementMinutes:15,lateIncrementFraction:0.25,transportDivisor:25,fullTransportDays:null,fullTransportComparison:'At least',longDistanceKm:50,longDistancePayment:500,supervisorSiteCharge:500,mileageRate:17,fixedTravelPayment:300,allowMileageAndFixed:false,countLeaveForTransport:false,countAbsenceForTransport:false,separateApproval:false};
export const cents=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
export const minutes=time=>{const [h,m]=String(time).split(':').map(Number);return h*60+m;};
export function rulesFor(policy){return {...INITIAL_HR_RULES,...(typeof policy.hr_rules==='string'?JSON.parse(policy.hr_rules):policy.hr_rules||{})};}
export function suggestOvertime(attendance,rules){
  if(!attendance||['Absent','On leave'].includes(attendance.state))return {hours:0,intervals:[],warnings:[]};
  if(!attendance.check_in||!attendance.check_out)return {hours:0,intervals:[],warnings:['Record valid check-in and check-out times before confirming OT.']};
  const start=minutes(attendance.check_in),end=minutes(attendance.check_out),normalStart=minutes(rules.normalStart),normalEnd=minutes(rules.normalEnd);
  if(end<=start)return {hours:0,intervals:[],warnings:['Check-out must be after check-in. Overnight shifts require a separate reviewed record.']};
  const intervals=[];
  if(start<normalStart)intervals.push([start,Math.min(end,normalStart)]);
  if(end>normalEnd)intervals.push([Math.max(start,normalEnd),end]);
  const rawHours=intervals.reduce((sum,[a,b])=>sum+(b-a)/60,0);
  const rounded=Math.floor((rawHours+1e-8)/rules.otInterval)*rules.otInterval;
  const hours=rounded>=rules.minimumOt?cents(rounded):0;
  return {hours,rawHours:cents(rawHours),intervals,warnings:hours>rules.maxDailyOt?['Suggested OT exceeds the daily warning threshold. HR must review it.']:[]};
}
export function calculateLateDeduction(attendance,rules,dailyRate){
  if(!attendance?.check_in||['Absent','On leave'].includes(attendance.state))return {lateMinutes:0,hourlyRate:0,multiplier:0,amount:0};
  const lateMinutes=Math.max(0,minutes(attendance.check_in)-minutes(rules.normalStart));
  const paidHours=Math.max(0.01,Number(rules.paidHoursPerDay||8));
  const hourlyRate=cents(Number(dailyRate||0)/paidHours);
  let multiplier=0;
  if(lateMinutes>rules.lateGraceMinutes&&lateMinutes<=rules.lateHalfRateUntilMinutes)multiplier=0.5;
  else if(lateMinutes>rules.lateHalfRateUntilMinutes&&lateMinutes<rules.lateThreeQuarterRateUntilMinutes)multiplier=0.75;
  else if(lateMinutes>=rules.lateThreeQuarterRateUntilMinutes){
    const extra=Math.max(0,lateMinutes-rules.lateThreeQuarterRateUntilMinutes);
    multiplier=1+Math.ceil(extra/rules.lateIncrementMinutes)*rules.lateIncrementFraction;
  }
  return {lateMinutes,hourlyRate,multiplier,amount:cents(hourlyRate*multiplier)};
}
export const intervalsOverlap=(a,b)=>a.some(([start,end])=>b.some(([otherStart,otherEnd])=>start<otherEnd&&otherStart<end));
export function calculateTransport(amount,days,method,rules){
  if(method==='Fixed full amount'||method==='Manually approved amount')return {amount:cents(amount),formula:`Approved fixed amount: ${amount}`};
  if(method==='Per-day amount')return {amount:cents(amount*days),formula:`${amount} × ${days} eligible days`};
  if(rules.fullTransportDays===null)throw new Error('HR must configure the full-transport eligible-day threshold before calculating prorated transport.');
  const full=rules.fullTransportComparison==='More than'?days>rules.fullTransportDays:days>=rules.fullTransportDays;
  return {amount:full?cents(amount):cents(Math.min(amount,amount/rules.transportDivisor*days)),formula:full?`${days} eligible days meet the full-payment threshold`:`${amount} ÷ ${rules.transportDivisor} × ${days} eligible days (capped at full amount)`};
}
export function calculateMileage(claim,rules){
  const distance=claim.approvedKm??(claim.endOdometer-claim.startOdometer);
  if(!Number.isFinite(distance)||distance<0||claim.startOdometer!==undefined&&claim.endOdometer<claim.startOdometer)throw new Error('Enter non-negative kilometres or an end odometer at least equal to the start reading.');
  if(claim.fixedTravel&&distance>0&&!rules.allowMileageAndFixed)throw new Error('This policy does not allow fixed travel payment and mileage together. Select only one.');
  return {distance,rate:rules.mileageRate,mileage:cents(distance*rules.mileageRate),fixed:claim.fixedTravel?rules.fixedTravelPayment:0,total:cents(distance*rules.mileageRate+(claim.fixedTravel?rules.fixedTravelPayment:0))};
}
export function calculateLongDistance(distance,rules){return distance>rules.longDistanceKm?cents(rules.longDistancePayment):0;}
