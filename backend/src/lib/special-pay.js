import {cents} from './hr-payroll-rules.js';
export const SPECIAL_PAY_RATES=Object.freeze({bass:3000,gola:2500,minimum:1800,meterHourly:650,transport:300,paidHours:8,siteOt:225,travelOt:100});
export const specialRuleFor=(employee,date)=>[...(employee.special_pay_rules||[])].filter(row=>String(row.effective_from).slice(0,10)<=date)
  .sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from))||Number(b.id)-Number(a.id))[0]||null;
export const activeSpecialRule=(employee,date)=>{const rule=specialRuleFor(employee,date);return rule?.mode!=='Standard'?rule:null;};
export const specialRates=rule=>({...SPECIAL_PAY_RATES,...(typeof rule?.rates==='string'?JSON.parse(rule.rates):rule?.rates||{})});
export function specialInputFor(employee,date,required=true){
  const rule=activeSpecialRule(employee,date);
  if(!rule)return null;
  const input=(employee.special_pay_days||[]).find(row=>row.work_date===date);
  if(!input&&required)throw new Error(`Record HR daily work / meter details for ${date} in Payroll inputs → Special daily pay.`);
  if(!input)return null;
  if(rule.mode==='Work role'&&!['Bass','Gola'].includes(input.work_kind)||rule.mode==='Machine operator'&&!['Machine','Standby'].includes(input.work_kind))
    throw new Error(`The HR work type on ${date} does not match the effective special pay rule.`);
  return input;
}
export function specialEmployeeFor(employee,date){
  const rule=activeSpecialRule(employee,date);
  return rule?{...employee,special_pay_rule:rule,special_pay_day:specialInputFor(employee,date,false),
    payroll_category:rule.mode==='Work role'?'Site labourer':employee.payroll_category}:employee;
}
export function specialDayPay(employee,day,multiplier,workedHours){
  const rule=activeSpecialRule(employee,day.work_date);
  if(!rule)return null;
  const input=specialInputFor(employee,day.work_date),rates=specialRates(rule);
  const snapshot={ruleId:rule.id,effectiveFrom:rule.effective_from,mode:rule.mode,inputId:input.id,workKind:input.work_kind,
    rates,reason:input.reason,recordedBy:input.recorded_by,rateMultiplier:multiplier};
  if(rule.mode==='Work role'){
    const dailyRate=input.work_kind==='Bass'?rates.bass:rates.gola;
    const hours=Math.min(rates.paidHours,workedHours);
    return {dailyRate,earnedBasic:cents(dailyRate/rates.paidHours*hours*multiplier),transport:0,
      workedHours:hours,snapshot:{...snapshot,formula:`${dailyRate} / ${rates.paidHours} × ${hours} × ${multiplier}`}};
  }
  const machine=input.work_kind==='Machine';
  const hours=machine?Number(input.end_meter)-Number(input.start_meter):Math.min(rates.paidHours,Number(input.hours));
  if(!Number.isFinite(hours)||hours<=0)throw new Error(`Review the operator hours / meter readings for ${day.work_date}.`);
  const basic=machine?(multiplier>1?rates.minimum*multiplier:Math.max(rates.minimum,hours*rates.meterHourly))
    :rates.minimum/rates.paidHours*hours*multiplier;
  return {dailyRate:rates.minimum,earnedBasic:cents(basic),transport:rates.transport,workedHours:machine?rates.paidHours:hours,
    snapshot:{...snapshot,startMeter:input.start_meter,endMeter:input.end_meter,meterHours:machine?hours:null,standbyHours:machine?null:hours,
      formula:machine?(multiplier>1?`${rates.minimum} × ${multiplier} (extra-day payment)`:`max(${rates.minimum}, ${hours} × ${rates.meterHourly})`)
        :`${rates.minimum} / ${rates.paidHours} × ${hours} × ${multiplier}`}};
}
