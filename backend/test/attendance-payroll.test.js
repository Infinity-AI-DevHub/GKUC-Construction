import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAttendancePayroll} from '../src/lib/attendance-payroll.js';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';
import {calculatePayslip} from '../src/lib/payroll-policy.js';

const policy={id:1,company_id:1,effective_from:'2026-01-01',office_ot_rate:225,site_labour_site_ot_rate:225,site_labour_travel_ot_rate:100,driver_ot_rate:225,driver_site_ot_rate:100,driver_travel_ot_rate:225,supervisor_site_ot_rate:225,supervisor_travel_ot_rate:100,hr_rules:{...INITIAL_HR_RULES}};
const employee={id:1,payroll_company_id:1,payroll_category:'Site labourer',worker_type:'Site',daily_rate:1800};
const day={id:1,work_date:'2026-10-01',check_in:'08:15:00',check_out:'18:00:00',state:'Checked out',work_location:'Site'};
const calculate=(e=employee,days=[day],ot=[],policies=[policy],claims=[],calendar=days)=>calculateAttendancePayroll(e,days,ot,policies,claims,calendar);

test('late and OT are independent: 08:15 to 18:00 earns 1.5 OT and charges 30 late minutes',()=>{
  const result=calculate();
  assert.equal(result.site_ot_hours,1.5);assert.equal(result.site_ot_pay,337.5);assert.equal(result.late_minutes,45);assert.equal(result.late_deduction,112.5);assert.equal(result.attendance_basic,1800);
});
test('short-day earnings use actual worked hours while later work avoids a duplicate short-day cut',()=>{
  const short=calculate(employee,[{...day,check_in:'09:30',check_out:'16:30'}]);
  assert.equal(short.attendance_basic,1575);assert.equal(short.short_day_reduction,225);assert.equal(short.late_deduction,393.75);
  const recovered=calculate(employee,[{...day,check_in:'09:30',check_out:'18:00'}]);
  assert.equal(recovered.attendance_basic,1800);assert.equal(recovered.short_day_reduction,0);assert.equal(recovered.late_deduction,393.75);
});
test('driver, labour and supervisor 30/31-minute thresholds are applied to the OT type',()=>{
  const site30={...day,check_in:'07:30',check_out:'17:00'};
  assert.equal(calculate({...employee,payroll_category:'Site labourer'},[site30]).site_ot_hours,0.5);
  assert.equal(calculate({...employee,payroll_category:'Driver'},[site30]).overtime_hours,0);
  assert.equal(calculate({...employee,payroll_category:'Supervisor'},[site30]).site_ot_hours,0.5);
});
test('the whole day becomes 1.5 times daily rate when it pushes monthly worked equivalents beyond 25',()=>{
  const calendar=[];
  for(let index=1;index<=24;index++)calendar.push({id:index,work_date:`2026-10-${String(index).padStart(2,'0')}`,state:'Checked out',check_in:'07:30',check_out:'16:30'});
  calendar.push({id:25,work_date:'2026-10-25',state:'Checked out',check_in:'07:30',check_out:'11:30'});
  const premium={id:26,work_date:'2026-10-26',state:'Checked out',check_in:'07:30',check_out:'16:30'};calendar.push(premium);
  const result=calculate(employee,[premium],[],[policy],[],calendar);
  assert.equal(result.attendance_basic,2700);assert.equal(result.calculation_detail.attendance[0].rateMultiplier,1.5);
});
test('saved attendance basic flows to the payslip while late remains separate',()=>{
  const result=calculatePayslip({daily_rate:1800,days_present:1,attendance_basic:1575,paid_leave_days:0,overtime_pay:0,late_deduction:450,salary_advance:0},policy,[],'Daily');
  assert.equal(result.basic,1575);assert.equal(result.netPay,1125);
});
