import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayslip, payProfileError, resolveOvertimeRate } from '../src/lib/payroll-policy.js';

const basicPolicy = {
  office_ot_rate: 225,
  site_labour_site_ot_rate: 200,
  site_labour_travel_ot_rate: 100,
  driver_ot_rate: 225,
  supervisor_site_ot_rate: 225,
  supervisor_travel_ot_rate: 100,
  epf_employee_rate: 8,
  epf_employer_rate: 12,
  etf_employer_rate: 3,
  epf_basis: 'Basic earnings',
  etf_basis: 'Basic earnings'
};

const grossPolicy = { ...basicPolicy, epf_basis: 'Gross earnings', etf_basis: 'Gross earnings' };
const component = (kind, amount) => ({ kind, amount });
const person = values => ({
  days_present: 0,
  unpaid_days: 0,
  overtime_pay: 0,
  salary_advance: 0,
  basic_salary: 0,
  weekly_rate: 0,
  daily_rate: 0,
  epf_eligible: false,
  etf_eligible: false,
  custom_office_ot_rate: null,
  custom_site_ot_rate: null,
  custom_travel_ot_rate: null,
  ...values
});

const office = person({
  name: 'Nimali — office administrator', payroll_category: 'Office employee',
  pay_basis: 'Monthly salary', pay_frequency: 'Monthly', basic_salary: 100000, daily_rate: 4000,
  epf_eligible: true, etf_eligible: true
});
const labourer = person({
  name: 'Saman — site labourer', payroll_category: 'Site labourer',
  pay_basis: 'Daily rate', pay_frequency: 'Weekly', daily_rate: 3500
});
const driver = person({
  name: 'Ruwan — driver', payroll_category: 'Driver',
  pay_basis: 'Weekly rate', pay_frequency: 'Weekly', weekly_rate: 30000, daily_rate: 5000,
  epf_eligible: true
});
const supervisor = person({
  name: 'Malinda — site supervisor', payroll_category: 'Supervisor',
  pay_basis: 'Monthly salary', pay_frequency: 'Monthly', basic_salary: 120000, daily_rate: 6000,
  epf_eligible: true, etf_eligible: true
});
const specialist = person({
  name: 'Ayesha — custom daily specialist', payroll_category: 'Custom',
  pay_basis: 'Daily rate', pay_frequency: 'Daily', daily_rate: 8000,
  custom_office_ot_rate: 300, custom_site_ot_rate: 350, custom_travel_ot_rate: 150
});

function overtimePay(employee, policy, entries) {
  return entries.reduce((total, [type, hours]) => total + resolveOvertimeRate(employee, type, policy) * hours, 0);
}

const scenarios = [
  { employee: office, name: 'ordinary month', input: {}, expected: { basic: 100000, grossEarnings: 100000, epfEmployeeDeduction: 8000, deductions: 8000, netPay: 92000, employerCost: 115000 } },
  { employee: office, name: 'office overtime', input: { overtime: [['Office', 10]] }, expected: { overtimePay: 2250, grossEarnings: 102250, netPay: 94250, employerCost: 117250 } },
  { employee: office, name: 'two unpaid-leave days', input: { unpaid_days: 2 }, expected: { unpaidLeaveDeduction: 8000, epfEmployeeDeduction: 7360, deductions: 15360, netPay: 84640, employerCost: 105800 } },
  { employee: office, name: 'allowance, reimbursement and deduction', input: { components: [component('Allowance', 5000), component('Reimbursement', 2000), component('Deduction', 1000)] }, expected: { allowanceTotal: 5000, reimbursementTotal: 2000, otherDeduction: 1000, grossEarnings: 105000, deductions: 9000, netPay: 98000, employerCost: 122000 } },
  { employee: office, name: 'advance larger than net salary', input: { salary_advance: 150000 }, expected: { salaryAdvanceDeduction: 92000, deductions: 100000, netPay: 0, employerCost: 115000 } },

  { employee: labourer, name: 'five worked days', input: { days_present: 5 }, expected: { basic: 17500, grossEarnings: 17500, deductions: 0, netPay: 17500, employerCost: 17500 } },
  { employee: labourer, name: 'site and travel overtime', input: { days_present: 5, overtime: [['Site', 4], ['Travel', 2]] }, expected: { overtimePay: 1000, grossEarnings: 18500, netPay: 18500, employerCost: 18500 } },
  { employee: labourer, name: 'three days plus allowance', input: { days_present: 3, components: [component('Allowance', 1500)] }, expected: { basic: 10500, allowanceTotal: 1500, grossEarnings: 12000, netPay: 12000, employerCost: 12000 } },
  { employee: labourer, name: 'reimbursement and deduction', input: { days_present: 5, components: [component('Reimbursement', 2000), component('Deduction', 500)] }, expected: { reimbursementTotal: 2000, otherDeduction: 500, deductions: 500, netPay: 19000, employerCost: 19500 } },
  { employee: labourer, name: 'advance capped at two days earnings', input: { days_present: 2, salary_advance: 20000 }, expected: { basic: 7000, salaryAdvanceDeduction: 7000, deductions: 7000, netPay: 0, employerCost: 7000 } },

  { employee: driver, name: 'ordinary week', input: {}, expected: { basic: 30000, epfEmployeeDeduction: 2400, netPay: 27600, employerCost: 33600 } },
  { employee: driver, name: 'office overtime', input: { overtime: [['Office', 4]] }, expected: { overtimePay: 900, grossEarnings: 30900, netPay: 28500, employerCost: 34500 } },
  { employee: driver, name: 'site and travel overtime at driver rate', input: { overtime: [['Site', 2], ['Travel', 3]] }, expected: { overtimePay: 1125, grossEarnings: 31125, netPay: 28725, employerCost: 34725 } },
  { employee: driver, name: 'one unpaid-leave day', input: { unpaid_days: 1 }, expected: { unpaidLeaveDeduction: 5000, epfEmployeeDeduction: 2000, deductions: 7000, netPay: 23000, employerCost: 28000 } },
  { employee: driver, name: 'allowance, deduction and advance', input: { salary_advance: 10000, components: [component('Allowance', 3000), component('Deduction', 1000)] }, expected: { allowanceTotal: 3000, otherDeduction: 1000, salaryAdvanceDeduction: 10000, deductions: 13400, netPay: 19600, employerCost: 36600 } },

  { employee: supervisor, policy: grossPolicy, name: 'ordinary month under legacy gross policy still uses basic', input: {}, expected: { basic: 120000, epfEmployeeDeduction: 9600, epfEmployerContribution: 14400, etfEmployerContribution: 3600, netPay: 110400, employerCost: 138000 } },
  { employee: supervisor, policy: grossPolicy, name: 'site and travel overtime', input: { overtime: [['Site', 5], ['Travel', 3]] }, expected: { overtimePay: 1425, grossEarnings: 121425, epfEmployeeDeduction: 9600, netPay: 111825, employerCost: 139425 } },
  { employee: supervisor, policy: grossPolicy, name: 'two unpaid-leave days', input: { unpaid_days: 2 }, expected: { unpaidLeaveDeduction: 12000, epfEmployeeDeduction: 8640, deductions: 20640, netPay: 99360, employerCost: 124200 } },
  { employee: supervisor, policy: grossPolicy, name: 'full component mix', input: { components: [component('Allowance', 10000), component('Reimbursement', 5000), component('Deduction', 2000)] }, expected: { grossEarnings: 130000, reimbursementTotal: 5000, epfEmployeeDeduction: 9600, deductions: 11600, netPay: 123400, employerCost: 153000 } },
  { employee: supervisor, policy: grossPolicy, name: 'overtime and salary advance', input: { overtime: [['Site', 10]], salary_advance: 50000 }, expected: { overtimePay: 2250, grossEarnings: 122250, epfEmployeeDeduction: 9600, salaryAdvanceDeduction: 50000, deductions: 59600, netPay: 62650, employerCost: 140250 } },

  { employee: specialist, name: 'one normal day', input: { days_present: 1 }, expected: { basic: 8000, grossEarnings: 8000, netPay: 8000, employerCost: 8000 } },
  { employee: specialist, name: 'custom site and travel overtime', input: { days_present: 1, overtime: [['Site', 2], ['Travel', 1]] }, expected: { overtimePay: 850, grossEarnings: 8850, netPay: 8850, employerCost: 8850 } },
  { employee: specialist, name: 'no attendance means no daily earnings', input: {}, expected: { basic: 0, grossEarnings: 0, deductions: 0, netPay: 0, employerCost: 0 } },
  { employee: specialist, name: 'daily components', input: { days_present: 1, components: [component('Allowance', 1000), component('Reimbursement', 500), component('Deduction', 750)] }, expected: { allowanceTotal: 1000, reimbursementTotal: 500, otherDeduction: 750, grossEarnings: 9000, deductions: 750, netPay: 8750, employerCost: 9500 } },
  { employee: specialist, name: 'daily advance capped at earnings', input: { days_present: 1, salary_advance: 15000 }, expected: { salaryAdvanceDeduction: 8000, deductions: 8000, netPay: 0, employerCost: 8000 } }
];

test('25 payroll scenarios across five employee pay arrangements', async t => {
  assert.equal(scenarios.length, 25);
  for (const scenario of scenarios) await t.test(`${scenario.employee.name}: ${scenario.name}`, () => {
    const policy = scenario.policy || basicPolicy;
    const { components = [], overtime = [], ...overrides } = scenario.input;
    const employee = { ...scenario.employee, ...overrides };
    employee.overtime_pay = overtimePay(employee, policy, overtime);
    const actual = calculatePayslip(employee, policy, components);
    for (const [field, expected] of Object.entries(scenario.expected))
      assert.equal(actual[field], expected, `${field} should reconcile`);
    assert.equal(actual.netPay, Math.max(0,
      actual.grossEarnings + actual.reimbursementTotal - actual.deductions), 'salary sheet balances');
  });
});

test('pay-type and overtime guardrails reject invalid combinations', () => {
  assert.match(payProfileError({ payBasis: 'Monthly salary', payFrequency: 'Weekly' }), /monthly/i);
  assert.match(payProfileError({ payBasis: 'Weekly rate', payFrequency: 'Monthly' }), /weekly/i);
  assert.throws(() => resolveOvertimeRate(office, 'Site', basicPolicy), /cannot record site overtime/);
  assert.throws(() => resolveOvertimeRate(labourer, 'Office', basicPolicy), /cannot record office overtime/);
});

test('EPF and ETF eligibility are independent and never use gross additions', () => {
  const earnings = { ...office, overtime_pay: 2250 };
  const additions = [component('Allowance', 5000), component('Reimbursement', 1000)];
  const epfOnly = calculatePayslip({ ...earnings, epf_eligible: true, etf_eligible: false }, grossPolicy, additions);
  assert.equal(epfOnly.epfEmployeeDeduction, 8000);
  assert.equal(epfOnly.epfEmployerContribution, 12000);
  assert.equal(epfOnly.etfEmployerContribution, 0);
  const etfOnly = calculatePayslip({ ...earnings, epf_eligible: false, etf_eligible: true }, grossPolicy, additions);
  assert.equal(etfOnly.epfEmployeeDeduction, 0);
  assert.equal(etfOnly.epfEmployerContribution, 0);
  assert.equal(etfOnly.etfEmployerContribution, 3000);
  const neither = calculatePayslip({ ...earnings, epf_eligible: false, etf_eligible: false }, grossPolicy, additions);
  assert.equal(neither.epfEmployeeDeduction, 0);
  assert.equal(neither.epfEmployerContribution, 0);
  assert.equal(neither.etfEmployerContribution, 0);
});
