import {cents,rulesFor,suggestOvertime,calculateLateDeduction} from './hr-payroll-rules.js';
import {resolveOvertimeRate} from './payroll-policy.js';

const parse=value=>typeof value==='string'?JSON.parse(value):(value||{});
export function attendanceOvertimeType(employee,attendance) {
  if(employee.payroll_category==='Office employee')return 'Office';
  if(['Site labourer','Supervisor'].includes(employee.payroll_category))return 'Site';
  if(employee.payroll_category==='Driver')return attendance.work_location==='Site'?'Site':'Office';
  const location=['Office','Site'].includes(attendance.work_location)?attendance.work_location:employee.worker_type;
  return location==='Office'?'Office':'Site';
}

export function subtractIntervals(intervals,excluded) {
  return excluded.reduce((remaining,[start,end])=>remaining.flatMap(([a,b])=>
    end<=a||start>=b?[[a,b]]:[[a,Math.min(start,b)],[Math.max(end,a),b]].filter(([x,y])=>y>x)),intervals);
}

export function calculateAttendancePayroll(employee,attendance,overtime,policies,travelClaims=[]) {
  const dated=[...policies].sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from))||Number(b.id)-Number(a.id));
  const policyFor=date=>{
    const policy=dated.find(p=>Number(p.company_id)===Number(employee.payroll_company_id)&&p.effective_from<=date);
    if(!policy)throw new Error(`Configure a payroll policy effective on or before ${date}.`);
    return policy;
  };
  const totals={overtime_hours:0,overtime_pay:0,office_ot_hours:0,office_ot_pay:0,site_ot_hours:0,site_ot_pay:0,
    travel_ot_hours:0,travel_ot_pay:0,late_minutes:0,late_deduction:0};
  const detail={version:1,payrollCategory:employee.payroll_category,workerType:employee.worker_type,attendance:[],overtime:[],warnings:[]};
  const addOt=(type,hours,rate,row)=>{
    if(!Number.isFinite(rate)||rate<0)throw new Error(`Configure a valid ${type} OT rate for ${row.workDate}.`);
    const prefix=type.toLowerCase();
    const amount=cents(Number(hours)*rate);
    totals[`${prefix}_ot_hours`]+=Number(hours);
    totals[`${prefix}_ot_pay`]+=amount;
    detail.overtime.push({...row,type,hours:Number(hours),rate,amount});
  };
  // An explicit decision replaces attendance OT for that day, including Pending/Rejected.
  const reviewedDays=new Set(overtime.filter(o=>o.overtime_type!=='Travel').map(o=>o.work_date));
  const approvedKeys=new Set();
  for(const record of overtime.filter(o=>o.overtime_type!=='Travel'&&o.status!=='Approved'))
    detail.warnings.push({workDate:record.work_date,message:`${record.status} reviewed OT: automatic Office/Site OT was not substituted.`});
  for(const record of overtime.filter(o=>o.status==='Approved')) {
    const key=`${record.work_date}:${record.overtime_type}`;
    if(approvedKeys.has(key))throw new Error(`Resolve duplicate approved ${record.overtime_type} OT on ${record.work_date} before payroll.`);
    approvedKeys.add(key);
    if(attendance.some(day=>day.work_date===record.work_date&&['Absent','On leave'].includes(day.state)))
      throw new Error(`Review approved OT against the absent/leave attendance on ${record.work_date}.`);
    const policy=policyFor(record.work_date);
    addOt(record.overtime_type,record.hours,resolveOvertimeRate(employee,record.overtime_type,policy),{
      source:'Reviewed OT',sourceId:record.id,projectId:record.project_id,workDate:record.work_date,
      policyId:policy.id,recordedRate:Number(record.rate)});
  }
  for(const day of attendance) {
    if(['Absent','On leave'].includes(day.state))continue;
    if(day.needs_review) {
      detail.warnings.push({workDate:day.work_date,message:'Attendance needs review; automatic OT and late deduction were not included.'});
      continue;
    }
    const policy=policyFor(day.work_date),rules=rulesFor(policy);
    const late=calculateLateDeduction(day,rules,employee.daily_rate);
    if(late.deductibleMinutes>0&&Number(employee.daily_rate)<=0)
      throw new Error(`Set a daily salary rate before calculating late deductions for ${day.work_date}.`);
    totals.late_minutes+=late.lateMinutes;
    totals.late_deduction+=late.amount;
    detail.attendance.push({attendanceId:day.id,workDate:day.work_date,policyId:policy.id,
      checkIn:day.check_in,checkOut:day.check_out,normalStart:rules.normalStart,normalEnd:rules.normalEnd,
      dailyRate:Number(employee.daily_rate),paidHoursPerDay:rules.paidHoursPerDay,
      graceMinutes:rules.lateGraceMinutes,lateMinutes:late.lateMinutes,deductibleMinutes:late.deductibleMinutes||0,
      lateDeduction:late.amount});
    if(reviewedDays.has(day.work_date))continue;
    const suggestion=suggestOvertime(day,rules);
    if(suggestion.warnings.length)detail.warnings.push(...suggestion.warnings.map(message=>({workDate:day.work_date,message})));
    if(!suggestion.intervals?.length)continue;
    const travel=[...overtime.filter(o=>o.work_date===day.work_date&&o.overtime_type==='Travel'&&o.status!=='Rejected')
      .map(o=>parse(o.input_detail)),...travelClaims.filter(c=>c.work_date===day.work_date&&c.status!=='Rejected').map(c=>parse(c.calculation))];
    if(travel.some(item=>!Array.isArray(item.intervals)||!item.intervals.length))
      throw new Error(`Review travel time intervals on ${day.work_date} before calculating attendance OT.`);
    const intervals=subtractIntervals(suggestion.intervals,travel.flatMap(item=>item.intervals));
    const rawHours=intervals.reduce((sum,[a,b])=>sum+(b-a)/60,0);
    const rounded=Math.floor((rawHours+1e-8)/rules.otInterval)*rules.otInterval;
    const hours=rounded>=rules.minimumOt?cents(rounded):0;
    if(!hours)continue;
    const type=attendanceOvertimeType(employee,day);
    addOt(type,hours,resolveOvertimeRate(employee,type,policy),{source:'Attendance',sourceId:day.id,
      projectId:day.project_id,workDate:day.work_date,policyId:policy.id,intervals,
      otGraceMinutes:rules.otGraceMinutes,otInterval:rules.otInterval,minimumOt:rules.minimumOt});
  }
  for(const type of ['office','site','travel']) {
    totals[`${type}_ot_hours`]=cents(totals[`${type}_ot_hours`]);
    totals[`${type}_ot_pay`]=cents(totals[`${type}_ot_pay`]);
    totals.overtime_hours+=totals[`${type}_ot_hours`];
    totals.overtime_pay+=totals[`${type}_ot_pay`];
  }
  totals.overtime_hours=cents(totals.overtime_hours);
  totals.overtime_pay=cents(totals.overtime_pay);
  totals.late_deduction=cents(totals.late_deduction);
  return {...totals,calculation_detail:detail};
}
