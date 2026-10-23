import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePayslip} from '../src/lib/payroll-policy.js';

const employee={basic_salary:30000,daily_rate:1600,days_present:17,paid_leave_days:1,unpaid_leave_days:1,
  overtime_pay:2250,salary_advance:0,pay_frequency:'Monthly',epf_eligible:true,etf_eligible:true};
const policy={epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3};

test('screenshot example uses LKR 30000 directly, not LKR 30000 / 25 * 18',()=>{
  const result=calculatePayslip(employee,policy);
  assert.equal(result.basic,28800);
  assert.equal(result.contributionBase,30000);
  assert.equal(result.epfEmployeeDeduction,2400);
  assert.equal(result.epfEmployerContribution,3600);
  assert.equal(result.etfEmployerContribution,900);
  assert.equal(result.deductions,2400);
  assert.equal(result.netPay,28650);
  assert.equal(result.employerCost,35550);
});

for(const frequency of ['Daily','Weekly'])test(`${frequency} payroll never calculates employee EPF, employer EPF or ETF`,()=>{
  const result=calculatePayslip({...employee,pay_frequency:frequency},policy);
  assert.equal(result.contributionBase,0);
  assert.equal(result.epfEmployeeDeduction,0);
  assert.equal(result.epfEmployerContribution,0);
  assert.equal(result.etfEmployerContribution,0);
  assert.equal(result.deductions,0);
  assert.equal(result.netPay,31050);
  assert.equal(result.employerCost,31050);
});

test('the actual payroll run frequency controls contributions, not a mismatched profile frequency',()=>{
  assert.equal(calculatePayslip({...employee,pay_frequency:'Weekly'},policy,[],'Monthly').epfEmployeeDeduction,2400);
  assert.equal(calculatePayslip(employee,policy,[],'Weekly').epfEmployeeDeduction,0);
  assert.equal(calculatePayslip({...employee,pay_frequency:undefined},policy).epfEmployeeDeduction,0);
});

test('attendance, leave, partial periods and legacy conversion factors never prorate a monthly contribution',()=>{
  for(const days of [0,1,18,25,31]) {
    const result=calculatePayslip({...employee,days_present:days,paid_leave_days:0},
      {...policy,statutory_rules:JSON.stringify({dailyDaysPerMonth:1,weeklyWeeksPerMonth:999})});
    assert.equal(result.contributionBase,30000);
    assert.equal(result.epfEmployeeDeduction,2400);
    assert.equal(result.epfEmployerContribution,3600);
    assert.equal(result.etfEmployerContribution,900);
  }
});

test('monthly EPF/ETF eligibility remains independent',()=>{
  const epfOnly=calculatePayslip({...employee,etf_eligible:false},policy);
  assert.equal(epfOnly.epfEmployeeDeduction,2400);assert.equal(epfOnly.etfEmployerContribution,0);
  const etfOnly=calculatePayslip({...employee,epf_eligible:false},policy);
  assert.equal(etfOnly.epfEmployeeDeduction,0);assert.equal(etfOnly.epfEmployerContribution,0);
  assert.equal(etfOnly.etfEmployerContribution,900);
});
