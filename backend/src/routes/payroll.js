import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { PAY_BASES, PAY_FREQUENCIES, PAYROLL_CATEGORIES, calculatePayslip, payProfileError } from '../lib/payroll-policy.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const percent = z.number().min(0).max(100);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const policySchema = z.object({
  companyId: z.number().int().positive().default(1),
  effectiveFrom: isoDate,
  officeOtRate: z.number().positive(),
  siteLabourSiteOtRate: z.number().positive(),
  siteLabourTravelOtRate: z.number().positive(),
  driverOtRate: z.number().positive(),
  supervisorSiteOtRate: z.number().positive(),
  supervisorTravelOtRate: z.number().positive(),
  epfEmployeeRate: percent,
  epfEmployerRate: percent,
  etfEmployerRate: percent,
  epfBasis: z.literal('Basic earnings').default('Basic earnings'),
  etfBasis: z.literal('Basic earnings').default('Basic earnings')
});

const policySelect = `SELECT p.id,p.company_id companyId,c.name company,p.effective_from effectiveFrom,p.office_ot_rate officeOtRate,
  p.site_labour_site_ot_rate siteLabourSiteOtRate,p.site_labour_travel_ot_rate siteLabourTravelOtRate,
  p.driver_ot_rate driverOtRate,p.supervisor_site_ot_rate supervisorSiteOtRate,
  p.supervisor_travel_ot_rate supervisorTravelOtRate,p.epf_employee_rate epfEmployeeRate,
  p.epf_employer_rate epfEmployerRate,p.etf_employer_rate etfEmployerRate,
  p.epf_basis epfBasis,p.etf_basis etfBasis,u.name createdBy,p.created_at createdAt
  FROM payroll_policies p JOIN companies c ON c.id=p.company_id LEFT JOIN users u ON u.id=p.created_by`;

/**
 * PID 2.2 "Salary Information". Pay is calculated from what the system already knows —
 * recorded attendance and approved overtime — rather than re-entered by hand, which is
 * where payroll disputes normally start.
 */
const select = `SELECT r.id,r.company_id companyId,c.name company,r.reference,r.period_start periodStart,r.period_end periodEnd,r.pay_frequency payFrequency,r.status,
  COALESCE((SELECT SUM(net_pay) FROM payslips total_slips WHERE total_slips.run_id=r.id),r.total) total,
  COALESCE((SELECT SUM(employer_cost) FROM payslips total_slips WHERE total_slips.run_id=r.id),0) employerCost,
  u.name createdBy,a.name approvedBy,r.created_at createdAt,
  (SELECT COUNT(*) FROM payslips s WHERE s.run_id=r.id) employees
  FROM payroll_runs r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by`;

router.get('/', auth, permit('hr.payroll'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId || 0);
  res.json(await query(`${select} ${companyId ? 'WHERE r.company_id=?' : ''} ORDER BY r.id DESC`, companyId ? [companyId] : []));
}));

router.get('/settings', auth, permit('hr.payroll', 'hr.manage'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId || 1);
  const [policies, components] = await Promise.all([
    query(`${policySelect} WHERE p.company_id=? ORDER BY p.effective_from DESC,p.id DESC`, [companyId]),
    query(`SELECT c.id,c.employee_id employeeId,e.code employeeCode,e.name employee,c.name,c.kind,c.amount,
      c.pay_frequency payFrequency,c.effective_from effectiveFrom,c.effective_to effectiveTo,c.active,
      u.name createdBy,c.created_at createdAt
      FROM employee_pay_components c JOIN employees e ON e.id=c.employee_id JOIN users u ON u.id=c.created_by
      WHERE e.payroll_company_id=? ORDER BY c.active DESC,e.code,c.kind,c.name`, [companyId])
  ]);
  res.json({ activePolicy: policies.find(row => String(row.effectiveFrom).slice(0, 10) <= new Date().toISOString().slice(0, 10)) || null,
    policies, components });
}));

router.post('/settings/policies', auth, permit('hr.payroll'), validate(policySchema), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query(`INSERT INTO payroll_policies
      (company_id,effective_from,office_ot_rate,site_labour_site_ot_rate,site_labour_travel_ot_rate,driver_ot_rate,
       supervisor_site_ot_rate,supervisor_travel_ot_rate,epf_employee_rate,epf_employer_rate,etf_employer_rate,
       epf_basis,etf_basis,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.companyId, body.effectiveFrom, body.officeOtRate, body.siteLabourSiteOtRate, body.siteLabourTravelOtRate,
      body.driverOtRate, body.supervisorSiteOtRate, body.supervisorTravelOtRate, body.epfEmployeeRate,
      body.epfEmployerRate, body.etfEmployerRate, body.epfBasis, body.etfBasis, req.user.id]);
    const row = await getOne(`${policySelect} WHERE p.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'payroll_policy', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A payroll policy already starts on that date' });
    throw error;
  }
}));

const componentSchema = z.object({
  employeeId: z.number().int().positive(), name: z.string().trim().min(2).max(120),
  kind: z.enum(['Allowance', 'Deduction', 'Reimbursement']), amount: z.number().nonnegative(),
  payFrequency: z.enum(PAY_FREQUENCIES), effectiveFrom: isoDate, effectiveTo: isoDate.nullable().optional()
}).refine(value => !value.effectiveTo || value.effectiveTo >= value.effectiveFrom,
  { message: 'The end date cannot be before the start date', path: ['effectiveTo'] });

router.post('/settings/components', auth, permit('hr.payroll'), validate(componentSchema), wrap(async (req, res) => {
  const body = req.body;
  if (!await getOne('SELECT id FROM employees WHERE id=?', [body.employeeId]))
    return res.status(404).json({ error: 'Employee not found' });
  const result = await query(`INSERT INTO employee_pay_components
    (employee_id,name,kind,amount,pay_frequency,effective_from,effective_to,created_by)
    VALUES (?,?,?,?,?,?,?,?)`, [body.employeeId, body.name, body.kind, body.amount, body.payFrequency,
    body.effectiveFrom, body.effectiveTo || null, req.user.id]);
  const row = await getOne('SELECT * FROM employee_pay_components WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'employee_pay_component', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/settings/components/:id', auth, permit('hr.payroll'), validate(z.object({ active: z.boolean() })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM employee_pay_components WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Pay component not found' });
  await query('UPDATE employee_pay_components SET active=? WHERE id=?', [req.body.active, before.id]);
  const after = await getOne('SELECT * FROM employee_pay_components WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee_pay_component', before.id, before, after, req.ip);
  res.json(after);
}));

const payProfileSchema = z.object({
  payrollCompanyId: z.number().int().positive().default(1),
  payBasis: z.enum(PAY_BASES), payFrequency: z.enum(PAY_FREQUENCIES),
  payrollCategory: z.enum(PAYROLL_CATEGORIES), basicSalary: z.number().nonnegative(),
  weeklyRate: z.number().nonnegative(), dailyRate: z.number().nonnegative(),
  compensationEffectiveFrom: isoDate, epfEligible: z.boolean(), etfEligible: z.boolean(),
  customOfficeOtRate: z.number().nonnegative().nullable().optional(),
  customSiteOtRate: z.number().nonnegative().nullable().optional(),
  customTravelOtRate: z.number().nonnegative().nullable().optional()
});

router.patch('/settings/employees/:id', auth, permit('hr.payroll', 'hr.manage'), validate(payProfileSchema), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM employees WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Employee not found' });
  const body = req.body;
  const profileError = payProfileError(body);
  if (profileError) return res.status(400).json({ error: profileError });
  await query(`UPDATE employees SET payroll_company_id=?,pay_basis=?,pay_frequency=?,payroll_category=?,basic_salary=?,weekly_rate=?,daily_rate=?,
    compensation_effective_from=?,epf_eligible=?,etf_eligible=?,custom_office_ot_rate=?,custom_site_ot_rate=?,custom_travel_ot_rate=?
    WHERE id=?`, [body.payrollCompanyId, body.payBasis, body.payFrequency, body.payrollCategory, body.basicSalary, body.weeklyRate,
    body.dailyRate, body.compensationEffectiveFrom, body.epfEligible, body.etfEligible,
    body.customOfficeOtRate ?? null, body.customSiteOtRate ?? null, body.customTravelOtRate ?? null, before.id]);
  const after = await getOne('SELECT * FROM employees WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee_pay_profile', before.id, before, after, req.ip);
  res.json({ id: before.id });
}));

router.get('/:id', auth, permit('hr.payroll'), wrap(async (req, res) => {
  const run = await getOne(`${select} WHERE r.id=?`, [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  const payslips = await query(`SELECT s.id,s.days_present daysPresent,s.days_absent daysAbsent,s.overtime_hours overtimeHours,
    s.basic,s.overtime_pay overtimePay,s.unpaid_leave_deduction unpaidLeaveDeduction,
    s.office_ot_hours officeOtHours,s.office_ot_pay officeOtPay,s.site_ot_hours siteOtHours,s.site_ot_pay siteOtPay,
    s.travel_ot_hours travelOtHours,s.travel_ot_pay travelOtPay,s.allowance_total allowanceTotal,
    s.reimbursement_total reimbursementTotal,s.gross_earnings grossEarnings,
    s.epf_employee_deduction epfEmployeeDeduction,s.epf_employer_contribution epfEmployerContribution,
    s.etf_employer_contribution etfEmployerContribution,s.other_deduction otherDeduction,
    s.salary_advance_deduction salaryAdvanceDeduction,s.deductions,s.net_pay netPay,s.employer_cost employerCost,
    e.name employee,e.code employeeCode,e.designation
    FROM payslips s JOIN employees e ON e.id=s.employee_id WHERE s.run_id=? ORDER BY e.code`, [run.id]);
  const advanceRecoveries = await query(`SELECT sar.id,sar.payslip_id payslipId,sar.amount,
    pe.entry_date advanceDate,pe.description,e.id employeeId,e.name employee,e.code employeeCode
    FROM salary_advance_recoveries sar JOIN payslips ps ON ps.id=sar.payslip_id
    JOIN petty_cash_entries pe ON pe.id=sar.entry_id JOIN employees e ON e.id=ps.employee_id
    WHERE ps.run_id=? ORDER BY e.code,pe.entry_date,pe.id`, [run.id]);
  const components = await query(`SELECT sc.id,sc.payslip_id payslipId,sc.name,sc.kind,sc.amount
    FROM payslip_components sc JOIN payslips ps ON ps.id=sc.payslip_id
    WHERE ps.run_id=? ORDER BY sc.kind,sc.name`, [run.id]);
  res.json({ ...run, payslips: payslips.map(slip => ({ ...slip,
    advanceRecoveries: advanceRecoveries.filter(row => row.payslipId === slip.id),
    components: components.filter(row => row.payslipId === slip.id) })) });
}));

/**
 * Builds a draft run for the period: days present come from attendance, overtime from
 * approved overtime records, and unpaid leave is deducted at the daily rate.
 */
router.post('/', auth, permit('hr.payroll'), validate(z.object({
  companyId: z.number().int().positive().default(1),
  periodStart: isoDate,
  periodEnd: isoDate,
  payFrequency: z.enum(PAY_FREQUENCIES).default('Monthly')
})), wrap(async (req, res) => {
  const { companyId, periodStart, periodEnd, payFrequency } = req.body;
  if (periodEnd < periodStart) return res.status(400).json({ error: 'The period end must fall after its start' });

  const policy = await getOne('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1', [companyId, periodEnd]);
  if (!policy) return res.status(409).json({ error: 'Configure a payroll policy for this period first' });

  const employees = await query(`SELECT e.id,e.name,e.basic_salary,e.daily_rate,e.weekly_rate,e.pay_basis,e.pay_frequency,
      e.epf_eligible,e.etf_eligible,
      (SELECT COUNT(*) FROM attendance a WHERE (a.employee_id=e.id OR a.employee_name=e.name)
        AND a.work_date BETWEEN ? AND ? AND a.state IN ('On site','Late','Checked out','Business trip')) days_present,
      (SELECT COUNT(*) FROM attendance a WHERE (a.employee_id=e.id OR a.employee_name=e.name)
        AND a.work_date BETWEEN ? AND ? AND a.state='Absent') days_absent,
      (SELECT COALESCE(SUM(o.hours),0) FROM overtime_records o WHERE o.employee_id=e.id
        AND o.work_date BETWEEN ? AND ? AND o.status='Approved') overtime_hours,
      (SELECT COALESCE(SUM(o.hours*o.rate),0) FROM overtime_records o WHERE o.employee_id=e.id
        AND o.work_date BETWEEN ? AND ? AND o.status='Approved') overtime_pay,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Office' THEN o.hours ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') office_ot_hours,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Office' THEN o.hours*o.rate ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') office_ot_pay,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Site' THEN o.hours ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') site_ot_hours,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Site' THEN o.hours*o.rate ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') site_ot_pay,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Travel' THEN o.hours ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') travel_ot_hours,
      (SELECT COALESCE(SUM(CASE WHEN o.overtime_type='Travel' THEN o.hours*o.rate ELSE 0 END),0) FROM overtime_records o
        WHERE o.employee_id=e.id AND o.work_date BETWEEN ? AND ? AND o.status='Approved') travel_ot_pay,
      (SELECT COALESCE(SUM(l.days),0) FROM leave_requests l WHERE l.employee_id=e.id AND l.status='Approved'
        AND l.leave_type='Unpaid' AND l.from_date BETWEEN ? AND ?) unpaid_days,
      (SELECT COALESCE(SUM(GREATEST(0,ABS(pe.amount)-COALESCE(
          (SELECT SUM(sar.amount) FROM salary_advance_recoveries sar WHERE sar.entry_id=pe.id),0))),0)
        FROM petty_cash_entries pe JOIN petty_cash_floats pf ON pf.id=pe.float_id
        WHERE pe.employee_id=e.id AND pf.account_type='Salary advance' AND pe.kind='Spend'
          AND pe.entry_date<=?) salary_advance
    FROM employees e WHERE e.status <> 'Left' AND e.payroll_company_id=? AND e.pay_frequency=?
      AND COALESCE(e.compensation_effective_from,e.join_date)<=? ORDER BY e.code`,
  [...Array.from({ length: 11 }, () => [periodStart, periodEnd]).flat(), periodEnd, companyId, payFrequency, periodEnd]);

  if (!employees.length) return res.status(409).json({ error: `No active ${payFrequency.toLowerCase()}-paid employees fall inside this period` });

  const components = await query(`SELECT * FROM employee_pay_components
    WHERE active=1 AND pay_frequency=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
    ORDER BY employee_id,id`, [payFrequency, periodEnd, periodStart]);

  const reference = await nextReference('PAY', 'payroll_runs');
  try {
    const runId = await transaction(async connection => {
      const [run] = await connection.execute(
        'INSERT INTO payroll_runs (company_id,reference,period_start,period_end,pay_frequency,policy_id,created_by) VALUES (?,?,?,?,?,?,?)',
        [companyId, reference, periodStart, periodEnd, payFrequency, policy.id, req.user.id]);

      let total = 0;
      for (const employee of employees) {
        const employeeComponents = components.filter(row => row.employee_id === employee.id);
        const calculation = calculatePayslip(employee, policy, employeeComponents);
        total += calculation.netPay;
        const [slip] = await connection.execute(`INSERT INTO payslips
          (run_id,employee_id,days_present,days_absent,overtime_hours,basic,overtime_pay,
           office_ot_hours,office_ot_pay,site_ot_hours,site_ot_pay,travel_ot_hours,travel_ot_pay,
           allowance_total,reimbursement_total,gross_earnings,epf_employee_deduction,
           epf_employer_contribution,etf_employer_contribution,other_deduction,
           unpaid_leave_deduction,salary_advance_deduction,deductions,net_pay,employer_cost)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [run.insertId, employee.id, employee.days_present, employee.days_absent, employee.overtime_hours,
          calculation.basic, calculation.overtimePay, employee.office_ot_hours, employee.office_ot_pay, employee.site_ot_hours,
          employee.site_ot_pay, employee.travel_ot_hours, employee.travel_ot_pay, calculation.allowanceTotal,
          calculation.reimbursementTotal, calculation.grossEarnings, calculation.epfEmployeeDeduction,
          calculation.epfEmployerContribution, calculation.etfEmployerContribution, calculation.otherDeduction,
          calculation.unpaidLeaveDeduction, calculation.salaryAdvanceDeduction, calculation.deductions,
          calculation.netPay, calculation.employerCost]);

        for (const component of employeeComponents) await connection.execute(`INSERT INTO payslip_components
          (payslip_id,source_component_id,name,kind,amount) VALUES (?,?,?,?,?)`,
        [slip.insertId, component.id, component.name, component.kind, component.amount]);

        /* Recover oldest advances first and keep any unpaid remainder for a later run. */
        let remaining = calculation.salaryAdvanceDeduction;
        if (remaining > 0) {
          const [advances] = await connection.execute(`SELECT pe.id,ABS(pe.amount) amount,
              COALESCE((SELECT SUM(sar.amount) FROM salary_advance_recoveries sar WHERE sar.entry_id=pe.id),0) recovered
            FROM petty_cash_entries pe JOIN petty_cash_floats pf ON pf.id=pe.float_id
            WHERE pe.employee_id=? AND pf.account_type='Salary advance' AND pe.kind='Spend' AND pe.entry_date<=?
            ORDER BY pe.entry_date,pe.id FOR UPDATE`, [employee.id, periodEnd]);
          for (const advance of advances) {
            const outstanding = Math.max(0, Number(advance.amount) - Number(advance.recovered));
            const applied = Math.min(remaining, outstanding);
            if (applied > 0) await connection.execute(
              'INSERT INTO salary_advance_recoveries (entry_id,payslip_id,amount) VALUES (?,?,?)',
              [advance.id, slip.insertId, applied]);
            remaining -= applied;
            if (remaining <= 0.001) break;
          }
        }
      }
      await connection.execute('UPDATE payroll_runs SET total=? WHERE id=?', [total, run.insertId]);
      await audit(connection, req.user.id, 'CREATE', 'payroll_run', run.insertId, null, { reference, total }, req.ip);
      return run.insertId;
    });
    res.status(201).json(await getOne(`${select} WHERE r.id=?`, [runId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `A ${payFrequency.toLowerCase()} payroll run already exists for that period` });
    throw error;
  }
}));

/** Approving locks the run; marking it paid posts the wage bill as a labour cost. */
router.patch('/:id', auth, permit('hr.payroll'), validate(z.object({ status: z.enum(['Draft', 'Approved', 'Paid']) })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Payroll run not found' });
  await query('UPDATE payroll_runs SET status=?,approved_by=? WHERE id=?',
    [req.body.status, req.body.status === 'Draft' ? null : req.user.id, before.id]);
  await audit(pool, req.user.id, req.body.status.toUpperCase(), 'payroll_run', before.id, before, { status: req.body.status }, req.ip);
  res.json(await getOne(`${select} WHERE r.id=?`, [before.id]));
}));

/* Performance reviews (PID 2.2 "Performance Reports") */
const reviewSelect = `SELECT r.id,r.review_date reviewDate,r.period,r.quality,r.productivity,r.safety,r.reliability,
  r.overall,r.strengths,r.improvements,e.name employee,e.code employeeCode,e.id employeeId,u.name reviewer
  FROM performance_reviews r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=r.reviewer_id`;

/*
 * Appraisals sit with pay, not with the staff directory.
 *
 * This was open to any signed-in account, so scores, strengths and the "needs improvement"
 * notes on every employee were readable by the whole company. It follows the same rights as
 * salary: the people who run payroll and the people who maintain the register.
 */
router.get('/reviews/all', auth, permit('hr.payroll', 'hr.manage'), wrap(async (req, res) => {
  const rows = await query(`${reviewSelect} ORDER BY r.id DESC`);
  /* Reading every appraisal in the company is worth a line in the trail. Writes were
     recorded and reads were not, which leaves no answer to "who looked at this". */
  await audit(pool, req.user.id, 'READ', 'performance_reviews', '', null, { rows: rows.length }, req.ip);
  res.json(rows);
}));

router.post('/reviews/:employeeId', auth, permit('hr.payroll'), validate(z.object({
  reviewDate: isoDate,
  period: z.string().min(2).max(60),
  quality: z.number().int().min(1).max(5),
  productivity: z.number().int().min(1).max(5),
  safety: z.number().int().min(1).max(5),
  reliability: z.number().int().min(1).max(5),
  strengths: z.string().max(1000).optional(),
  improvements: z.string().max(1000).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const overall = ((body.quality + body.productivity + body.safety + body.reliability) / 4).toFixed(1);
  const result = await query(`INSERT INTO performance_reviews
    (employee_id,review_date,period,quality,productivity,safety,reliability,overall,strengths,improvements,reviewer_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [req.params.employeeId, body.reviewDate, body.period, body.quality, body.productivity, body.safety,
    body.reliability, overall, body.strengths || null, body.improvements || null, req.user.id]);
  await audit(pool, req.user.id, 'CREATE', 'performance_review', result.insertId, null, { overall }, req.ip);
  res.status(201).json(await getOne(`${reviewSelect} WHERE r.id=?`, [result.insertId]));
}));

export default router;
