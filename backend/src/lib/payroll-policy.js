import {specialRates} from './special-pay.js';
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
  if (category === 'Driver') return ['Site', 'Travel'];
  return OVERTIME_TYPES;
}

export function resolveOvertimeRate(employee, type, policy) {
  if(employee.special_pay_rule?.mode==='Machine operator'){
    if(type==='Site'&&employee.special_pay_day?.work_kind==='Standby')return Number(policy.site_labour_site_ot_rate);
    throw new Error('Operator Site OT is allowed only on an HR-recorded Standby day; machine days and Travel/Office OT are not eligible.');
  }
  if(employee.special_pay_rule?.mode==='Work role'){
    if(!['Site','Travel'].includes(type))throw new Error('Work-role daily pay permits only Site or Travel OT.');
    const rates=specialRates(employee.special_pay_rule);return type==='Site'?rates.siteOt:rates.travelOt;
  }
  if (!allowedOvertimeTypes(employee.payroll_category).includes(type))
    throw new Error(`${employee.payroll_category} cannot record ${type.toLowerCase()} overtime`);

  if (employee.payroll_category === 'Custom') {
    const rules = typeof policy.hr_rules === 'string' ? JSON.parse(policy.hr_rules) : (policy.hr_rules || {});
    const rates = {
      Office: rules.customOfficeOtRate ?? policy.office_ot_rate,
      Site: rules.customSiteOtRate ?? policy.site_labour_site_ot_rate,
      Travel: rules.customTravelOtRate ?? policy.site_labour_travel_ot_rate
    };
    return Number(rates[type]);
  }

  if (employee.payroll_category === 'Office employee') return Number(policy.office_ot_rate);
  if (employee.payroll_category === 'Driver') {
    const rate = type === 'Site' ? policy.driver_site_ot_rate
      : type === 'Travel' ? policy.driver_travel_ot_rate : policy.driver_ot_rate;
    return Number(rate ?? policy.driver_ot_rate);
  }
  if (employee.payroll_category === 'Supervisor')
    return Number(type === 'Travel' ? policy.supervisor_travel_ot_rate : policy.supervisor_site_ot_rate);
  if (employee.payroll_category === 'Site labourer')
    return Number(type === 'Travel' ? policy.site_labour_travel_ot_rate : policy.site_labour_site_ot_rate);
  throw new Error('Select a valid payroll category before recording overtime');
}

export function overtimeMinimumMinutes(employee, type, policy) {
  if(employee.special_pay_rule?.mode==='Machine operator'&&type==='Site'&&employee.special_pay_day?.work_kind==='Standby')return 30;
  if(employee.special_pay_rule?.mode==='Work role')return type==='Travel'?Number((typeof policy?.hr_rules==='string'?JSON.parse(policy.hr_rules):policy?.hr_rules||{}).labourTravelOtMinimumMinutes??45):30;
  const rules = typeof policy?.hr_rules === 'string' ? JSON.parse(policy.hr_rules) : (policy?.hr_rules || {});
  const category = employee.payroll_category;
  if (category === 'Office employee') return Number(rules.officeOtMinimumMinutes ?? 30);
  if (category === 'Site labourer') return Number(type === 'Travel' ? rules.labourTravelOtMinimumMinutes ?? 45 : rules.labourSiteOtMinimumMinutes ?? 30);
  if (category === 'Supervisor') return Number(type === 'Travel' ? rules.supervisorTravelOtMinimumMinutes ?? 45 : rules.supervisorSiteOtMinimumMinutes ?? 30);
  if (category === 'Driver') return Number(type === 'Travel' ? rules.driverTravelOtMinimumMinutes ?? 30 : rules.driverSiteOtMinimumMinutes ?? 31);
  return Number(type === 'Office' ? rules.officeOtMinimumMinutes ?? 30 : rules.labourSiteOtMinimumMinutes ?? 30);
}

// Late arrivals use the rate for the employee's normal attended work, never a
// travel rate. This keeps late deductions independent from travel claims.
export function resolveLateRate(employee, policy) {
  const type = employee.payroll_category === 'Office employee' ? 'Office' : 'Site';
  return resolveOvertimeRate(employee, type, policy);
}

/**
 * The single payroll arithmetic engine used by both the API and the scenario suite.
 * Inputs deliberately mirror the database row names so no second set of payroll rules
 * can drift away from production behaviour.
 */
export function calculatePayslip(employee, policy, components = [], payFrequency = employee.pay_frequency) {
  const dailyRate = Number(employee.daily_rate);
  const daysPresent = Number(employee.days_present || 0);
  const paidLeaveDays = Number(employee.paid_leave_days || 0);
  const unpaidLeaveDays = Number(employee.unpaid_leave_days || 0);
  const payableDays = daysPresent + paidLeaveDays;
  // The monthly statutory basis is not earnings. Approved paid leave is earnings;
  // unpaid leave is excluded once, never subtracted again as a second deduction.
  const shortDayReduction = money(Math.max(0, Number(employee.short_day_reduction || 0)));
  const attendanceBasic = Number.isFinite(Number(employee.attendance_basic))
    ? Number(employee.attendance_basic) : dailyRate * daysPresent - shortDayReduction;
  const paidLeavePay = money(employee.special_paid_leave_pay ?? dailyRate * paidLeaveDays);
  const basic = money(Math.max(0, attendanceBasic + paidLeavePay));
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
  const statutoryMonthlyBasic = Math.max(0, Number(employee.basic_salary || 0));
  // Contributions apply only to Monthly runs, using the full configured basis.
  // Attendance, leave and the length of the period never prorate that basis.
  const monthlyContributions = payFrequency === 'Monthly';
  const contributionBase = monthlyContributions ? money(statutoryMonthlyBasic) : 0;
  // A legacy gross-basis setting must never bring salary earnings, overtime,
  // allowances or reimbursements into the EPF/ETF basis.
  const epfEmployeeDeduction = monthlyContributions && employee.epf_eligible
    ? money(contributionBase * Number(policy.epf_employee_rate) / 100)
    : 0;
  const epfEmployerContribution = monthlyContributions && employee.epf_eligible
    ? money(contributionBase * Number(policy.epf_employer_rate) / 100)
    : 0;
  const etfEmployerContribution = monthlyContributions && employee.etf_eligible
    ? money(contributionBase * Number(policy.etf_employer_rate) / 100)
    : 0;
  const beforeAdvance = Math.max(0,
    grossEarnings + reimbursementTotal - unpaidLeaveDeduction - lateDeduction - otherDeduction - epfEmployeeDeduction);
  const salaryAdvanceDeduction = money(Math.min(beforeAdvance, Number(employee.salary_advance)));
  const deductions = money(unpaidLeaveDeduction + lateDeduction + otherDeduction + epfEmployeeDeduction + salaryAdvanceDeduction);
  const netPay = money(Math.max(0, grossEarnings + reimbursementTotal - deductions));
  const employerCost = money(grossEarnings + reimbursementTotal + epfEmployerContribution + etfEmployerContribution);

  return {
    basic: money(basic), shortDayReduction, paidLeaveDays, unpaidLeaveDays, payableDays, paidLeavePay, contributionBase, overtimePay: money(overtimePay), allowanceTotal, reimbursementTotal,
    grossEarnings, epfEmployeeDeduction, epfEmployerContribution, etfEmployerContribution,
    otherDeduction, lateDeduction, unpaidLeaveDeduction, salaryAdvanceDeduction, deductions, netPay, employerCost
  };
}
