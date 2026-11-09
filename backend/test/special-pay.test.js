import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateAttendancePayroll} from '../src/lib/attendance-payroll.js';
import {calculatePayslip} from '../src/lib/payroll-policy.js';
import {payslipDetail} from '../src/lib/payslip-detail.js';
import {payrollSheets,payslipDocument} from '../src/lib/payroll-export.js';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';
import {calculatePayrollLeave} from '../src/lib/payroll-leave.js';
import {operatorPayrollDays,SPECIAL_PAY_RATES} from '../src/lib/special-pay.js';
const policy={id:1,company_id:1,effective_from:'2025-01-01',site_labour_site_ot_rate:999,site_labour_travel_ot_rate:999,hr_rules:INITIAL_HR_RULES};
const day=(date='2026-01-01',extra={})=>({id:Number(date.slice(-2)),work_date:date,state:'Checked out',check_in:'07:30:00',check_out:'16:30:00',work_location:'Site',...extra});
const emp=(mode,inputs=[])=>({id:1,daily_rate:1000,payroll_company_id:1,payroll_category:'Site labourer',worker_type:'Site',
  special_pay_rules:[{id:1,mode,effective_from:'2026-01-01',rates:{...SPECIAL_PAY_RATES}}],special_pay_days:inputs});
const input=(work_date,work_kind,extra={})=>({id:1,work_date,work_kind,recorded_by:7,reason:'HR checked',...extra});
const calc=(employee,days,ot=[],calendar=days)=>calculateAttendancePayroll(employee,days,ot,[policy],[],calendar);

test('Bass/Gola eight-hour short days and agreed OT override ordinary rates',()=>{
  const days=[day(),day('2026-01-02',{check_out:'11:30:00'}),day('2026-01-03',{check_out:'17:00:00'})];
  const result=calc(emp('Work role',[input('2026-01-01','Bass'),input('2026-01-02','Gola'),input('2026-01-03','Gola')]),days);
  assert.equal(result.attendance_basic,6750);assert.equal(result.site_ot_pay,112.5);
  assert.equal(result.calculation_detail.attendance[0].specialPay.workKind,'Bass');
  assert.equal(result.calculation_detail.attendance[1].shortDay.earnedBasic,1250);
  assert.equal(result.calculation_detail.attendance[0].specialPay.recordedBy,7);
});
test('effective dates, missing choices, review flags and invalid times are enforced',()=>{
  assert.equal(calc(emp('Work role'),[day('2025-12-31')]).attendance_basic,1000);
  assert.throws(()=>calc(emp('Work role'),[day()]),/Record HR daily work/);
  assert.throws(()=>calc(emp('Work role',[input('2026-01-01','Bass')]),[day(undefined,{needs_review:1})]),/Confirm review-required/);
  assert.throws(()=>calc(emp('Work role',[input('2026-01-01','Bass')]),[day(undefined,{check_out:null})]),/valid check-in/);
});
test('operator meter minimum and standby basic exclude late and machine-day OT',()=>{
  const days=[day(),day('2026-01-02',{check_in:'10:00:00',check_out:'18:00:00'}),day('2026-01-03',{check_out:'11:30:00'})];
  const result=calc(emp('Machine operator',[input('2026-01-01','Machine',{start_meter:7284,end_meter:7290}),
    input('2026-01-02','Machine',{start_meter:7290,end_meter:7292}),input('2026-01-03','Standby',{hours:4})]),days);
  assert.equal(result.attendance_basic,6600);assert.equal(result.overtime_pay,0);assert.equal(result.late_deduction,0);
  assert.deepEqual(result.calculation_detail.attendance.map(row=>row.specialPay.transport),[300,300,300]);
  assert.equal(result.calculation_detail.attendance[0].specialPay.meterHours,6);
  assert.throws(()=>calc(emp('Machine operator',[input('2026-01-01','Machine',{start_meter:10,end_meter:16})]),[day()],
    [{work_date:'2026-01-01',overtime_type:'Site',hours:1,status:'Approved'}]),/Operator OT is allowed only/);
});
test('extra monthly days use role rate times 1.5 and fixed 2700 operator basic; months reset',()=>{
  const days=Array.from({length:26},(_,i)=>day(`2026-01-${String(i+1).padStart(2,'0')}`));
  const inputs=days.map(row=>input(row.work_date,'Machine',{start_meter:100,end_meter:106}));
  assert.equal(calc(emp('Machine operator',inputs),[days[25]],[],days).attendance_basic,2700);
  assert.equal(calc(emp('Work role',[input('2026-01-26','Bass')]),[days[25]],[],days).attendance_basic,4500);
  const feb=day('2026-02-01');
  assert.equal(calc(emp('Machine operator',[...inputs,input(feb.work_date,'Machine',{start_meter:106,end_meter:112})]),[feb],[],[...days,feb]).attendance_basic,3900);
});
test('role Travel OT retains the 31 minute threshold and 100 hourly rate',()=>{
  const employee=emp('Work role',[input('2026-01-01','Bass')]);
  const ot=minutes=>[{work_date:'2026-01-01',overtime_type:'Travel',hours:minutes/60,status:'Approved'}];
  assert.equal(calc(employee,[day(undefined,{check_out:'17:01:00'})]).site_ot_pay,116.25);
  assert.equal(calc(employee,[day()],ot(30)).travel_ot_pay,0);
  assert.equal(calc(employee,[day()],ot(31)).travel_ot_pay,51.67);
});
test('saved special earnings, transport and advance reconcile in exports without current inputs',()=>{
  const employee=emp('Machine operator',[input('2026-01-01','Machine',{start_meter:10,end_meter:16})]);
  const result=calc(employee,[day()]);
  const values=calculatePayslip({...employee,...result,days_present:1,paid_leave_days:0,salary_advance:500},policy,[{kind:'Allowance',amount:300}],'Daily');
  assert.equal(values.basic,3900);assert.equal(values.netPay,3700);
  const run={periodStart:'2026-01-01',periodEnd:'2026-01-01',company:'Test',reference:'TEST',payslips:[]};
  const slip={employeeCode:'OP',employee:'Operator',basic:3900,overtimePay:0,lateDeduction:0,netPay:3700,
    calculationDetail:{...result.calculation_detail,sourceAttendance:[{workDate:'2026-01-01',state:'Checked out'}]},
    components:[{name:'Transport',kind:'Allowance',amount:300,calculationDetail:JSON.stringify({date:'2026-01-01'})}]};
  run.payslips=[slip];assert.equal(payslipDetail(run,slip).reconciliation.basic,0);
  assert.ok(payrollSheets(run).some(sheet=>sheet.name==='Special daily pay'));
  const names=payrollSheets({...run,payslips:[{...slip,employeeCode:'Special',employee:'daily pay'}]}).map(sheet=>sheet.name.toLowerCase());
  assert.equal(new Set(names).size,names.length,'special detail sheet names cannot collide with employee sheets');
  assert.match(payslipDocument(run,slip),/max\(1800, 6 × 650\)/);
  assert.doesNotMatch(payslipDocument(run,slip),/<td>Late deduction<\/td>/);
  employee.special_pay_days[0].end_meter=12;
  assert.equal(payslipDetail(run,slip).days[0].basic,3900);
});

test('a later Standard rule restores normal pay without deleting the earlier agreement',()=>{
  const employee=emp('Work role',[input('2026-01-01','Bass')]);
  employee.special_pay_rules.push({id:2,effective_from:'2026-02-01',mode:'Standard'});
  assert.equal(calc(employee,[day()]).attendance_basic,3000);
  assert.equal(calc(employee,[day('2026-02-01')]).attendance_basic,1000);
});

test('operator Standby pays normal labour Site OT from 30 minutes, with exact minutes and no late',()=>{
  const employee=emp('Machine operator',[input('2026-01-01','Standby',{hours:8})]);
  const policy225={...policy,site_labour_site_ot_rate:225};
  const compute=(checkOut,ot=[])=>calculateAttendancePayroll(employee,[day(undefined,{check_in:'08:00:00',check_out:checkOut})],ot,[policy225]);
  assert.equal(compute('16:59:00').site_ot_pay,0);
  assert.equal(compute('17:00:00').site_ot_pay,112.5);
  const result=compute('17:01:00');
  assert.equal(result.site_ot_pay,116.25);assert.equal(result.late_deduction,0);
  assert.equal(result.attendance_basic,1800);assert.equal(result.calculation_detail.attendance[0].specialPay.transport,300);
  assert.equal(calc(employee,[day(undefined,{check_out:'17:00:00'})]).site_ot_pay,499.5,'use the dated labour rate, not the operator meter rate or role preset');
  assert.equal(compute('17:00:00',[{work_date:'2026-01-01',overtime_type:'Site',hours:0.5,status:'Approved'}]).site_ot_pay,112.5);
  assert.throws(()=>compute('17:00:00',[{work_date:'2026-01-01',overtime_type:'Travel',hours:1,status:'Approved'}]),/Operator OT is allowed only/);
});


test('only active Machine records replace missing operator attendance, with unpaid absence otherwise',()=>{
  const employee=emp('Machine operator',[input('2026-01-01','Machine',{start_meter:10,end_meter:12.6})]);
  const derived=operatorPayrollDays(employee,[],'2026-01-01','2026-01-02');
  const leave=calculatePayrollLeave(employee,derived,[],'2026-01-01','2026-01-02');
  assert.equal(leave.days_present,1);assert.equal(leave.days_absent,1);
  const result=calc(employee,leave.attendance,[],derived);
  assert.equal(result.attendance_basic,1800);
  assert.equal(result.calculation_detail.attendance[0].specialPay.transport,300);
  assert.equal(result.overtime_pay,0);assert.equal(result.late_deduction,0);
  assert.equal(derived[0].special_pay_input_id,1);assert.equal(derived[0].id,null);
  assert.deepEqual(operatorPayrollDays(emp('Work role',[]),[],'2026-01-01','2026-01-02'),[]);
  assert.deepEqual(operatorPayrollDays({...employee,special_pay_rules:[{mode:'Standard',effective_from:'2026-01-01'}]},[],'2026-01-01','2026-01-02'),[]);
  const archived={...employee,special_pay_days:[{...employee.special_pay_days[0],active:0}]};
  assert.equal(operatorPayrollDays(archived,[],'2026-01-01','2026-01-01')[0].state,'Absent');
});

test('operator machine evidence preserves real attendance, blocks contradictory absence/leave and requires standby attendance',()=>{
  const machine=emp('Machine operator',[input('2026-01-01','Machine',{start_meter:10,end_meter:16})]);
  const actual=[day()];assert.deepEqual(operatorPayrollDays(machine,actual,'2026-01-01','2026-01-01'),actual);
  assert.throws(()=>operatorPayrollDays(machine,[day(undefined,{state:'Absent'})],'2026-01-01','2026-01-01'),/conflicts/);
  assert.throws(()=>calculatePayrollLeave(machine,operatorPayrollDays(machine,[],'2026-01-01','2026-01-01'),[{employee_id:1,status:'Approved',from_date:'2026-01-01',to_date:'2026-01-01',payment_type:'Paid'}],'2026-01-01','2026-01-01'),/conflicts/);
  const standby=emp('Machine operator',[input('2026-01-01','Standby',{hours:8})]);
  assert.equal(operatorPayrollDays(standby,[],'2026-01-01','2026-01-01')[0].state,'Absent');
  assert.equal(calc(standby,operatorPayrollDays(standby,[],'2026-01-01','2026-01-01')).attendance_basic,0);
});

test('machine-only work counts once toward monthly premium, including earlier dates outside run',()=>{
  const inputs=Array.from({length:26},(_,i)=>input(`2026-01-${String(i+1).padStart(2,'0')}`,'Machine',{start_meter:10,end_meter:16}));
  const employee=emp('Machine operator',inputs);
  const calendar=operatorPayrollDays(employee,[],'2026-01-01','2026-01-26');
  assert.equal(calc(employee,[calendar[25]],[],calendar).attendance_basic,2700);
  assert.equal(calc(employee,calendar,[],calendar).attendance_basic,25*3900+2700);
});
