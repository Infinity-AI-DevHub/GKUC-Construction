import test from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL_HR_RULES,suggestOvertime,calculateLateDeduction,calculateTransport} from '../src/lib/hr-payroll-rules.js';
import {calculatePayslip,resolveLateRate,resolveOvertimeRate,overtimeMinimumMinutes} from '../src/lib/payroll-policy.js';

const rules={...INITIAL_HR_RULES};
const policy={office_ot_rate:225,site_labour_site_ot_rate:225,site_labour_travel_ot_rate:100,driver_ot_rate:225,driver_site_ot_rate:100,driver_travel_ot_rate:225,supervisor_site_ot_rate:225,supervisor_travel_ot_rate:100,hr_rules:rules};

test('OT is actual-minute pay after the configured category minimum, without quarter-hour rounding',()=>{
  assert.equal(suggestOvertime({state:'On site',check_in:'07:30',check_out:'17:00'},rules,30).hours,0.5);
  assert.equal(suggestOvertime({state:'On site',check_in:'07:30',check_out:'17:07'},rules,30).hours,0.62);
  assert.equal(suggestOvertime({state:'On site',check_in:'07:30',check_out:'17:00'},rules,31).hours,0);
  assert.equal(suggestOvertime({state:'On site',check_in:'07:30',check_out:'17:01'},rules,31).hours,0.52);
});

test('morning OT starts only for check-in at 07:00 or earlier and combines with evening time',()=>{
  assert.equal(suggestOvertime({state:'On site',check_in:'07:01',check_out:'16:30'},rules,30).hours,0);
  assert.equal(suggestOvertime({state:'On site',check_in:'07:00',check_out:'16:30'},rules,30).hours,0.5);
  assert.equal(suggestOvertime({state:'On site',check_in:'07:00',check_out:'16:45'},rules,30).hours,0.75);
});

test('the category policy specifies rates, late rates and 30/31/45-minute OT thresholds',()=>{
  const cases=[
    [{payroll_category:'Office employee'},'Office',225,225,30],
    [{payroll_category:'Site labourer'},'Site',225,225,30],
    [{payroll_category:'Site labourer'},'Travel',100,225,45],
    [{payroll_category:'Supervisor'},'Site',225,225,30],
    [{payroll_category:'Supervisor'},'Travel',100,225,45],
    [{payroll_category:'Driver'},'Site',100,100,31],
    [{payroll_category:'Driver'},'Travel',225,100,30]
  ];
  for(const [employee,type,otRate,lateRate,minimum] of cases){
    assert.equal(resolveOvertimeRate(employee,type,policy),otRate);
    assert.equal(resolveLateRate(employee,policy),lateRate);
    assert.equal(overtimeMinimumMinutes(employee,type,policy),minimum);
  }
});

test('late deduction ignores the first 15 minutes and charges actual minutes after that',()=>{
  const amount=time=>calculateLateDeduction({check_in:time,state:'Late'},rules,225);
  assert.equal(amount('07:45').amount,0);
  assert.equal(amount('07:46').deductibleMinutes,1);
  assert.equal(amount('07:46').amount,3.75);
  assert.equal(amount('08:00').deductibleMinutes,15);
  assert.equal(amount('08:12').deductibleMinutes,27);
  assert.equal(amount('08:12').amount,101.25);
});

test('attendance basic supplied by the daily calculation is preserved in the payslip',()=>{
  const result=calculatePayslip({daily_rate:1800,days_present:1,attendance_basic:2700,paid_leave_days:0,overtime_pay:0,salary_advance:0},{},[]);
  assert.equal(result.basic,2700);
});

// HR supplies variable allowance amounts; a policy rate does not create an entitlement.
test('manual transport preserves HR amounts without a full-transport threshold',()=>{
  for(const amount of [300,725.50]) {
    assert.equal(calculateTransport(amount,1,'Manually approved amount',rules).amount,amount);
    assert.equal(calculateTransport(amount,20,'Manually approved amount',rules).amount,amount);
  }
  assert.throws(()=>calculateTransport(725.50,1,'Attendance-prorated amount',rules),/configure.*threshold/);
});
