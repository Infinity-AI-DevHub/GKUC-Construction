import {query,pool,today} from '../db.js';
import {contributionExplanation} from '../lib/statutory-eligibility.js';

// Read-only: no payroll generation, migrations or updates.
try {
  const name=process.argv.slice(2).join(' ').trim();
  if (!name) throw new Error('Supply the employee name or code: npm run payroll:diagnose -- Maduwanthi');
  const employees=await query(`SELECT id,code,name,basic_salary,epf_eligible,etf_eligible,employment_type,
    contribution_start_date,join_date,pay_frequency,payroll_company_id FROM visible_employees
    WHERE LOCATE(?,name)>0 OR code=? ORDER BY code LIMIT 20`,[name,name]);
  if (!employees.length) throw new Error('No matching employee. Try a shorter part of the name or the employee code.');
  for (const employee of employees) {
    const policies=await query('SELECT * FROM payroll_policies WHERE archive_key=0 AND company_id=? ORDER BY effective_from DESC,id DESC',[employee.payroll_company_id]);
    const current=policies.find(p=>String(p.effective_from).slice(0,10)<=today());
    console.log(JSON.stringify({employee:employee.name,code:employee.code,companyId:employee.payroll_company_id,
      classification:employee.employment_type,frequency:employee.pay_frequency,basis:Number(employee.basic_salary),epfEnabled:Boolean(employee.epf_eligible),
      contributionStart:employee.contribution_start_date||employee.join_date,
      currentProfileCheck:current ? contributionExplanation(employee,current,today(),employee.pay_frequency) : 'No effective payroll policy'},null,2));
    const slips=await query(`SELECT r.reference,r.period_start periodStart,r.period_end periodEnd,r.pay_frequency frequency,r.status,
      r.policy_id policyId,p.epf_employee_rate savedPolicyEmployeeEpfRate,s.contribution_base basis,s.epf_employee_deduction employeeEpf,s.epf_employer_contribution employerEpf,
      s.etf_employer_contribution employerEtf,s.calculation_detail calculationDetail
      FROM payslips s JOIN payroll_runs r ON r.id=s.run_id LEFT JOIN payroll_policies p ON p.id=r.policy_id WHERE s.employee_id=? ORDER BY r.id DESC LIMIT 6`,[employee.id]);
    for (const slip of slips) {
      const detail=typeof slip.calculationDetail==='string'?JSON.parse(slip.calculationDetail):slip.calculationDetail;
      const {calculationDetail,...saved}=slip;
      console.log(JSON.stringify({...saved,savedContributionExplanation:detail?.contributions || 'Not captured by this older run; current profile settings do not prove settings at creation.'},null,2));
    }
  }
} catch(error) {
  console.error('Payroll diagnostic failed:',error.code || error.message);
  process.exitCode=1;
} finally {await pool.end();}
