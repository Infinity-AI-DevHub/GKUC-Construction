export const PAY_BASES = ['Monthly salary', 'Weekly rate', 'Daily rate'];
export const PAY_FREQUENCIES = ['Daily', 'Weekly', 'Monthly'];
export const PAYROLL_CATEGORIES = ['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom'];
export const OVERTIME_TYPES = ['Office', 'Site', 'Travel'];

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function payProfileError(profile) {
  if (profile.payBasis === 'Monthly salary' && profile.payFrequency !== 'Monthly')
    return 'Monthly salary employees must use the monthly pay frequency';
  if (profile.payBasis === 'Weekly rate' && profile.payFrequency !== 'Weekly')
    return 'Weekly-rate employees must use the weekly pay frequency';
  return '';
}

export function allowedOvertimeTypes(category) {
  if (category === 'Office employee') return ['Office'];
  if (category === 'Site labourer' || category === 'Supervisor') return ['Site', 'Travel'];
  if (category === 'Driver') return ['Office', 'Site', 'Travel'];
  return OVERTIME_TYPES;
}

export function resolveOvertimeRate(employee, type, policy) {
  if (!allowedOvertimeTypes(employee.payroll_category).includes(type))
    throw new Error(`${employee.payroll_category} cannot record ${type.toLowerCase()} overtime`);

  const custom = {
    Office: employee.custom_office_ot_rate,
    Site: employee.custom_site_ot_rate,
    Travel: employee.custom_travel_ot_rate
  }[type];
  if (employee.payroll_category === 'Custom' && custom !== null && custom !== undefined) return Number(custom);

  if (employee.payroll_category === 'Office employee') return Number(policy.office_ot_rate);
  if (employee.payroll_category === 'Driver') return Number(policy.driver_ot_rate);
  if (employee.payroll_category === 'Supervisor')
    return Number(type === 'Travel' ? policy.supervisor_travel_ot_rate : policy.supervisor_site_ot_rate);
  if (employee.payroll_category === 'Site labourer')
    return Number(type === 'Travel' ? policy.site_labour_travel_ot_rate : policy.site_labour_site_ot_rate);
  return Number(custom ?? employee.overtime_rate ?? 0);
}

/**
 * The single payroll arithmetic engine used by both the API and the scenario suite.
 * Inputs deliberately mirror the database row names so no second set of payroll rules
 * can drift away from production behaviour.
 */
export function calculatePayslip(employee, policy, components = []) {
  const dailyRate = Number(employee.daily_rate);
  const daysPresent = Number(employee.days_present || 0);
  // GKUC pays salary for days actually worked. The employee profile's monthly
  // `basic_salary` is a statutory reference amount only; it must never be added
  // to earnings. Keep `basic` as the persisted payslip column for compatibility,
  // but its meaning is now unambiguously earned salary.
  const basic = money(dailyRate * daysPresent);
  const overtimePay = Number(employee.overtime_pay);
  const componentTotal = kind => money(components.filter(row => row.kind === kind)
    .reduce((sum, row) => sum + Number(row.amount), 0));
  const allowanceTotal = componentTotal('Allowance');
  const reimbursementTotal = componentTotal('Reimbursement');
  const otherDeduction = componentTotal('Deduction');
  const lateDeduction = money(employee.late_deduction || 0);
  // An unpaid/absent day is already excluded from days_present, so subtracting it
  // again would charge the employee twice.
  const unpaidLeaveDeduction = 0;
  const grossEarnings = money(basic + overtimePay + allowanceTotal);
  const storedRules = typeof policy?.statutory_rules === 'string'
    ? JSON.parse(policy.statutory_rules) : (policy?.statutory_rules || policy?.statutoryRules || {});
  const standardDays = Math.max(1, Number(storedRules.dailyDaysPerMonth ?? 25));
  const statutoryMonthlyBasic = Math.max(0, Number(employee.basic_salary || 0));
  // The configured statutory amount is monthly, so a shorter payroll period uses
  // only the attended-day share. Never exceed the configured monthly basis.
  const contributionBase = money(Math.min(statutoryMonthlyBasic,
    statutoryMonthlyBasic / standardDays * daysPresent));
  // A legacy gross-basis setting must never bring salary earnings, overtime,
  // allowances or reimbursements into the EPF/ETF basis.
  const epfEmployeeDeduction = employee.epf_eligible
    ? money(contributionBase * Number(policy.epf_employee_rate) / 100)
    : 0;
  const epfEmployerContribution = employee.epf_eligible
    ? money(contributionBase * Number(policy.epf_employer_rate) / 100)
    : 0;
  const etfEmployerContribution = employee.etf_eligible
    ? money(contributionBase * Number(policy.etf_employer_rate) / 100)
    : 0;
  const beforeAdvance = Math.max(0,
    grossEarnings + reimbursementTotal - unpaidLeaveDeduction - otherDeduction - epfEmployeeDeduction);
  const salaryAdvanceDeduction = money(Math.min(beforeAdvance, Number(employee.salary_advance)));
  const deductions = money(unpaidLeaveDeduction + lateDeduction + otherDeduction + epfEmployeeDeduction + salaryAdvanceDeduction);
  const netPay = money(Math.max(0, grossEarnings + reimbursementTotal - deductions));
  const employerCost = money(grossEarnings + reimbursementTotal + epfEmployerContribution + etfEmployerContribution);

  return {
    basic: money(basic), contributionBase, overtimePay: money(overtimePay), allowanceTotal, reimbursementTotal,
    grossEarnings, epfEmployeeDeduction, epfEmployerContribution, etfEmployerContribution,
    otherDeduction, lateDeduction, unpaidLeaveDeduction, salaryAdvanceDeduction, deductions, netPay, employerCost
  };
}
