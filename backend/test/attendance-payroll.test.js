import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAttendancePayroll,subtractIntervals,attendanceOvertimeType} from '../src/lib/attendance-payroll.js';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';
import {calculatePayslip} from '../src/lib/payroll-policy.js';

const policy={id:1,company_id:1,effective_from:'2026-01-01',office_ot_rate:225,
  site_labour_site_ot_rate:200,site_labour_travel_ot_rate:100,driver_ot_rate:250,
  driver_site_ot_rate:275,driver_travel_ot_rate:125,supervisor_site_ot_rate:300,
  supervisor_travel_ot_rate:150,hr_rules:{...INITIAL_HR_RULES,customSiteOtRate:350,customOfficeOtRate:400}};
const employee={id:1,payroll_company_id:1,payroll_category:'Site labourer',worker_type:'Site',daily_rate:3200};
const day={id:1,work_date:'2026-10-01',check_in:'08:15:00',check_out:'17:30:00',state:'Checked out',work_location:'Unassigned'};
const calculate=(e=employee,days=[day],ot=[],policies=[policy],claims=[])=>calculateAttendancePayroll(e,days,ot,policies,claims);

test('imported punches automatically pay quarter-hour OT and deduct minute-based lateness',()=>{
  const result=calculate();
  assert.equal(result.site_ot_hours,0.75);
  assert.equal(result.overtime_pay,150);
  assert.equal(result.late_minutes,45);
  assert.equal(result.late_deduction,100);
  assert.equal(result.calculation_detail.overtime[0].source,'Attendance');
});
for(const [time,hours] of [['16:45',0],['16:59',0],['17:00',0.25],['17:15',0.5]])
  test(`automatic attendance OT at ${time}`,()=>assert.equal(calculate(employee,[{...day,check_out:time}]).overtime_hours,hours));

test('all categories and driver work locations resolve central payroll rates without requiring a location',()=>{
  for(const [category,workerType,location,rate] of [
    ['Office employee','Site','Unassigned',225],['Site labourer','Site','Office',200],
    ['Supervisor','Site','Unassigned',300],['Driver','Office','Unassigned',250],
    ['Driver','Site','Site',275],['Driver','Site','Unassigned',250],['Custom','Site','Unassigned',350],['Custom','Office','Office',400]
  ])assert.equal(calculate({...employee,payroll_category:category,worker_type:workerType},[{...day,work_location:location}]).overtime_pay,rate*0.75);
  assert.equal(attendanceOvertimeType({...employee,payroll_category:'Office employee'},day),'Office');
});

test('each work date uses its effective policy, not the policy on the payroll period end',()=>{
  const changed={...policy,id:2,effective_from:'2026-10-02',site_labour_site_ot_rate:400,
    hr_rules:{...INITIAL_HR_RULES,normalStart:'08:00',otGraceMinutes:30}};
  const result=calculate(employee,[day,{...day,id:2,work_date:'2026-10-02'}],[],[changed,policy]);
  assert.equal(result.overtime_pay,150+200);
  assert.equal(result.late_deduction,100);
  assert.deepEqual(result.calculation_detail.attendance.map(row=>row.policyId),[1,2]);
});

test('reviewed OT replaces automatic hours and uses dated policy rates, never old stored rates',()=>{
  const result=calculate(employee,[day],[{id:8,work_date:day.work_date,status:'Approved',overtime_type:'Site',hours:2,rate:999}]);
  assert.equal(result.overtime_hours,2);
  assert.equal(result.overtime_pay,400);
  assert.equal(result.calculation_detail.overtime.length,1);
});
for(const status of ['Pending','Rejected'])test(`${status} HR decision is never overridden by automatic OT`,()=>{
  assert.equal(calculate(employee,[day],[{work_date:day.work_date,status,overtime_type:'Site'}]).overtime_pay,0);
});

test('travel is separate and its interval is removed before automatic Office/Site rounding',()=>{
  const result=calculate(employee,[{...day,check_out:'18:00'}],[{id:3,work_date:day.work_date,
    overtime_type:'Travel',status:'Approved',hours:0.5,rate:999,input_detail:{intervals:[[1050,1080]]}}]);
  assert.equal(result.site_ot_hours,0.75);
  assert.equal(result.travel_ot_hours,0.5);
  assert.equal(result.travel_ot_pay,50);
  assert.equal(result.overtime_pay,200);
  assert.throws(()=>calculate(employee,[day],[{work_date:day.work_date,overtime_type:'Travel',hours:1,status:'Approved',rate:100}]),/travel time intervals/);
  assert.deepEqual(subtractIntervals([[1000,1100]],[[1020,1050],[1040,1080]]),[[1000,1020],[1080,1100]]);
});

test('absent, leave and unresolved punches never invent OT',()=>{
  for(const state of ['Absent','On leave']) {
    const result=calculate(employee,[{...day,state}]);
    assert.equal(result.overtime_pay,0);
    assert.equal(result.late_deduction,0);
  }
  assert.equal(calculate(employee,[{...day,check_out:null}]).overtime_pay,0);
  assert.equal(calculate(employee,[{...day,needs_review:1}]).overtime_pay,0);
  assert.equal(calculate(employee,[{...day,needs_review:1}]).late_deduction,0);
});

test('missing effective policy and missing salary rate produce actionable errors',()=>{
  assert.throws(()=>calculate(employee,[day],[],[]),/effective on or before/);
  assert.throws(()=>calculate({...employee,daily_rate:0}),/daily salary rate/);
});

test('late deduction reduces recoverable advance rather than consuming the same money twice',()=>{
  const result=calculatePayslip({daily_rate:3200,days_present:1,overtime_pay:0,salary_advance:5000,
    late_deduction:100},{},[]);
  assert.equal(result.salaryAdvanceDeduction,3100);
  assert.equal(result.deductions,3200);
  assert.equal(result.netPay,0);
});

test('contradictory or duplicate approved OT cannot silently double payroll',()=>{
  const record={id:1,work_date:day.work_date,overtime_type:'Site',hours:1,rate:200,status:'Approved'};
  assert.throws(()=>calculate(employee,[day],[record,{...record,id:2}]),/duplicate approved/);
  assert.throws(()=>calculate(employee,[{...day,state:'Absent'}],[record]),/absent\/leave/);
});

test('rounded OT lines reconcile with the payslip and project allocation amounts',()=>{
  const result=calculate(employee,[day,{...day,id:2,work_date:'2026-10-02'},{...day,id:3,work_date:'2026-10-03'}],[],
    [{...policy,site_labour_site_ot_rate:225.01}]);
  assert.equal(result.overtime_pay,Number(result.calculation_detail.overtime.reduce((sum,row)=>sum+row.amount,0).toFixed(2)));
});

test('two normal hours earn two eighths of the daily rate with no duplicate late deduction',()=>{
  const result=calculate({...employee,daily_rate:1600},[{...day,check_in:'07:30',check_out:'09:30'}]);
  assert.equal(result.short_day_reduction,1200);
  const slip=calculatePayslip({...employee,daily_rate:1600,days_present:1,paid_leave_days:0,salary_advance:0,...result},policy,[],'Daily');
  assert.equal(slip.basic,400);assert.equal(slip.netPay,400);assert.equal(slip.lateDeduction,0);
});

test('short-day reduction and late deduction cover missing time once, without using OT as basic hours',()=>{
  const result=calculate({...employee,daily_rate:1600},[{...day,check_in:'09:30',check_out:'11:30'}]);
  assert.equal(result.late_deduction,300);assert.equal(result.short_day_reduction,900);
  const slip=calculatePayslip({...employee,daily_rate:1600,days_present:1,salary_advance:0,...result},policy,[],'Daily');
  assert.equal(slip.netPay,400);
  const withOt=calculate({...employee,daily_rate:1600},[{...day,check_in:'05:30',check_out:'09:30'}]);
  assert.equal(withOt.short_day_reduction,1200);assert.equal(withOt.site_ot_hours,2);
});

test('full day, paid leave and incomplete or reviewed punches do not invent short-day reductions',()=>{
  assert.equal(calculate(employee,[{...day,check_in:'07:30',check_out:'16:30'}]).short_day_reduction,0);
  for(const extra of [{check_out:null},{needs_review:1},{state:'On leave'},{state:'Absent'}]) {
    const result=calculate(employee,[{...day,...extra}]);assert.equal(result.short_day_reduction,0);
  }
  const missing=calculate(employee,[{...day,check_out:null}]);
  assert.ok(missing.calculation_detail.warnings.some(row=>row.message.includes('short-day')));
});

test('short-day rate follows effective paid hours and leaves the EPF basis unchanged',()=>{
  const p={...policy,hr_rules:{...policy.hr_rules,paidHoursPerDay:4}};
  const result=calculate({...employee,daily_rate:1600},[{...day,check_in:'07:30',check_out:'09:30'}],[],[p]);
  assert.equal(result.short_day_reduction,800);
  const slip=calculatePayslip({...employee,daily_rate:1600,basic_salary:30000,epf_eligible:true,etf_eligible:true,days_present:1,salary_advance:0,...result},
    {...p,epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3},[],'Monthly');
  assert.equal(slip.basic,800);assert.equal(slip.epfEmployeeDeduction,2400);assert.equal(slip.contributionBase,30000);
});
