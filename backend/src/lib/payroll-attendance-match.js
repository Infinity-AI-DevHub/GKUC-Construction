// Legacy attendance has no employee ID. Match only an unambiguous normalised name;
// an explicit employee ID always takes priority over the name.
export const payrollNameKey=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en');
export function attendanceForEmployee(employee,attendance,allEmployees) {
  const name=payrollNameKey(employee.name);
  const unique=name && allEmployees.filter(row=>payrollNameKey(row.name)===name).length===1;
  return attendance.filter(row=>row.employee_id!=null
    ? Number(row.employee_id)===Number(employee.id)
    : unique && payrollNameKey(row.employee_name)===name);
}
export function salaryCalculationIssues(employee,calculation) {
  const issues=[];
  const days=Number(employee.days_present||0)+Number(employee.paid_leave_days||0);
  if(days===0)issues.push('No worked attendance days or approved paid-leave days were found for this payroll period.');
  if(Number(employee.daily_rate||0)<=0)issues.push('Daily salary rate is not configured. The EPF/ETF salary basis is separate and is not used as salary.');
  if(days>0 && Number(calculation.basic)===0 && Number(employee.daily_rate)>0)issues.push('Short-day reductions cover all basic earnings. Review the normal shift and attendance times.');
  if(Number(calculation.basic)>0 && Number(calculation.netPay)===0)issues.push('Deductions or advance recovery reduce take-home pay to zero. Review the saved deduction breakdown.');
  return issues;
}
