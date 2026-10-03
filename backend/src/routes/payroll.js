import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, permissionsFor, validate, wrap } from '../lib/http.js';
import { PAY_BASES, PAY_FREQUENCIES, PAYROLL_CATEGORIES, calculatePayslip, payProfileError } from '../lib/payroll-policy.js';
import {rulesFor,calculateTransport,calculateLateDeduction,INITIAL_HR_RULES} from '../lib/hr-payroll-rules.js';
import { contributionEligibility, DEFAULT_STATUTORY_RULES } from '../lib/statutory-eligibility.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const percent = z.number().min(0).max(100);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

router.get('/schedules',auth,permit("hr.settings"),wrap(async(req,res)=>res.json(await query('SELECT id,period_start periodStart,period_end periodEnd,pay_frequency payFrequency,run_at runAt,status,message FROM payroll_schedules WHERE company_id=? ORDER BY id DESC',[Number(req.query.companyId)||1]))));
router.post('/schedules',auth,permit("hr.settings"),validate(z.object({companyId:z.number().int().positive(),periodStart:isoDate,periodEnd:isoDate,payFrequency:z.enum(PAY_FREQUENCIES),runAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)})),wrap(async(req,res)=>{
  const b=req.body;
  if(b.periodEnd<b.periodStart) return res.status(400).json({error:'Payroll period cannot end before it starts.'});
  if(new Date(`${b.runAt}:00+05:30`).getTime()<=Date.now()) return res.status(400).json({error:'Choose a future payroll run date and time (Sri Lanka time).'});
  const result=await query('INSERT INTO payroll_schedules(company_id,period_start,period_end,pay_frequency,run_at,created_by) VALUES(?,?,?,?,?,?)',[b.companyId,b.periodStart,b.periodEnd,b.payFrequency,b.runAt.replace('T',' '),req.user.id]);
  res.status(201).json({id:result.insertId});
}));

export function startPayrollScheduler(){
  let scanning=false;
  const scan=async()=>{
    if(scanning)return;scanning=true;
    try{
      const schedules=await query("SELECT *,DATE_FORMAT(period_start,'%Y-%m-%d') periodStart,DATE_FORMAT(period_end,'%Y-%m-%d') periodEnd FROM payroll_schedules WHERE status='Scheduled' AND run_at<=CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+05:30')");
      for(const schedule of schedules){
        const claimed=await query("UPDATE payroll_schedules SET status='Running' WHERE id=? AND status='Scheduled'",[schedule.id]);
        if(!claimed.affectedRows)continue;
        let status=200;
        const res={status(value){status=value;return this;},async json(body){await query('UPDATE payroll_schedules SET status=?,message=? WHERE id=?',[status===201?'Completed':'Failed',body.error||'Draft payroll created. HR must review and approve it.',schedule.id]);}};
        try{
          const user=await getOne('SELECT id,active,role_id FROM users WHERE id=?',[schedule.created_by]);
          if(!user?.active)throw new Error('The scheduling user is no longer active. HR must schedule this payroll again.');
          if(!(await permissionsFor(user.id,user.role_id)).includes('hr.payroll'))throw new Error('The scheduling user no longer has payroll permission. HR must schedule this payroll again.');
          await generatePayroll({body:{companyId:schedule.company_id,periodStart:schedule.periodStart,periodEnd:schedule.periodEnd,payFrequency:schedule.pay_frequency},user,ip:'automatic-payroll'},res);
        }catch(error){await query("UPDATE payroll_schedules SET status='Failed',message=? WHERE id=?",[error.message.slice(0,600),schedule.id]);}
      }
    }finally{scanning=false;}
  };
  const timer=setInterval(()=>scan().catch(error=>console.error('Payroll scheduler:',error.message)),60000);timer.unref();
  void scan().catch(error=>console.error('Payroll scheduler:',error.message));
}

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
  etfBasis: z.literal('Basic earnings').default('Basic earnings'),
  statutoryRules: z.object({
    permanentOnly: z.boolean(), minimumMonthlySalary: z.number().nonnegative(),
    weeklyWeeksPerMonth: z.number().positive(), dailyDaysPerMonth: z.number().positive()
  }).default(DEFAULT_STATUTORY_RULES),
  hrRules:z.object({normalStart:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),normalEnd:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),paidHoursPerDay:z.number().positive().max(24).default(8),otInterval:z.number().positive().max(4),minimumOt:z.number().nonnegative().max(24),maxDailyOt:z.number().positive().max(24),lateGraceMinutes:z.number().int().nonnegative().default(30),lateHalfRateUntilMinutes:z.number().int().positive().default(45),lateThreeQuarterRateUntilMinutes:z.number().int().positive().default(60),lateIncrementMinutes:z.number().int().positive().default(15),lateIncrementFraction:z.number().positive().max(10).default(0.25),transportDivisor:z.number().positive().max(366),fullTransportDays:z.number().int().min(0).max(366).nullable(),fullTransportComparison:z.enum(['At least','More than']),longDistanceKm:z.number().nonnegative(),longDistancePayment:z.number().nonnegative(),supervisorSiteCharge:z.number().nonnegative().default(500),mileageRate:z.number().nonnegative(),fixedTravelPayment:z.number().nonnegative(),allowMileageAndFixed:z.boolean(),countLeaveForTransport:z.boolean(),countAbsenceForTransport:z.boolean(),separateApproval:z.boolean().default(false)}).refine(r=>r.normalEnd>r.normalStart,'Normal shift end must be after its start').refine(r=>r.lateGraceMinutes<r.lateHalfRateUntilMinutes&&r.lateHalfRateUntilMinutes<r.lateThreeQuarterRateUntilMinutes,'Late deduction thresholds must increase from grace to 50%, 75% and one hour').default(INITIAL_HR_RULES)
});

const policySelect = `SELECT p.id,p.company_id companyId,c.name company,p.effective_from effectiveFrom,p.office_ot_rate officeOtRate,
  p.site_labour_site_ot_rate siteLabourSiteOtRate,p.site_labour_travel_ot_rate siteLabourTravelOtRate,
  p.driver_ot_rate driverOtRate,p.supervisor_site_ot_rate supervisorSiteOtRate,
  p.supervisor_travel_ot_rate supervisorTravelOtRate,p.epf_employee_rate epfEmployeeRate,
  p.epf_employer_rate epfEmployerRate,p.etf_employer_rate etfEmployerRate,
  p.epf_basis epfBasis,p.etf_basis etfBasis,p.hr_rules hrRules,p.statutory_rules statutoryRules,u.name createdBy,p.created_at createdAt
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

router.get('/settings', auth, permit("hr.settings"), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId || 1);
  const [policies, components] = await Promise.all([
    query(`${policySelect} WHERE p.company_id=? ORDER BY p.effective_from DESC,p.id DESC`, [companyId]),
    query(`SELECT c.id,c.employee_id employeeId,e.code employeeCode,e.name employee,c.name,c.kind,c.amount,
      c.pay_frequency payFrequency,c.effective_from effectiveFrom,c.effective_to effectiveTo,c.active,c.calculation_method calculationMethod,c.allowance_type allowanceType,
      u.name createdBy,c.created_at createdAt
      FROM employee_pay_components c JOIN employees e ON e.id=c.employee_id JOIN users u ON u.id=c.created_by
      WHERE e.payroll_company_id=? ORDER BY c.active DESC,e.code,c.kind,c.name`, [companyId])
  ]);
  res.json({ activePolicy: policies.find(row => String(row.effectiveFrom).slice(0, 10) <= new Date().toISOString().slice(0, 10)) || null,
    policies, components });
}));

router.post('/settings/policies', auth, permit("hr.settings"), validate(policySchema), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query(`INSERT INTO payroll_policies
      (company_id,effective_from,office_ot_rate,site_labour_site_ot_rate,site_labour_travel_ot_rate,driver_ot_rate,
       supervisor_site_ot_rate,supervisor_travel_ot_rate,epf_employee_rate,epf_employer_rate,etf_employer_rate,
       epf_basis,etf_basis,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.companyId, body.effectiveFrom, body.officeOtRate, body.siteLabourSiteOtRate, body.siteLabourTravelOtRate,
      body.driverOtRate, body.supervisorSiteOtRate, body.supervisorTravelOtRate, body.epfEmployeeRate,
      body.epfEmployerRate, body.etfEmployerRate, body.epfBasis, body.etfBasis, req.user.id]);
    await query('UPDATE payroll_policies SET hr_rules=? WHERE id=?',[JSON.stringify(body.hrRules),result.insertId]);
    await query('UPDATE payroll_policies SET statutory_rules=? WHERE id=?',[JSON.stringify(body.statutoryRules),result.insertId]);
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
  payFrequency: z.enum(PAY_FREQUENCIES), effectiveFrom: isoDate, effectiveTo: isoDate.nullable().optional(),
  calculationMethod:z.enum(['Fixed full amount','Attendance-prorated amount','Per-day amount','Manually approved amount']).default('Fixed full amount'),
  allowanceType:z.enum(['Other','Transport','Machine/operator','Special duty']).default('Other')
}).refine(value => !value.effectiveTo || value.effectiveTo >= value.effectiveFrom,
  { message: 'The end date cannot be before the start date', path: ['effectiveTo'] });

router.post('/settings/components', auth, permit("hr.settings"), validate(componentSchema), wrap(async (req, res) => {
  const body = req.body;
  if (!await getOne('SELECT id FROM employees WHERE id=?', [body.employeeId]))
    return res.status(404).json({ error: 'Employee not found' });
  const result = await query(`INSERT INTO employee_pay_components
    (employee_id,name,kind,amount,pay_frequency,effective_from,effective_to,created_by)
    VALUES (?,?,?,?,?,?,?,?)`, [body.employeeId, body.name, body.kind, body.amount, body.payFrequency,
    body.effectiveFrom, body.effectiveTo || null, req.user.id]);
  await query('UPDATE employee_pay_components SET calculation_method=?,allowance_type=? WHERE id=?',[body.calculationMethod,body.allowanceType,result.insertId]);
  const row = await getOne('SELECT * FROM employee_pay_components WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'employee_pay_component', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/settings/components/:id', auth, permit("hr.settings"), validate(z.object({ active: z.boolean() })), wrap(async (req, res) => {
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
  compensationEffectiveFrom: isoDate, epfEligible: z.boolean(), etfEligible: z.boolean(), contributionStartDate: isoDate.nullable().optional(),
  customOfficeOtRate: z.number().nonnegative().nullable().optional(),
  customSiteOtRate: z.number().nonnegative().nullable().optional(),
  customTravelOtRate: z.number().nonnegative().nullable().optional()
  ,allowanceEligibility:z.object({transport:z.boolean(),longDistance:z.boolean(),motorcycle:z.boolean(),machine:z.boolean(),specialDuty:z.boolean()}).optional()
});

router.patch('/settings/employees/:id', auth, permit("hr.settings"), validate(payProfileSchema), wrap(async (req, res) => {
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
  if(body.allowanceEligibility)await query('UPDATE employees SET allowance_eligibility=? WHERE id=?',[JSON.stringify(body.allowanceEligibility),before.id]);
  if(body.contributionStartDate !== undefined)await query('UPDATE employees SET contribution_start_date=? WHERE id=?',[body.contributionStartDate || null,before.id]);
  const after = await getOne('SELECT * FROM employees WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee_pay_profile', before.id, before, after, req.ip);
  res.json({ id: before.id });
}));

router.get('/:id', auth, permit('hr.payroll'), wrap(async (req, res) => {
  const run = await getOne(`${select} WHERE r.id=?`, [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  const payslips = await query(`SELECT s.id,s.days_present daysPresent,s.days_absent daysAbsent,s.overtime_hours overtimeHours,
    s.basic,s.contribution_base contributionBase,s.overtime_pay overtimePay,s.late_minutes lateMinutes,s.late_deduction lateDeduction,s.unpaid_leave_deduction unpaidLeaveDeduction,
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
  const components = await query(`SELECT sc.id,sc.payslip_id payslipId,sc.name,sc.kind,sc.amount,sc.calculation_detail calculationDetail
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
})), wrap(generatePayroll));

export async function generatePayroll(req, res) {
  const { companyId, periodStart, periodEnd, payFrequency } = req.body;
  if (periodEnd < periodStart) return res.status(400).json({ error: 'The period end must fall after its start' });
  const overlap=await getOne('SELECT id FROM payroll_runs WHERE company_id=? AND pay_frequency=? AND period_start<=? AND period_end>=?',[companyId,payFrequency,periodEnd,periodStart]);
  if(overlap)return res.status(409).json({error:'A payroll run overlaps this payment period. Review the existing draft/run rather than paying these inputs twice.'});

  const policy = await getOne('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1', [companyId, periodEnd]);
  if (!policy) return res.status(409).json({ error: 'Configure a payroll policy for this period first' });

  const employees = await query(`SELECT e.id,e.name,e.basic_salary,e.daily_rate,e.weekly_rate,e.pay_basis,e.pay_frequency,
      e.epf_eligible,e.etf_eligible,e.contribution_start_date,e.join_date,e.employment_type,e.allowance_eligibility,
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
      (SELECT COALESCE(SUM(GREATEST(0,1-DATEDIFF(GREATEST(l.from_date,?),LEAST(l.to_date,?)))),0) FROM leave_requests l WHERE l.employee_id=e.id AND l.status='Approved'
        AND l.payment_type='Unpaid') unpaid_days,
      (SELECT COALESCE(SUM(GREATEST(0,ABS(pe.amount)-COALESCE(
          (SELECT SUM(sar.amount) FROM salary_advance_recoveries sar WHERE sar.entry_id=pe.id),0))),0)
        FROM petty_cash_entries pe JOIN petty_cash_floats pf ON pf.id=pe.float_id
        WHERE pe.employee_id=e.id AND pf.account_type='Salary advance' AND pe.kind='Spend'
          AND pe.entry_date<=?) salary_advance
    FROM employees e WHERE e.status <> 'Left' AND e.payroll_company_id=? AND e.pay_frequency=?
      AND COALESCE(e.compensation_effective_from,e.join_date)<=? ORDER BY e.code`,
  [...Array.from({ length: 11 }, () => [periodStart, periodEnd]).flat(), periodEnd, companyId, payFrequency, periodEnd]);

  if (!employees.length) return res.status(409).json({ error: `No active ${payFrequency.toLowerCase()}-paid employees fall inside this period` });
  const attendanceRows=await query(`SELECT employee_id,employee_name,check_in,state FROM attendance WHERE work_date BETWEEN ? AND ? AND check_in IS NOT NULL`,[periodStart,periodEnd]);
  const activeRules=rulesFor(policy);
  for (const row of employees) {
    const eligibility = contributionEligibility(row, policy, periodEnd);
    row.epf_eligible = eligibility.epf;
    row.etf_eligible = eligibility.etf;
    const late=attendanceRows.filter(a=>Number(a.employee_id)===Number(row.id)||!a.employee_id&&a.employee_name===row.name)
      .map(a=>calculateLateDeduction(a,activeRules,row.daily_rate));
    row.late_minutes=late.reduce((sum,item)=>sum+item.lateMinutes,0);
    row.late_deduction=money(late.reduce((sum,item)=>sum+item.amount,0));
  }
  const covered=await getOne(`SELECT ps.employee_id FROM payslips ps JOIN payroll_runs pr ON pr.id=ps.run_id WHERE ps.employee_id IN (${employees.map(()=>'?').join(',')}) AND pr.period_start<=? AND pr.period_end>=? LIMIT 1`,[...employees.map(e=>e.id),periodEnd,periodStart]);
  if(covered)return res.status(409).json({error:'An employee is already included in another payroll run for these dates. Changing payment frequency must not pay the same period twice.'});

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
        const rules=rulesFor(policy);
        const extraStates=[...(rules.countLeaveForTransport?['On leave']:[]),...(rules.countAbsenceForTransport?['Absent']:[])];
        const [extraDays]=extraStates.length?await connection.query(`SELECT COUNT(DISTINCT work_date) days FROM attendance WHERE employee_id=? AND work_date BETWEEN ? AND ? AND state IN (${extraStates.map(()=>'?').join(',')})`,[employee.id,periodStart,periodEnd,...extraStates]):[[{days:0}]];
        const eligibleTransportDays=Number(employee.days_present)+Number(extraDays[0].days);
        const eligibility=typeof employee.allowance_eligibility==='string'?JSON.parse(employee.allowance_eligibility):employee.allowance_eligibility||{};
        const employeeComponents = components.filter(row => row.employee_id === employee.id && (row.allowance_type==='Other'||eligibility[{Transport:'transport','Machine/operator':'machine','Special duty':'specialDuty'}[row.allowance_type]])).map(row=>{
          if(row.calculation_method==='Attendance-prorated amount'&&row.allowance_type!=='Transport')return {...row,amount:money(Number(row.amount)/rulesFor(policy).transportDivisor*Number(employee.days_present)),formula:`${row.amount} ÷ ${rulesFor(policy).transportDivisor} × ${employee.days_present} eligible attendance days`};
          let result;
          try{result=calculateTransport(Number(row.amount),row.allowance_type==='Transport'?eligibleTransportDays:Number(employee.days_present),row.calculation_method,rules);}catch(e){throw Object.assign(e,{status:409});}
          return {...row,amount:result.amount,formula:result.formula};
        });
        const [claims]=await connection.query(`SELECT c.* FROM hr_payroll_claims c WHERE c.employee_id=? AND c.work_date BETWEEN ? AND ? AND c.status='Approved' AND NOT EXISTS(SELECT 1 FROM payslip_components pc WHERE pc.claim_id=c.id) FOR UPDATE`,[employee.id,periodStart,periodEnd]);
        for(const claim of claims){
          const c=typeof claim.calculation==='string'?JSON.parse(claim.calculation):claim.calculation;
          employeeComponents.push({id:null,claimId:claim.id,name:claim.kind==='Travel'?'Long-distance site allowance':claim.kind==='Mileage'?'Motorcycle mileage reimbursement':claim.kind==='Supervisor site charge'?'Supervisor site charge':`${claim.kind} allowance`,kind:claim.kind==='Mileage'?'Reimbursement':'Allowance',amount:claim.kind==='Travel'?c.allowance:claim.kind==='Mileage'?c.total:c.amount,formula:JSON.stringify({claimId:claim.id,date:claim.work_date,projectId:claim.project_id,calculation:c})});
        }
        const calculation = calculatePayslip(employee, policy, employeeComponents);
        total += calculation.netPay;
        const [slip] = await connection.execute(`INSERT INTO payslips
          (run_id,employee_id,days_present,days_absent,overtime_hours,basic,contribution_base,overtime_pay,
           office_ot_hours,office_ot_pay,site_ot_hours,site_ot_pay,travel_ot_hours,travel_ot_pay,
           allowance_total,reimbursement_total,gross_earnings,late_minutes,late_deduction,epf_employee_deduction,
           epf_employer_contribution,etf_employer_contribution,other_deduction,
           unpaid_leave_deduction,salary_advance_deduction,deductions,net_pay,employer_cost)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [run.insertId, employee.id, employee.days_present, employee.days_absent, employee.overtime_hours,
          calculation.basic, calculation.contributionBase, calculation.overtimePay, employee.office_ot_hours, employee.office_ot_pay, employee.site_ot_hours,
          employee.site_ot_pay, employee.travel_ot_hours, employee.travel_ot_pay, calculation.allowanceTotal,
          calculation.reimbursementTotal, calculation.grossEarnings, employee.late_minutes, calculation.lateDeduction, calculation.epfEmployeeDeduction,
          calculation.epfEmployerContribution, calculation.etfEmployerContribution, calculation.otherDeduction,
          calculation.unpaidLeaveDeduction, calculation.salaryAdvanceDeduction, calculation.deductions,
          calculation.netPay, calculation.employerCost]);

        for (const component of employeeComponents) await connection.execute(`INSERT INTO payslip_components
          (payslip_id,source_component_id,name,kind,amount,calculation_detail,claim_id) VALUES (?,?,?,?,?,?,?)`,
        [slip.insertId, component.id, component.name, component.kind, component.amount,component.formula,component.claimId||null]);
        const [sourceOt]=await connection.query("SELECT id,project_id,work_date,hours*rate amount FROM overtime_records WHERE employee_id=? AND work_date BETWEEN ? AND ? AND status='Approved' AND project_id IS NOT NULL",[employee.id,periodStart,periodEnd]);
        for(const o of sourceOt)await connection.query("INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,'Overtime',?,?)",[slip.insertId,o.project_id,employee.id,o.work_date,o.id,o.amount]);
        for(const c of claims.filter(c=>c.project_id)){
          const component=employeeComponents.find(p=>p.claimId===c.id);
          await connection.query("INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,'Claim',?,?)",[slip.insertId,c.project_id,employee.id,c.work_date,c.id,component.amount]);
        }
        const [sourceDays]=await connection.query(`SELECT a.id,a.project_id,a.work_date FROM attendance a WHERE a.employee_id=? AND a.work_date BETWEEN ? AND ? AND a.state IN ('On site','Late','Checked out','Business trip') AND a.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id WHERE l.employee_id=a.employee_id AND s.work_date=a.work_date AND s.status IN ('Submitted','Approved'))`,[employee.id,periodStart,periodEnd]);
        for(const a of sourceDays)await connection.query("INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,'Attendance',?,?)",[slip.insertId,a.project_id,employee.id,a.work_date,a.id,money((calculation.basic-calculation.unpaidLeaveDeduction)/Math.max(1,employee.days_present))]);

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
}

/** Approving locks the run; marking it paid posts the wage bill as a labour cost. */
router.patch('/:id', auth, permit('hr.payroll'), validate(z.object({ status: z.enum(['Draft', 'Approved', 'Paid']) })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Payroll run not found' });
  const allowed={Draft:['Approved'],Approved:['Paid'],Paid:[]};
  if(!allowed[before.status].includes(req.body.status))return res.status(409).json({error:'Payroll can only move from Draft to Approved, then Paid. Approved or paid salary snapshots cannot be reopened or changed.'});
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
