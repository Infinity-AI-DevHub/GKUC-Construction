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
  const basic = employee.pay_basis === 'Monthly salary' ? Number(employee.basic_salary)
    : employee.pay_basis === 'Weekly rate' ? Number(employee.weekly_rate)
      : dailyRate * Number(employee.days_present);
  const overtimePay = Number(employee.overtime_pay);
  const componentTotal = kind => money(components.filter(row => row.kind === kind)
    .reduce((sum, row) => sum + Number(row.amount), 0));
  const allowanceTotal = componentTotal('Allowance');
  const reimbursementTotal = componentTotal('Reimbursement');
  const otherDeduction = componentTotal('Deduction');
  const unpaidLeaveDeduction = employee.pay_basis === 'Daily rate'
    ? 0
    : money(Number(employee.unpaid_days) * dailyRate);
  const grossEarnings = money(basic + overtimePay + allowanceTotal);
  const adjustedBasic = Math.max(0, money(basic - unpaidLeaveDeduction));
  const adjustedGross = Math.max(0, money(grossEarnings - unpaidLeaveDeduction));
  // GKUC contributions are based only on earned basic pay (after unpaid leave).
  // A legacy gross-basis policy must never bring overtime or allowances into EPF/ETF.
  const epfEmployeeDeduction = employee.epf_eligible
    ? money(adjustedBasic * Number(policy.epf_employee_rate) / 100)
    : 0;
  const epfEmployerContribution = employee.epf_eligible
    ? money(adjustedBasic * Number(policy.epf_employer_rate) / 100)
    : 0;
  const etfEmployerContribution = employee.etf_eligible
    ? money(adjustedBasic * Number(policy.etf_employer_rate) / 100)
    : 0;
  const beforeAdvance = Math.max(0,
    grossEarnings + reimbursementTotal - unpaidLeaveDeduction - otherDeduction - epfEmployeeDeduction);
  const salaryAdvanceDeduction = money(Math.min(beforeAdvance, Number(employee.salary_advance)));
  const deductions = money(unpaidLeaveDeduction + otherDeduction + epfEmployeeDeduction + salaryAdvanceDeduction);
  const netPay = money(Math.max(0, grossEarnings + reimbursementTotal - deductions));
  const employerCost = money(adjustedGross + reimbursementTotal + epfEmployerContribution + etfEmployerContribution);

  return {
    basic: money(basic), overtimePay: money(overtimePay), allowanceTotal, reimbursementTotal,
    grossEarnings, epfEmployeeDeduction, epfEmployerContribution, etfEmployerContribution,
    otherDeduction, unpaidLeaveDeduction, salaryAdvanceDeduction, deductions, netPay, employerCost
  };
}
