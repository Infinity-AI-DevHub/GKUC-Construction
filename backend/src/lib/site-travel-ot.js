import {minutes,suggestOvertime,rulesFor} from './hr-payroll-rules.js';
import {overtimeMinimumMinutes} from './payroll-policy.js';
export function usesSiteTravelPunches(employee,day={}){
 return ['Site labourer','Supervisor','Driver'].includes(employee.payroll_category)&&employee.special_pay_rule?.mode!=='Machine operator'&&day.work_location!=='Office';
}
export function siteStopProblem(checkIn,siteStop,checkOut){
 if(!siteStop)return null;
 if(!checkIn||checkOut&&minutes(checkOut)<=minutes(checkIn)||minutes(siteStop)<minutes(checkIn)||checkOut&&minutes(siteStop)>minutes(checkOut))return 'Site stop must be between check-in and office check-out.';
 return null;
}
export function inferSiteStop(row){
 if(row.siteStop!==undefined)return row.siteStop;
 const punches=[...new Set(row.punchTimes || (Array.isArray(row.punches)?row.punches:[]))].sort();
 return punches.length===3&&punches[0]===row.checkIn&&punches[2]===row.checkOut?punches[1]:null;
}
export function siteTravelSuggestions(employee,day,policy){
 const rules=rulesFor(policy),minimumSite=overtimeMinimumMinutes(employee,'Site',policy),minimumTravel=overtimeMinimumMinutes(employee,'Travel',policy);
 const problem=siteStopProblem(day.check_in,day.site_stop,day.check_out);
 if(['Absent','On leave'].includes(day.state)||!day.site_stop||!day.check_in||!day.check_out||problem||day.needs_review){
  const warnings=[problem || 'Record and confirm check-in, site stop and office check-out before splitting Site/Travel OT.'];
  const blank={hours:0,rawHours:0,rawMinutes:0,intervals:[],warnings};
  return {Site:{...blank,minimumMinutes:minimumSite},Travel:{...blank,minimumMinutes:minimumTravel},needsReview:true};
 }
 const site=suggestOvertime({...day,check_out:day.site_stop},rules,minimumSite);
 const start=minutes(day.site_stop),end=minutes(day.check_out),rawMinutes=Math.max(0,end-start);
 // An early site departure must also cap the morning interval.
 site.intervals=site.intervals.map(([a,b])=>[a,Math.min(b,start)]).filter(([a,b])=>b>a);
 site.rawMinutes=site.intervals.reduce((sum,[a,b])=>sum+b-a,0);site.rawHours=site.rawMinutes/60;
 const travel={rawMinutes,rawHours:rawMinutes/60,hours:rawMinutes>=minimumTravel?rawMinutes/60:0,
  intervals:rawMinutes?[[start,end]]:[],minimumMinutes:minimumTravel,warnings:rawMinutes/60>rules.maxDailyOt?['Suggested travel OT exceeds the daily warning threshold. HR must review it.']:[]};
 return {Site:{...site,hours:site.rawMinutes>=minimumSite?site.rawMinutes/60:0,minimumMinutes:minimumSite},Travel:travel,needsReview:false};
}
