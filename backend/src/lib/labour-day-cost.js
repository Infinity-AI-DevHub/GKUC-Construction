import {createHash} from 'node:crypto';
import {calculateAttendancePayroll} from './attendance-payroll.js';
import {attendanceForEmployee} from './payroll-attendance-match.js';
import {operatorPayrollDays,activeSpecialRule,specialRates} from './special-pay.js';
import {minutes} from './hr-payroll-rules.js';
const parse=value=>typeof value==='string'?JSON.parse(value):(value||{});
const cash=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
const hours=value=>Math.round(Number(value)*1000)/1000;
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
export function labourDayFacts({employeeId,date,day,basic,ot,late,source,warnings=[]}){
 const start=minutes(day.checkIn??day.check_in),end=minutes(day.checkOut??day.check_out);
 const workedHours=hours(Number.isFinite(start)&&Number.isFinite(end)&&end>start?(end-start)/60:Number(day.specialPay?.meterHours||0));
 if(day.needs_review||day.needsReview)fail('HR must confirm this attendance before allocating labour hours.');
 if(workedHours<=0)fail('No valid worked hours are saved for this employee/date. HR must record attendance with check-in/out, or valid operator Machine work.');
 const dailyPay=cash(Math.max(0,Number(basic)+Number(ot)-Number(late)));
 if(!Number.isFinite(dailyPay)||dailyPay<=0)fail('This employee/date has no positive earned pay to allocate. Review HR salary inputs.');
 const facts={employeeId:Number(employeeId),workDate:date,workedHours,basic:cash(basic),overtime:cash(ot),lateDeduction:cash(late),dailyPay,source};
 return {...facts,hourlyCost:dailyPay/workedHours,basisKey:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),warnings};
}
export function splitLabourCost(basis,allocations,reservedHours=0,reservedAmount=0){
 let used=hours(reservedHours),cost=cash(reservedAmount);const result=[];
 for(const row of allocations){
  const count=Number(row.hours);
  if(!Number.isFinite(count)||count<=0||Math.abs(count-hours(count))>0.0000001)fail('Enter positive allocation hours with at most three decimal places.');
  used=hours(used+count);if(used>basis.workedHours+0.00001)fail(`Allocated hours exceed the ${basis.workedHours} worked hours available on ${basis.workDate}.`);
  const cumulative=cash(basis.dailyPay*used/basis.workedHours),amount=cash(cumulative-cost);cost=cumulative;
  if(amount<=0)fail('This hours split produces less than one cent of labour cost. Combine very small allocations.');
  result.push({...row,hours:count,amount});
 }
 return result;
}
export async function readLabourDay(connection,employeeId,date){
 const rows=async(sql,args=[])=> (await connection.execute(sql,args))[0];
 const [employee]=await rows("SELECT * FROM visible_employees WHERE id=? AND status<>'Left'",[employeeId]);
 if(!employee)fail('Choose an active employee.');
 if(employee.join_date&&date<String(employee.join_date).slice(0,10))fail('The work date precedes this employee’s employment start.');
 const [saved]=await rows(`SELECT ps.calculation_detail detail,pr.id runId,pr.status FROM payslips ps JOIN payroll_runs pr ON pr.id=ps.run_id
   WHERE ps.employee_id=? AND pr.status IN ('Approved','Paid') AND pr.period_start<=? AND pr.period_end>=? ORDER BY pr.id DESC LIMIT 1`,[employeeId,date,date]);
 if(saved){
  const detail=parse(saved.detail),day=detail.attendance?.find(row=>row.workDate===date);
  if(!day)fail('The approved/paid payroll has no worked-day calculation for this date. Review the saved payroll; do not substitute current rates.');
  const basic=day.specialPay?.earnedBasic??day.shortDay?.earnedBasic??Number(day.dailyRate||0)*Number(day.rateMultiplier||1)-Number(day.shortDay?.amount||0);
  return {...labourDayFacts({employeeId,date,day,basic,ot:(detail.overtime||[]).filter(row=>row.workDate===date).reduce((sum,row)=>sum+Number(row.amount||0),0),late:day.lateDeduction||0,source:`${saved.status} payroll #${saved.runId}`}),employee:employee.name};
 }
 const first=date.slice(0,7)+'-01';
 const [allNames,attendance,ot,policies,rules,inputs,travel]=await Promise.all([
  rows('SELECT id,name FROM employees'),
  rows('SELECT * FROM visible_attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date,id',[first,date]),
  rows('SELECT * FROM visible_overtime_records WHERE employee_id=? AND work_date=?',[employeeId,date]),
  rows('SELECT * FROM payroll_policies WHERE company_id=? AND archive_key=0 AND effective_from<=? ORDER BY effective_from DESC,id DESC',[employee.payroll_company_id,date]),
  rows('SELECT * FROM employee_special_pay_rules WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC',[employeeId,date]),
  rows('SELECT * FROM employee_special_pay_days WHERE employee_id=? AND active=1 AND work_date BETWEEN ? AND ?',[employeeId,first,date]),
  rows('SELECT * FROM visible_hr_payroll_claims WHERE employee_id=? AND work_date=? AND kind=\'Travel\'',[employeeId,date])
 ]);
 employee.special_pay_rules=rules;employee.special_pay_days=inputs;
 const special=activeSpecialRule(employee,date);
 if(special&&Number(employee.daily_rate)<=0)employee.daily_rate=special.mode==='Work role'?specialRates(special).gola:specialRates(special).minimum;
 const calendar=operatorPayrollDays(employee,attendanceForEmployee(employee,attendance,allNames),first,date);
 const day=calendar.find(row=>row.work_date===date);
 if(!day||!['On site','Late','Checked out','Business trip'].includes(day.state))fail('HR attendance does not show this employee working on the selected date.');
 const [leave]=await rows("SELECT id FROM visible_leave_requests WHERE employee_id=? AND status='Approved' AND from_date<=? AND to_date>=? LIMIT 1",[employeeId,date,date]);
 if(leave)fail('Approved leave conflicts with this worked day. HR must resolve it before cost allocation.');
 let result;try{result=calculateAttendancePayroll(employee,[day],ot,policies,travel,calendar);}catch(error){fail(error.message);}
 const detail=result.calculation_detail.attendance.find(row=>row.workDate===date);
 return {...labourDayFacts({employeeId,date,day:{...day,...detail},basic:result.attendance_basic,ot:result.overtime_pay,late:result.late_deduction,source:'HR attendance and dated payroll rules',warnings:result.calculation_detail.warnings.map(row=>row.message)}),employee:employee.name};
}
export async function labourReservations(connection,employeeId,date,basis){
 const [rows]=await connection.execute(`SELECT l.labour_hours hours,l.amount,l.labour_snapshot snapshot FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id
   WHERE l.employee_id=? AND l.source='Labour' AND s.work_date=? AND s.status IN ('Submitted','Approved') ORDER BY l.id`,[employeeId,date]);
 const [[payroll]]=await connection.execute("SELECT COUNT(*) n FROM payroll_project_allocations WHERE employee_id=? AND work_date=? AND source_type IN ('Attendance','Attendance OT','Overtime')",[employeeId,date]);
 const legacy=rows.some(row=>row.hours==null),conflict=rows.some(row=>row.snapshot&&parse(row.snapshot).basisKey!==basis.basisKey);
 return {reservedHours:legacy?basis.workedHours:hours(rows.reduce((sum,row)=>sum+Number(row.hours||0),0)),reservedAmount:cash(rows.reduce((sum,row)=>sum+Number(row.amount||0),0)),blockedReason:Number(payroll.n)?'This employee/date is already cost-allocated from payroll.':legacy?'A full-day manual labour cost already reserves this employee/date.':conflict?'Earlier allocations use different HR hours/pay. Return them for correction before adding more.':null};
}
