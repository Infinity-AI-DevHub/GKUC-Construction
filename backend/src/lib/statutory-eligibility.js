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
  // GKUC explicitly records this amount for statutory contribution decisions.
  // Daily and weekly earning rates must not silently replace it.
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

/** Explain the exact rules applied without changing payroll amounts or eligibility. */
export function contributionExplanation(employee, policy, periodEnd, payFrequency) {
  const eligibility = contributionEligibility(employee, policy, periodEnd);
  const rules = statutoryRules(policy);
  const common = [];
  if (payFrequency !== 'Monthly') common.push(`This is a ${payFrequency} run; contributions apply only to Monthly runs.`);
  if (!eligibility.typeEligible) common.push(`Employment classification is ${employee.employment_type}; the selected policy allows Permanent employees only.`);
  if (!eligibility.salaryEligible) common.push(`Configured salary basis ${eligibility.monthlyEquivalent} is below the policy minimum ${rules.minimumMonthlySalary}.`);
  if (!eligibility.dateEligible) common.push(eligibility.starts ? `Contributions start on ${eligibility.starts}, after this payroll period.` : 'No contribution start date or joining date is recorded.');
  const reasons = (enabled,rate,label) => [...common,
    ...(!enabled ? [`${label} eligibility is disabled in the employee profile.`] : []),
    ...(Number(rate || 0) <= 0 ? [`${label} rate is zero in the selected payroll policy.`] : []),
    ...(eligibility.monthlyEquivalent <= 0 ? ['The configured contribution salary basis is zero.'] : [])];
  return {policyId:policy.id || null,periodEnd,payFrequency,basis:eligibility.monthlyEquivalent,
    employeeEpfRate:Number(policy.epf_employee_rate || 0),employerEpfRate:Number(policy.epf_employer_rate || 0),etfRate:Number(policy.etf_employer_rate || 0),
    epfReasons:reasons(employee.epf_eligible,policy.epf_employee_rate,'EPF'),
    etfReasons:reasons(employee.etf_eligible,policy.etf_employer_rate,'ETF')};
}
