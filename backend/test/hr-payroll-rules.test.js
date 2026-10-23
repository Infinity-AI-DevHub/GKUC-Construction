import test from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL_HR_RULES,suggestOvertime,intervalsOverlap,calculateTransport,calculateMileage,calculateLongDistance,calculateLateDeduction} from '../src/lib/hr-payroll-rules.js';
import {calculatePayslip,resolveOvertimeRate} from '../src/lib/payroll-policy.js';
const rules={...INITIAL_HR_RULES,fullTransportDays:20};
test('daily rate paid weekly keeps attendance-based basic earnings',()=>assert.equal(calculatePayslip({pay_basis:'Daily rate',daily_rate:2500,days_present:5,overtime_pay:0,unpaid_days:0,salary_advance:0},{},[]).basic,12500));
test('early work and evening OT exclude the first evening quarter hour',()=>assert.equal(suggestOvertime({state:'On site',check_in:'07:00',check_out:'17:30'},rules).hours,1.25));
for (const [checkOut, expected] of [['16:44',0],['16:45',0],['16:59',0],['17:00',0.25],['17:14',0.25],['17:15',0.5],['17:30',0.75]]) {
  test(`16:30 shift end and ${checkOut} checkout pays ${expected} OT hours`,()=>{
    assert.equal(suggestOvertime({state:'On site',check_in:'07:30',check_out:checkOut},rules).hours,expected);
  });
}
test('driver office, site and travel OT use independent policy rates',()=>{
  const employee={payroll_category:'Driver'};
  const policy={driver_ot_rate:225,driver_site_ot_rate:250,driver_travel_ot_rate:100};
  assert.equal(resolveOvertimeRate(employee,'Office',policy),225);
  assert.equal(resolveOvertimeRate(employee,'Site',policy),250);
  assert.equal(resolveOvertimeRate(employee,'Travel',policy),100);
  assert.equal(resolveOvertimeRate(employee,'Travel',{driver_ot_rate:225}),225);
});
for(const state of ['Absent','On leave'])test(`no OT for ${state}`,()=>assert.equal(suggestOvertime({state,check_in:'07:00',check_out:'17:30'},rules).hours,0));
test('Site and Travel intervals can be adjacent but not overlap',()=>{assert.equal(intervalsOverlap([[420,450],[990,1050]],[[1050,1110]]),false);assert.equal(intervalsOverlap([[420,450]],[[430,490]]),true);});
test('rounding floors hours and respects minimum',()=>{assert.equal(suggestOvertime({state:'On site',check_in:'07:29',check_out:'16:40'},rules).hours,0);});
test('full transport at configured inclusive threshold',()=>assert.equal(calculateTransport(3000,20,'Attendance-prorated amount',rules).amount,3000));
test('transport below threshold prorates 3000 / 25 × 19 = 2280',()=>assert.equal(calculateTransport(3000,19,'Attendance-prorated amount',rules).amount,2280));
test('strict threshold remains separately configurable',()=>assert.equal(calculateTransport(3000,20,'Attendance-prorated amount',{...rules,fullTransportComparison:'More than'}).amount,2400));
test('unconfirmed threshold cannot silently pay full transport',()=>assert.throws(()=>calculateTransport(3000,19,'Attendance-prorated amount',INITIAL_HR_RULES),/configure/));
test('long distance above threshold pays configured allowance',()=>assert.equal(calculateLongDistance(51,rules),500));
test('distance below or equal threshold pays no allowance',()=>{assert.equal(calculateLongDistance(49,rules),0);assert.equal(calculateLongDistance(50,rules),0);});
test('motorcycle reimbursement uses kilometres × rate',()=>assert.equal(calculateMileage({approvedKm:20},rules).total,340));
test('invalid and negative odometers are rejected',()=>{assert.throws(()=>calculateMileage({startOdometer:100,endOdometer:90},rules));assert.throws(()=>calculateMileage({approvedKm:-1},rules));});
test('fixed travel conflicts with mileage unless policy permits',()=>{assert.throws(()=>calculateMileage({approvedKm:20,fixedTravel:true},rules));assert.equal(calculateMileage({approvedKm:20,fixedTravel:true},{...rules,allowMileageAndFixed:true}).total,640);});
test('per-day operator allowance remains separate',()=>assert.equal(calculateTransport(500,5,'Per-day amount',rules).amount,2500));
test('special duty allowance does not change daily rate or monthly EPF basis',()=>{const employee={pay_basis:'Daily rate',pay_frequency:'Monthly',basic_salary:62500,daily_rate:2500,days_present:1,overtime_pay:0,unpaid_days:0,salary_advance:0,epf_eligible:true};const result=calculatePayslip(employee,{epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3},[{kind:'Allowance',amount:500}]);assert.equal(result.basic,2500);assert.equal(result.contributionBase,62500);assert.equal(result.allowanceTotal,500);assert.equal(result.epfEmployeeDeduction,5000);assert.equal(employee.daily_rate,2500);});
test('late arrival deducts each minute beyond the 30-minute grace period',()=>{
  const amount=checkIn=>calculateLateDeduction({check_in:checkIn,state:'Late'},rules,3200).amount;
  assert.equal(amount('08:00'),0,'the first 30 minutes are free');
  assert.equal(amount('07:30'),0);
  assert.equal(amount('07:45'),0);
  assert.equal(amount('08:01'),6.67);
  assert.equal(amount('08:02'),13.33);
  assert.equal(amount('08:15'),100);
  assert.equal(amount('08:16'),106.67);
  assert.equal(amount('08:30'),200);
  assert.equal(amount('09:00'),400);
});
test('late deduction rounds only the final amount',()=>{
  const result=calculateLateDeduction({check_in:'09:00',state:'Late'},rules,1000);
  assert.equal(result.deductibleMinutes,60);
  assert.equal(result.amount,125);
  const fractional=calculateLateDeduction({check_in:'09:00',state:'Late'},{...rules,paidHoursPerDay:7},1000);
  assert.equal(fractional.amount,142.86);
});
test('late deduction is a separate payslip deduction',()=>{const result=calculatePayslip({daily_rate:3200,days_present:1,overtime_pay:0,salary_advance:0,late_deduction:500},{},[]);assert.equal(result.basic,3200);assert.equal(result.lateDeduction,500);assert.equal(result.deductions,500);assert.equal(result.netPay,2700);});
