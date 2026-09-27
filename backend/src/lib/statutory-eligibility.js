export const DEFAULT_STATUTORY_RULES = Object.freeze({
  permanentOnly: true,
  minimumMonthlySalary: 30000,
  weeklyWeeksPerMonth: 52 / 12,
  dailyDaysPerMonth: 25
});

export function statutoryRules(policy) {
  const stored = typeof policy?.statutory_rules === 'string'
    ? JSON.parse(policy.statutory_rules) : policy?.statutory_rules;
  return { ...DEFAULT_STATUTORY_RULES, ...(stored || {}) };
}

export function monthlyEquivalent(employee, rules = DEFAULT_STATUTORY_RULES) {
  if (employee.pay_basis === 'Weekly rate') return Number(employee.weekly_rate || 0) * Number(rules.weeklyWeeksPerMonth);
  if (employee.pay_basis === 'Daily rate') return Number(employee.daily_rate || 0) * Number(rules.dailyDaysPerMonth);
  return Number(employee.basic_salary || 0);
}

export function contributionEligibility(employee, policy, periodEnd) {
  const rules = statutoryRules(policy);
  const date = employee.contribution_start_date || employee.join_date;
  const starts = date instanceof Date ? date.toISOString().slice(0, 10) : String(date || '').slice(0, 10);
  const typeEligible = !rules.permanentOnly || employee.employment_type === 'Permanent';
  const salaryEligible = monthlyEquivalent(employee, rules) >= Number(rules.minimumMonthlySalary);
  const dateEligible = Boolean(starts) && starts <= periodEnd;
  const qualifies = typeEligible && salaryEligible && dateEligible;
  return {
    epf: Boolean(employee.epf_eligible) && qualifies,
    etf: Boolean(employee.etf_eligible) && qualifies,
    monthlyEquivalent: monthlyEquivalent(employee, rules),
    typeEligible, salaryEligible, dateEligible, starts
  };
}
