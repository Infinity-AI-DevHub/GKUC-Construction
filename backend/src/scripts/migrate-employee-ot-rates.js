import {pool, query, transaction} from '../db.js';
import {legacyOtEmployeesSql, migrateEmployeeOtRates} from '../lib/employee-ot-migration.js';
import {resolveOvertimeRate} from '../lib/payroll-policy.js';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported. Omit it for a read-only preview.');
  const employees = await query(`${legacyOtEmployeesSql} ORDER BY id`);
  console.log(JSON.stringify({database:process.env.DB_NAME || 'gkuc_siteops',mode:args.includes('--apply')?'Apply':'Read-only',
    legacyEmployeeRates:employees}, null, 2));
  if (args.includes('--apply')) console.log(JSON.stringify(await migrateEmployeeOtRates({query,transaction})));

  const records = await query(`SELECT o.*,e.code,e.payroll_category FROM overtime_records o
    JOIN employees e ON e.id=o.employee_id WHERE o.status<>'Rejected' ORDER BY o.id`);
  const policies = await query('SELECT * FROM payroll_policies');
  const byId = new Map(policies.map(policy => [Number(policy.id),policy]));
  const review = [];
  for (const record of records) {
    const policy = byId.get(Number(record.policy_id));
    if (!policy) {
      review.push({id:record.id,employeeCode:record.code,reason:'No linked policy; historical rate preserved'});
      continue;
    }
    try {
      const expected = resolveOvertimeRate(record,record.overtime_type,policy);
      if (Math.abs(Number(record.rate)-expected)>0.005) review.push({id:record.id,
        employeeCode:record.code,status:record.status,storedRate:Number(record.rate),policyRate:expected,
        reason:'Review required; current employee category may differ from its historical category'});
    } catch (error) {
      review.push({id:record.id,employeeCode:record.code,reason:error.message});
    }
  }
  console.log(JSON.stringify({existingOtForReview:review,
    preserved:'Attendance, employee salary fields, recorded OT, claims, payslips and financial allocations are unchanged.'},null,2));
} catch (error) {
  console.error('Employee OT migration failed:',error.message);
  process.exitCode=1;
} finally {
  await pool.end();
}
