import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePayrollLeave} from '../src/lib/payroll-leave.js';
import {calculatePayslip} from '../src/lib/payroll-policy.js';
import {calculateAttendancePayroll} from '../src/lib/attendance-payroll.js';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';

const employee={id:1,join_date:'2020-01-01',daily_rate:1600,pay_frequency:'Monthly'};
const request={id:1,employee_id:1,from_date:'2026-10-02',to_date:'2026-10-02',status:'Approved',payment_type:'Paid',leave_type:'Annual'};
const attendance=[{id:1,work_date:'2026-10-01',state:'Checked out',check_in:'07:30',check_out:'16:30'}];
const run=(days=attendance,requests=[request],from='2026-10-01',to='2026-10-31',person=employee)=>calculatePayrollLeave(person,days,requests,from,to);

test('one worked day plus one paid and one unpaid leave pays two days, not one or three',()=>{
  const leave=run(attendance,[request,{...request,id:2,from_date:'2026-10-03',to_date:'2026-10-03',payment_type:'Unpaid'}]);
  const result=calculatePayslip({...employee,...leave,overtime_pay:0,salary_advance:0},{},[]);
  assert.equal(leave.days_present,1);
  assert.equal(result.paidLeaveDays,1);
  assert.equal(result.unpaidLeaveDays,1);
  assert.equal(result.payableDays,2);
  assert.equal(result.basic,3200);
  assert.equal(result.paidLeavePay,1600);
  assert.equal(result.unpaidLeaveDeduction,0);
  assert.equal(result.netPay,3200);
});

test('reproduced LKR 1600 paid-leave shortfall is restored exactly',()=>{
  const days=Array.from({length:20},(_,i)=>({work_date:`2026-10-${String(i+1).padStart(2,'0')}`,state:'On site'}));
  const leave=run(days,[{...request,from_date:'2026-10-21',to_date:'2026-10-21'},
    {...request,id:2,from_date:'2026-10-22',to_date:'2026-10-22',payment_type:'Unpaid'}]);
  const result=calculatePayslip({...employee,...leave,overtime_pay:0,salary_advance:0},{},[]);
  assert.equal(result.basic,33600);
  assert.equal(result.basic-20*1600,1600);
});

test('approved paid leave pays even without an attendance record and replaces Absent/On leave markers',()=>{
  for(const state of [null,'Absent','On leave']) {
    const leave=run(state?[{work_date:'2026-10-02',state}]:[]);
    assert.equal(leave.paid_leave_days,1);
    assert.equal(leave.days_present,0);
    assert.equal(leave.days_absent,0);
    assert.equal(leave.leave_days_for_transport,1);
    assert.equal(leave.attendance[0].state,'On leave');
  }
});

test('pending/rejected leave and another employee never add salary',()=>{
  for(const requestOverride of [{status:'Pending'},{status:'Rejected'},{employee_id:2}])
    assert.equal(run([], [{...request,...requestOverride}]).paid_leave_days,0);
});

test('leave is clipped to period and employment dates, including month/year boundaries',()=>{
  const spanning={...request,from_date:'2025-12-28',to_date:'2026-01-04'};
  assert.equal(run([], [spanning],'2026-01-01','2026-01-02').paid_leave_days,2);
  assert.equal(run([], [spanning],'2026-01-01','2026-01-04',{...employee,join_date:'2026-01-03'}).paid_leave_days,2);
  assert.equal(run([], [spanning],'2026-02-01','2026-02-28').paid_leave_days,0);
});

test('duplicate paid dates and duplicate worked dates are never counted twice',()=>{
  const result=run([...attendance,{...attendance[0],id:2},{...attendance[0],id:3,state:'Absent'},
    {...attendance[0],id:4,state:'On leave'}],[request,{...request,id:3}]);
  assert.equal(result.days_present,1);
  assert.equal(result.paid_leave_days,1);
  assert.equal(result.days_absent,0);
  assert.equal(result.leave_days_for_transport,1);
});

test('conflicting paid/unpaid requests and worked attendance stop calculation for review',()=>{
  assert.throws(()=>run([], [request,{...request,id:2,payment_type:'Unpaid'}]),/Paid and unpaid leave overlap/);
  for(const payment_type of ['Paid','Unpaid'])assert.throws(()=>run([{...attendance[0],work_date:'2026-10-02'}], [{...request,payment_type}]),/conflicts with worked attendance/);
});

test('paid leave generates neither OT nor lateness and contradicting approved OT is blocked',()=>{
  const leave=run([{work_date:'2026-10-02',state:'Absent'}]);
  const person={...employee,payroll_company_id:1,payroll_category:'Site labourer'};
  const policies=[{id:1,company_id:1,effective_from:'2020-01-01',site_labour_site_ot_rate:200,hr_rules:INITIAL_HR_RULES}];
  const result=calculateAttendancePayroll(person,leave.attendance,[],policies);
  assert.equal(result.overtime_pay,0);
  assert.equal(result.late_deduction,0);
  assert.throws(()=>calculateAttendancePayroll(person,leave.attendance,[{id:1,work_date:'2026-10-02',status:'Approved',overtime_type:'Site',hours:1}],policies),/absent\/leave/);
});

test('statutory contributions always use the full monthly basis regardless of paid or unpaid days',()=>{
  const result=calculatePayslip({...employee,days_present:20,paid_leave_days:1,unpaid_leave_days:1,
    basic_salary:40000,epf_eligible:true,etf_eligible:true,overtime_pay:0,salary_advance:0},
    {epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3},[]);
  assert.equal(result.contributionBase,40000);
  assert.equal(result.epfEmployeeDeduction,3200);
  assert.equal(result.etfEmployerContribution,1200);
  assert.equal(calculatePayslip({...employee,days_present:25,paid_leave_days:2,basic_salary:40000,
    overtime_pay:0,salary_advance:0},{},[]).contributionBase,40000);
});

test('missing paid-leave salary rate fails clearly instead of silently paying zero',()=>{
  assert.throws(()=>run([], [request],'2026-10-01','2026-10-31',{...employee,daily_rate:0}),/daily salary rate/);
});
