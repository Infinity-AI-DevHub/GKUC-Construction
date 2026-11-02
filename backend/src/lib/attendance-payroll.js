import {cents,rulesFor,suggestOvertime,calculateLateDeduction,minutes} from './hr-payroll-rules.js';
import {resolveLateRate,resolveOvertimeRate,overtimeMinimumMinutes} from './payroll-policy.js';

const parse=value=>typeof value==='string'?JSON.parse(value):(value||{});
export function attendanceOvertimeType(employee,attendance) {
  if(employee.payroll_category==='Office employee')return 'Office';
  if(['Site labourer','Supervisor'].includes(employee.payroll_category))return 'Site';
  if(employee.payroll_category==='Driver')return attendance.work_location==='Site'?'Site':null;
  const location=['Office','Site'].includes(attendance.work_location)?attendance.work_location:employee.worker_type;
  return location==='Office'?'Office':'Site';
}

export function subtractIntervals(intervals,excluded) {
  return excluded.reduce((remaining,[start,end])=>remaining.flatMap(([a,b])=>
    end<=a||start>=b?[[a,b]]:[[a,Math.min(start,b)],[Math.max(end,a),b]].filter(([x,y])=>y>x)),intervals);
}

/** Normal shift time only: OT cannot replace missing basic-pay hours. */
export function shortAttendancePay(day,rules,dailyRate,rateMultiplier=1) {
  if (['Absent','On leave'].includes(day.state) || day.needs_review) return {amount:0};
  if (!day.check_in || !day.check_out) return {amount:0,warning:'Record both check-in and check-out to calculate short-day salary.'};
  const start=minutes(day.check_in),end=minutes(day.check_out);
  const paidMinutes=Number(rules.paidHoursPerDay)*60;
  if (![start,end,paidMinutes].every(Number.isFinite) || end<=start || paidMinutes<=0)
    return {amount:0,warning:'Review the attendance times and paid-hours setting before calculating short-day salary.'};
  // Salary is based on actual attended time, capped at one paid day. A worker
  // who arrives late but works long enough later in the day therefore does not
  // receive a second short-day reduction in addition to the late deduction.
  const workedMinutes=Math.min(paidMinutes,Math.max(0,end-start));
  const missingMinutes=paidMinutes-workedMinutes;
  const hourlyRate=Number(dailyRate)/Number(rules.paidHoursPerDay);
  const fullDay=cents(Number(dailyRate)*rateMultiplier);
  const earnedBasic=cents(workedMinutes/60*hourlyRate*rateMultiplier);
  const amount=cents(Math.max(0,fullDay-earnedBasic));
  return {amount,earnedBasic,rateMultiplier,workedMinutes,missingMinutes,hourlyRate,paidHoursPerDay:Number(rules.paidHoursPerDay)};
}

const WORKED_STATES=new Set(['On site','Late','Checked out','Business trip']);
const monthKey=date=>String(date).slice(0,7);
const dateKey=date=>String(date).slice(0,10);

function workedFraction(day, policy) {
  if (!WORKED_STATES.has(day.state) || !day.check_in || !day.check_out) return 0;
  const start=minutes(day.check_in),end=minutes(day.check_out),paid=Number(rulesFor(policy).paidHoursPerDay)*60;
  return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&paid>0 ? Math.min(1,(end-start)/paid) : 0;
}

export function calculateAttendancePayroll(employee,attendance,overtime,policies,travelClaims=[],calendarAttendance=attendance) {
  const dated=[...policies].sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from))||Number(b.id)-Number(a.id));
  const policyFor=date=>{
    const policy=dated.find(p=>Number(p.company_id)===Number(employee.payroll_company_id)&&p.effective_from<=date);
    if(!policy)throw new Error(`Configure a payroll policy effective on or before ${date}.`);
    return policy;
  };
  const totals={overtime_hours:0,overtime_pay:0,office_ot_hours:0,office_ot_pay:0,site_ot_hours:0,site_ot_pay:0,
    travel_ot_hours:0,travel_ot_pay:0,late_minutes:0,late_deduction:0,short_day_reduction:0,attendance_basic:0};
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
    const minimumMinutes=overtimeMinimumMinutes(employee,record.overtime_type,policy);
    if(Number(record.hours)*60<minimumMinutes) {
      detail.warnings.push({workDate:record.work_date,message:`Approved ${record.overtime_type} OT is below its ${minimumMinutes}-minute policy minimum and was not paid.`});
      continue;
    }
    addOt(record.overtime_type,record.hours,resolveOvertimeRate(employee,record.overtime_type,policy),{
      source:'Reviewed OT',sourceId:record.id,projectId:record.project_id,workDate:record.work_date,
      policyId:policy.id,recordedRate:Number(record.rate),minimumMinutes});
  }
  // Count actual attended fractions inside each calendar month. Leave never
  // contributes. The day which takes the running total beyond 25 is paid at
  // 1.5× for the whole day, including a partial day.
  const dayMultipliers=new Map();
  for(const month of [...new Set(calendarAttendance.map(day=>monthKey(day.work_date)))]) {
    let running=0;
    const calendarDays=calendarAttendance.filter(day=>monthKey(day.work_date)===month)
      .sort((a,b)=>dateKey(a.work_date).localeCompare(dateKey(b.work_date))||Number(a.id)-Number(b.id));
    for(const day of calendarDays) {
      const policy=policyFor(day.work_date),rules=rulesFor(policy),fraction=workedFraction(day,policy);
      if(!fraction)continue;
      const next=running+fraction;
      const multiplier=next>Number(rules.monthlyOvertimeDayThreshold ?? 25)
        ? Number(rules.monthlyOvertimeMultiplier ?? 1.5) : 1;
      dayMultipliers.set(dateKey(day.work_date),multiplier);
      running=next;
    }
  }
  for(const day of attendance) {
    if(['Absent','On leave'].includes(day.state))continue;
    if(day.needs_review) {
      detail.warnings.push({workDate:day.work_date,message:'Attendance needs review; automatic OT and late deduction were not included.'});
      // Keep the existing daily earning until HR corrects the attendance; the
      // prior payroll behaviour never silently withheld a worked day here.
      totals.attendance_basic+=Number(employee.daily_rate||0);
      continue;
    }
    const policy=policyFor(day.work_date),rules=rulesFor(policy);
    const late=calculateLateDeduction(day,rules,resolveLateRate(employee,policy));
    const multiplier=dayMultipliers.get(dateKey(day.work_date)) ?? 1;
    const shortDay=shortAttendancePay(day,rules,employee.daily_rate,multiplier);
    if (shortDay.warning) detail.warnings.push({workDate:day.work_date,message:shortDay.warning});
    if (shortDay.missingMinutes>0 && Number(employee.daily_rate)<=0)
      throw new Error(`Set a daily salary rate before calculating short-day salary for ${day.work_date}.`);
    totals.short_day_reduction+=shortDay.amount;
    totals.attendance_basic+=shortDay.earnedBasic ?? Number(employee.daily_rate||0)*multiplier;
    totals.late_minutes+=late.lateMinutes;
    totals.late_deduction+=late.amount;
    detail.attendance.push({attendanceId:day.id,workDate:day.work_date,policyId:policy.id,
      checkIn:day.check_in,checkOut:day.check_out,normalStart:rules.normalStart,normalEnd:rules.normalEnd,
      dailyRate:Number(employee.daily_rate),paidHoursPerDay:rules.paidHoursPerDay,
      graceMinutes:rules.lateGraceMinutes,lateMinutes:late.lateMinutes,deductibleMinutes:late.deductibleMinutes||0,
      lateDeduction:late.amount,lateHourlyRate:late.hourlyRate,rateMultiplier:multiplier,shortDay});
    if(reviewedDays.has(day.work_date))continue;
    const type=attendanceOvertimeType(employee,day);
    if(!type)continue;
    const minimumMinutes=overtimeMinimumMinutes(employee,type,policy);
    const suggestion=suggestOvertime(day,rules,minimumMinutes);
    if(suggestion.warnings.length)detail.warnings.push(...suggestion.warnings.map(message=>({workDate:day.work_date,message})));
    if(!suggestion.intervals?.length)continue;
    const travel=[...overtime.filter(o=>o.work_date===day.work_date&&o.overtime_type==='Travel'&&o.status!=='Rejected')
      .map(o=>parse(o.input_detail)),...travelClaims.filter(c=>c.work_date===day.work_date&&c.status!=='Rejected').map(c=>parse(c.calculation))];
    if(travel.some(item=>!Array.isArray(item.intervals)||!item.intervals.length))
      throw new Error(`Review travel time intervals on ${day.work_date} before calculating attendance OT.`);
    const intervals=subtractIntervals(suggestion.intervals,travel.flatMap(item=>item.intervals));
    const rawMinutes=intervals.reduce((sum,[a,b])=>sum+(b-a),0);
    const hours=rawMinutes>=minimumMinutes?cents(rawMinutes/60):0;
    if(!hours)continue;
    addOt(type,hours,resolveOvertimeRate(employee,type,policy),{source:'Attendance',sourceId:day.id,
      projectId:day.project_id,workDate:day.work_date,policyId:policy.id,intervals,
      rawMinutes,minimumMinutes});
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
  totals.short_day_reduction=cents(totals.short_day_reduction);
  totals.attendance_basic=cents(totals.attendance_basic);
  return {...totals,calculation_detail:detail};
}
