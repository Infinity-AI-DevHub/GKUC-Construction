import {attendanceForEmployee,salaryCalculationIssues} from '../lib/payroll-attendance-match.js';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, permissionsFor, validate, wrap, fail } from '../lib/http.js';
import {clearDraftPayroll,lockPayrollRun} from '../lib/payroll-drafts.js';
import {calculateAttendancePayroll} from '../lib/attendance-payroll.js';
import {calculatePayrollLeave} from '../lib/payroll-leave.js';
import { PAY_BASES, PAY_FREQUENCIES, PAYROLL_CATEGORIES, calculatePayslip, payProfileError } from '../lib/payroll-policy.js';
import {rulesFor,calculateTransport,INITIAL_HR_RULES} from '../lib/hr-payroll-rules.js';
import { contributionEligibility, contributionExplanation, DEFAULT_STATUTORY_RULES } from '../lib/statutory-eligibility.js';
import {writeWorkbook} from '../lib/xlsx-write.js';
import {sendDocument} from '../lib/document-pdf.js';
import {payrollSheets,payslipDocument} from '../lib/payroll-export.js';

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
  driverSiteOtRate: z.number().positive().optional(),
  driverTravelOtRate: z.number().positive().optional(),
  supervisorSiteOtRate: z.number().positive(),
  supervisorTravelOtRate: z.number().positive(),
  customOfficeOtRate: z.number().nonnegative().optional(),
  customSiteOtRate: z.number().nonnegative().optional(),
  customTravelOtRate: z.number().nonnegative().optional(),
  epfEmployeeRate: percent,
  epfEmployerRate: percent,
  etfEmployerRate: percent,
  epfBasis: z.literal('Basic earnings').default('Basic earnings'),
  etfBasis: z.literal('Basic earnings').default('Basic earnings'),
  statutoryRules: z.object({
    permanentOnly: z.boolean(), minimumMonthlySalary: z.number().nonnegative(),
    weeklyWeeksPerMonth: z.number().positive(), dailyDaysPerMonth: z.number().positive()
  }).default(DEFAULT_STATUTORY_RULES),
  hrRules:z.object({normalStart:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),normalEnd:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),paidHoursPerDay:z.number().positive().max(24).default(8),otInterval:z.number().positive().max(4),minimumOt:z.number().nonnegative().max(24),otGraceMinutes:z.number().int().min(0).max(240).default(0),maxDailyOt:z.number().positive().max(24),lateGraceMinutes:z.number().int().nonnegative().default(30),transportDivisor:z.number().positive().max(366),fullTransportDays:z.number().int().min(0).max(366).nullable(),fullTransportComparison:z.enum(['At least','More than']),longDistanceKm:z.number().nonnegative(),longDistancePayment:z.number().nonnegative(),supervisorSiteCharge:z.number().nonnegative().default(500),mileageRate:z.number().nonnegative(),fixedTravelPayment:z.number().nonnegative(),allowMileageAndFixed:z.boolean(),countLeaveForTransport:z.boolean(),countAbsenceForTransport:z.boolean(),separateApproval:z.boolean().default(false)}).refine(r=>r.normalEnd>r.normalStart,'Normal shift end must be after its start').default(INITIAL_HR_RULES)
});

const policySelect = `SELECT p.id,p.company_id companyId,c.name company,p.effective_from effectiveFrom,p.office_ot_rate officeOtRate,
  p.site_labour_site_ot_rate siteLabourSiteOtRate,p.site_labour_travel_ot_rate siteLabourTravelOtRate,
  p.driver_ot_rate driverOtRate,COALESCE(p.driver_site_ot_rate,p.driver_ot_rate) driverSiteOtRate,
  COALESCE(p.driver_travel_ot_rate,p.driver_ot_rate) driverTravelOtRate,p.supervisor_site_ot_rate supervisorSiteOtRate,
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
      FROM visible_employee_pay_components c JOIN visible_employees e ON e.id=c.employee_id JOIN users u ON u.id=c.created_by
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
    await query('UPDATE payroll_policies SET hr_rules=?,driver_site_ot_rate=?,driver_travel_ot_rate=? WHERE id=?',
      [JSON.stringify({...body.hrRules,
        customOfficeOtRate: body.customOfficeOtRate ?? body.officeOtRate,
        customSiteOtRate: body.customSiteOtRate ?? body.siteLabourSiteOtRate,
        customTravelOtRate: body.customTravelOtRate ?? body.siteLabourTravelOtRate
      }),body.driverSiteOtRate ?? body.driverOtRate,body.driverTravelOtRate ?? body.driverOtRate,result.insertId]);
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
  if (!await getOne('SELECT id FROM visible_employees WHERE id=?', [body.employeeId]))
    return res.status(404).json({ error: 'Employee not found' });
  const result = await query(`INSERT INTO employee_pay_components
    (employee_id,name,kind,amount,pay_frequency,effective_from,effective_to,created_by)
    VALUES (?,?,?,?,?,?,?,?)`, [body.employeeId, body.name, body.kind, body.amount, body.payFrequency,
    body.effectiveFrom, body.effectiveTo || null, req.user.id]);
  await query('UPDATE employee_pay_components SET calculation_method=?,allowance_type=? WHERE id=?',[body.calculationMethod,body.allowanceType,result.insertId]);
  const row = await getOne('SELECT * FROM visible_employee_pay_components WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'employee_pay_component', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/settings/components/:id', auth, permit("hr.settings"), validate(z.object({ active: z.boolean() })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM visible_employee_pay_components WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Pay component not found' });
  await query('UPDATE employee_pay_components SET active=? WHERE id=?', [req.body.active, before.id]);
  const after = await getOne('SELECT * FROM visible_employee_pay_components WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee_pay_component', before.id, before, after, req.ip);
  res.json(after);
}));

const payProfileSchema = z.object({
  payrollCompanyId: z.number().int().positive().default(1),
  payBasis: z.enum(PAY_BASES), payFrequency: z.enum(PAY_FREQUENCIES),
  payrollCategory: z.enum(PAYROLL_CATEGORIES), basicSalary: z.number().nonnegative(),
  weeklyRate: z.number().nonnegative(), dailyRate: z.number().nonnegative(),
  compensationEffectiveFrom: isoDate, epfEligible: z.boolean(), etfEligible: z.boolean(), contributionStartDate: isoDate.nullable().optional(),
  customOfficeOtRate: z.null().optional(),
  customSiteOtRate: z.null().optional(),
  customTravelOtRate: z.null().optional()
  ,allowanceEligibility:z.object({transport:z.boolean(),longDistance:z.boolean(),motorcycle:z.boolean(),machine:z.boolean(),specialDuty:z.boolean()}).optional()
});

router.patch('/settings/employees/:id', auth, permit("hr.settings"), validate(payProfileSchema), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM visible_employees WHERE id=?', [req.params.id]);
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
  const after = await getOne('SELECT * FROM visible_employees WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee_pay_profile', before.id, before, after, req.ip);
  res.json({ id: before.id });
}));

router.get('/:id', auth, permit('hr.payroll'), wrap(async (req, res) => {
  res.json(await payrollSnapshot(req.params.id));
}));

router.get('/:id/export.xlsx',auth,permit('hr.payroll'),wrap(async(req,res)=>{
  const run=await payrollSnapshot(req.params.id);
  res.setHeader('Cache-Control','no-store');
  res.attachment(`${run.reference.replace(/[^\w.-]/g,'-')}-salary-details.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(writeWorkbook(payrollSheets(run)));
}));
router.get('/:id/payslips/:slipId/document',auth,permit('hr.payroll'),wrap(async(req,res)=>{
  const run=await payrollSnapshot(req.params.id),slip=run.payslips.find(row=>String(row.id)===req.params.slipId);
  if(!slip)throw fail(404,'Payslip not found in this payroll run');
  res.setHeader('Cache-Control','no-store');
  await sendDocument(req,res,payslipDocument(run,slip),`${run.reference}-${slip.employeeCode}.pdf`);
}));

async function payrollSnapshot(id){
  const run = await getOne(`${select} WHERE r.id=?`, [id]);
  if (!run) throw fail(404,'Payroll run not found');
  const payslips = await query(`SELECT s.id,s.days_present daysPresent,s.days_absent daysAbsent,s.paid_leave_days paidLeaveDays,
    s.unpaid_leave_days unpaidLeaveDays,s.paid_leave_pay paidLeavePay,COALESCE(s.payable_days,s.days_present+s.paid_leave_days) payableDays,s.overtime_hours overtimeHours,
    s.basic,s.contribution_base contributionBase,s.overtime_pay overtimePay,s.late_minutes lateMinutes,s.late_deduction lateDeduction,s.unpaid_leave_deduction unpaidLeaveDeduction,
    s.office_ot_hours officeOtHours,s.office_ot_pay officeOtPay,s.site_ot_hours siteOtHours,s.site_ot_pay siteOtPay,
    s.travel_ot_hours travelOtHours,s.travel_ot_pay travelOtPay,s.allowance_total allowanceTotal,
    s.reimbursement_total reimbursementTotal,s.gross_earnings grossEarnings,
    s.epf_employee_deduction epfEmployeeDeduction,s.epf_employer_contribution epfEmployerContribution,
    s.etf_employer_contribution etfEmployerContribution,s.other_deduction otherDeduction,
    s.salary_advance_deduction salaryAdvanceDeduction,s.deductions,s.net_pay netPay,s.employer_cost employerCost,s.calculation_detail calculationDetail,
    e.name employee,e.code employeeCode,e.designation,e.join_date joinDate,e.employment_type employmentType,
    (SELECT name FROM departments WHERE id=e.department_id) department
    FROM payslips s JOIN visible_employees e ON e.id=s.employee_id WHERE s.run_id=? ORDER BY e.code`, [run.id]);
  const advanceRecoveries = await query(`SELECT sar.id,sar.payslip_id payslipId,sar.amount,
    pe.entry_date advanceDate,pe.description,e.id employeeId,e.name employee,e.code employeeCode
    FROM salary_advance_recoveries sar JOIN payslips ps ON ps.id=sar.payslip_id
    JOIN petty_cash_entries pe ON pe.id=sar.entry_id JOIN visible_employees e ON e.id=ps.employee_id
    WHERE ps.run_id=? ORDER BY e.code,pe.entry_date,pe.id`, [run.id]);
  const components = await query(`SELECT sc.id,sc.payslip_id payslipId,sc.name,sc.kind,sc.amount,sc.calculation_detail calculationDetail
    FROM payslip_components sc JOIN payslips ps ON ps.id=sc.payslip_id
    WHERE ps.run_id=? ORDER BY sc.kind,sc.name`, [run.id]);
  return { ...run, payslips: payslips.map(slip => ({ ...slip,
    advanceRecoveries: advanceRecoveries.filter(row => row.payslipId === slip.id),
    components: components.filter(row => row.payslipId === slip.id) })) };
}

/**
 * Builds a draft from attendance and dated policies. Reviewed OT replaces automatic
 * Office/Site hours; Travel remains a separately approved input.
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
  try {
    const runId = await transaction(connection => buildPayroll(req,connection));
    res.status(201).json(await getOne(`${select} WHERE r.id=?`, [runId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `A ${payFrequency.toLowerCase()} payroll run already exists for that period` });
    throw error;
  }
}

router.post('/batch',auth,permit('hr.payroll'),validate(z.object({
  companyIds:z.array(z.number().int().positive()).min(2).max(2).refine(ids=>new Set(ids).size===ids.length,'Select two different companies'),
  periodStart:isoDate,periodEnd:isoDate,payFrequency:z.enum(PAY_FREQUENCIES).default('Monthly')
})),wrap(async(req,res)=>{
  if(req.body.periodEnd<req.body.periodStart)throw fail(400,'The period end must fall after its start');
  const ids=await transaction(async connection=>{
    const runs=[];
    for(const companyId of [...req.body.companyIds].sort((a,b)=>a-b)){
      try{runs.push(await buildPayroll({...req,body:{...req.body,companyId}},connection));}
      catch(error){error.message=`Company ${companyId}: ${error.message}. Neither company payroll was changed.`;throw error;}
    }
    return runs;
  });
  const issues=await query(`SELECT e.name employee,e.code employeeCode,r.company_id companyId,s.basic earnedSalary,s.net_pay netPay,s.calculation_detail calculationDetail
    FROM payslips s JOIN payroll_runs r ON r.id=s.run_id JOIN visible_employees e ON e.id=s.employee_id
    WHERE r.id IN (?,?) AND (s.basic=0 OR s.net_pay=0) ORDER BY r.company_id,e.code`,ids);
  res.status(201).json({runs:await query(`${select} WHERE r.id IN (?,?) ORDER BY r.company_id`,ids),
    review:issues.map(({calculationDetail,...row})=>({...row,reasons:(typeof calculationDetail==='string'?JSON.parse(calculationDetail):calculationDetail)?.salary?.issues||[]}))});
}));

async function buildPayroll(req,connection){
      const {companyId,periodStart,periodEnd,payFrequency}=req.body;
      const query=async(sql,params=[])=>(await connection.execute(sql,params))[0];
      const getOne=async(sql,params=[])=>(await query(sql,params))[0];
      const payrollCompany=await getOne('SELECT id,name FROM companies WHERE id=? FOR UPDATE',[companyId]);
      if(!payrollCompany)throw fail(404,'Payroll company not found.');
      const overlaps=await query('SELECT * FROM payroll_runs WHERE company_id=? AND pay_frequency=? AND period_start<=? AND period_end>=? FOR UPDATE',[companyId,payFrequency,periodEnd,periodStart]);
      const existing=overlaps.find(row=>row.period_start===periodStart&&row.period_end===periodEnd);
      const conflicting=overlaps.filter(row=>row.id!==existing?.id);
      if(conflicting.length)throw fail(409,`Overlapping payroll: ${conflicting.map(row=>`${row.reference} (${payrollCompany.name}, ${row.pay_frequency}, ${row.period_start} to ${row.period_end}, ${row.status})`).join('; ')}. Delete the named Draft payroll or use its exact dates to recalculate it. Approved/paid payroll cannot be deleted.`);
      if(existing)await clearDraftPayroll(connection,existing,req.user.id,'REGENERATE',req.ip);

      const policy = await getOne('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1', [companyId, periodEnd]);
      if (!policy) throw fail(409,'Configure a payroll policy for this period first');

      const employees = await query(`SELECT e.id,e.code,e.name,e.designation,e.department_id,e.basic_salary,e.daily_rate,e.weekly_rate,e.pay_basis,e.pay_frequency,e.payroll_category,e.payroll_company_id,e.worker_type,
          e.epf_eligible,e.etf_eligible,e.contribution_start_date,e.join_date,e.employment_type,e.allowance_eligibility,
          (SELECT COALESCE(SUM(GREATEST(0,ABS(pe.amount)-COALESCE(
              (SELECT SUM(sar.amount) FROM salary_advance_recoveries sar WHERE sar.entry_id=pe.id),0))),0)
            FROM petty_cash_entries pe JOIN petty_cash_floats pf ON pf.id=pe.float_id
            WHERE pe.employee_id=e.id AND pf.account_type='Salary advance' AND pe.kind='Spend'
              AND pe.entry_date<=?) salary_advance
        FROM visible_employees e WHERE e.status <> 'Left' AND e.payroll_company_id=? AND e.pay_frequency=?
          AND COALESCE(e.compensation_effective_from,e.join_date)<=? ORDER BY e.code FOR UPDATE`,
      [periodEnd, companyId, payFrequency, periodEnd]);

      if (!employees.length) throw fail(409,`No active ${payFrequency.toLowerCase()}-paid employees fall inside this period`);
      const employeeNames=await query('SELECT id,name FROM employees');
      const departments=await query('SELECT id,name FROM departments');
      const attendanceRows=await query(`SELECT * FROM visible_attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date,id`,[periodStart,periodEnd]);
      const otRows=await query('SELECT * FROM visible_overtime_records WHERE work_date BETWEEN ? AND ? ORDER BY work_date,id',[periodStart,periodEnd]);
      const travelClaims=await query("SELECT * FROM visible_hr_payroll_claims WHERE kind='Travel' AND work_date BETWEEN ? AND ?",[periodStart,periodEnd]);
      const datedPolicies=await query('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC',[companyId,periodEnd]);
      const approvedLeave=await query("SELECT * FROM visible_leave_requests WHERE status='Approved' AND from_date<=? AND to_date>=? ORDER BY from_date,id",[periodEnd,periodStart]);
      for (const row of employees) {
        const contributionDetail = contributionExplanation(row, policy, periodEnd, payFrequency);
        const eligibility = contributionEligibility(row, policy, periodEnd);
        row.epf_eligible = eligibility.epf;
        row.etf_eligible = eligibility.etf;
        const days=attendanceForEmployee(row,attendanceRows,employeeNames);
        try {
          const leave=calculatePayrollLeave(row,days,approvedLeave,periodStart,periodEnd);
          const {attendance,detail,...leaveCounts}=leave;
          Object.assign(row,leaveCounts);
          Object.assign(row,calculateAttendancePayroll(row,attendance,otRows.filter(o=>Number(o.employee_id)===Number(row.id)),
            datedPolicies,travelClaims.filter(c=>Number(c.employee_id)===Number(row.id))));
          row.calculation_detail.leave=detail;
          row.calculation_detail.contributions=contributionDetail;
          row.calculation_detail.employee={name:row.name,code:row.code,designation:row.designation,
            department:departments.find(department=>Number(department.id)===Number(row.department_id))?.name||null,
            employmentType:row.employment_type,joinDate:row.join_date};
          row.calculation_detail.sourceAttendance=days.map(day=>({id:day.id,workDate:day.work_date,state:day.state,
            checkIn:day.check_in,checkOut:day.check_out,workLocation:day.work_location,projectId:day.project_id,
            needsReview:Boolean(day.needs_review)}));
        } catch(error) {throw fail(409,`${row.name}: ${error.message}`);}
      }
      const covered=await getOne(`SELECT ps.employee_id,e.name employee,c.name company,pr.reference,pr.company_id,pr.pay_frequency,pr.period_start,pr.period_end,pr.status FROM payslips ps JOIN payroll_runs pr ON pr.id=ps.run_id JOIN employees e ON e.id=ps.employee_id JOIN companies c ON c.id=pr.company_id WHERE ps.employee_id IN (${employees.map(()=>'?').join(',')}) AND pr.period_start<=? AND pr.period_end>=? LIMIT 1 FOR UPDATE`,[...employees.map(e=>e.id),periodEnd,periodStart]);
      if(covered)throw fail(409,`${covered.employee} is already included in ${covered.reference} (${covered.company}, ${covered.pay_frequency}, ${covered.period_start} to ${covered.period_end}, ${covered.status}). Delete that Draft payroll first or review the locked payroll. Changing company or frequency must not pay the same dates twice.`);

      const components = await query(`SELECT * FROM visible_employee_pay_components
        WHERE active=1 AND pay_frequency=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
        ORDER BY employee_id,id`, [payFrequency, periodEnd, periodStart]);

      const reference = existing?.reference || await nextReference('PAY', 'payroll_runs');
      const [run] = existing ? [{insertId:existing.id}] : await connection.execute(
        'INSERT INTO payroll_runs (company_id,reference,period_start,period_end,pay_frequency,policy_id,created_by) VALUES (?,?,?,?,?,?,?)',
        [companyId, reference, periodStart, periodEnd, payFrequency, policy.id, req.user.id]);

      let total = 0;
      for (const employee of employees) {
        const rules=rulesFor(policy);
        const eligibleTransportDays=Number(employee.days_present)+(rules.countLeaveForTransport?employee.leave_days_for_transport:0)
          +(rules.countAbsenceForTransport?employee.absent_days_for_transport:0);
        const eligibility=typeof employee.allowance_eligibility==='string'?JSON.parse(employee.allowance_eligibility):employee.allowance_eligibility||{};
        const employeeComponents = components.filter(row => row.employee_id === employee.id && (row.allowance_type==='Other'||eligibility[{Transport:'transport','Machine/operator':'machine','Special duty':'specialDuty'}[row.allowance_type]])).map(row=>{
          if(row.calculation_method==='Attendance-prorated amount'&&row.allowance_type!=='Transport')return {...row,amount:money(Number(row.amount)/rulesFor(policy).transportDivisor*Number(employee.days_present)),formula:`${row.amount} ÷ ${rulesFor(policy).transportDivisor} × ${employee.days_present} eligible attendance days`};
          let result;
          try{result=calculateTransport(Number(row.amount),row.allowance_type==='Transport'?eligibleTransportDays:Number(employee.days_present),row.calculation_method,rules);}catch(e){throw Object.assign(e,{status:409});}
          return {...row,amount:result.amount,formula:result.formula};
        });
        const [claims]=await connection.query(`SELECT c.* FROM visible_hr_payroll_claims c WHERE c.employee_id=? AND c.work_date BETWEEN ? AND ? AND c.status='Approved' AND NOT EXISTS(SELECT 1 FROM payslip_components pc WHERE pc.claim_id=c.id) FOR UPDATE`,[employee.id,periodStart,periodEnd]);
        for(const claim of claims){
          const c=typeof claim.calculation==='string'?JSON.parse(claim.calculation):claim.calculation;
          if(claim.kind==='Salary deduction'){
            const detail=typeof claim.detail==='string'?JSON.parse(claim.detail):claim.detail;
            employeeComponents.push({id:null,claimId:claim.id,name:`One-time salary deduction: ${detail.notes}`,kind:'Deduction',amount:c.amount,
              formula:JSON.stringify({claimId:claim.id,date:claim.work_date,reason:detail.notes,calculation:c})});
            continue;
          }
          employeeComponents.push({id:null,claimId:claim.id,name:claim.kind==='Travel'?(c.method==='Manual'?'Manual travel allowance':'Long-distance site allowance'):claim.kind==='Mileage'?'Motorcycle mileage reimbursement':claim.kind==='Supervisor site charge'?'Supervisor site charge':`${claim.kind} allowance`,kind:claim.kind==='Mileage'?'Reimbursement':'Allowance',amount:claim.kind==='Travel'?c.allowance:claim.kind==='Mileage'?c.total:c.amount,formula:JSON.stringify({claimId:claim.id,date:claim.work_date,projectId:claim.project_id,calculation:c})});
        }
        if (Number(employee.days_present)+Number(employee.paid_leave_days)>0 && Number(employee.daily_rate)<=0)
          throw fail(409,`${employee.name}: worked/paid-leave days exist, but the daily salary rate is zero. Set the employee daily rate in Payroll settings and rebuild this draft. The EPF/ETF basis cannot replace the daily rate.`);
        const calculation = calculatePayslip(employee, policy, employeeComponents, payFrequency);
        employee.calculation_detail.salary={dailyRate:Number(employee.daily_rate),workedDays:Number(employee.days_present),
          paidLeaveDays:Number(employee.paid_leave_days),shortDayReduction:calculation.shortDayReduction,
          issues:salaryCalculationIssues(employee,calculation)};
        for(const message of employee.calculation_detail.salary.issues)
          employee.calculation_detail.warnings.push({workDate:periodEnd,message});
        if(claims.some(claim=>claim.kind==='Salary deduction')&&calculation.deductions>calculation.grossEarnings+calculation.reimbursementTotal)
          throw fail(409,`Deductions exceed available pay for ${employee.name}. Review the one-time deduction before generating payroll.`);
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
        await connection.execute('UPDATE payslips SET calculation_detail=?,paid_leave_days=?,unpaid_leave_days=?,payable_days=?,paid_leave_pay=? WHERE id=?',
          [JSON.stringify(employee.calculation_detail),calculation.paidLeaveDays,calculation.unpaidLeaveDays,calculation.payableDays,calculation.paidLeavePay,slip.insertId]);

        for (const component of employeeComponents) await connection.execute(`INSERT INTO payslip_components
          (payslip_id,source_component_id,name,kind,amount,calculation_detail,claim_id) VALUES (?,?,?,?,?,?,?)`,
        [slip.insertId, component.id, component.name, component.kind, component.amount,component.formula,component.claimId||null]);
        for(const o of employee.calculation_detail.overtime.filter(o=>o.projectId))
          await connection.query('INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,?,?,?)',
            [slip.insertId,o.projectId,employee.id,o.workDate,o.source==='Attendance'?'Attendance OT':'Overtime',o.sourceId,o.amount]);
        for(const c of claims.filter(c=>c.project_id)){
          const component=employeeComponents.find(p=>p.claimId===c.id);
          await connection.query("INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,'Claim',?,?)",[slip.insertId,c.project_id,employee.id,c.work_date,c.id,component.amount]);
        }
        const [sourceDays]=await connection.query(`SELECT a.id,a.project_id,a.work_date FROM visible_attendance a WHERE a.employee_id=? AND a.work_date BETWEEN ? AND ? AND a.state IN ('On site','Late','Checked out','Business trip') AND a.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id WHERE l.employee_id=a.employee_id AND s.work_date=a.work_date AND s.status IN ('Submitted','Approved'))`,[employee.id,periodStart,periodEnd]);
        for(const a of sourceDays)await connection.query("INSERT INTO payroll_project_allocations(payslip_id,project_id,employee_id,work_date,source_type,source_id,amount) VALUES(?,?,?,?,'Attendance',?,?)",[slip.insertId,a.project_id,employee.id,a.work_date,a.id,money(employee.daily_rate)]);

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
      await connection.execute('UPDATE payroll_runs SET total=?,policy_id=?,created_by=?,approved_by=NULL,created_at=CURRENT_TIMESTAMP WHERE id=?', [total,policy.id,req.user.id, run.insertId]);
      await audit(connection, req.user.id, existing?'REGENERATED':'CREATE', 'payroll_run', run.insertId, null, { reference, total }, req.ip);
      return run.insertId;
}

/** Approving locks the run; marking it paid posts the wage bill as a labour cost. */
router.delete('/:id', auth, permit('hr.payroll'), wrap(async(req,res)=>{
  await transaction(async connection=>{
    const run=await lockPayrollRun(connection,req.params.id);
    await clearDraftPayroll(connection,run,req.user.id,'DELETE',req.ip);
    const [deleted]=await connection.execute("DELETE FROM payroll_runs WHERE id=? AND status='Draft'",[run.id]);
    if(deleted.affectedRows!==1)throw fail(409,'The draft was not deleted. Refresh payroll and retry; no deletion changes were saved.');
  });
  res.status(204).end();
}));

router.patch('/:id', auth, permit('hr.payroll'), validate(z.object({ status: z.enum(['Draft', 'Approved', 'Paid']) })), wrap(async (req, res) => {
  await transaction(async connection=>{
    const before = await lockPayrollRun(connection,req.params.id);
    const allowed={Draft:['Approved'],Approved:['Paid'],Paid:[]};
    if(!allowed[before.status].includes(req.body.status))throw fail(409,'Payroll can only move from Draft to Approved, then Paid. Approved or paid salary snapshots cannot be reopened or changed.');
    await connection.execute('UPDATE payroll_runs SET status=?,approved_by=? WHERE id=?',
      [req.body.status, req.body.status === 'Draft' ? null : req.user.id, before.id]);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'payroll_run', before.id, before, { status: req.body.status }, req.ip);
  });
  res.json(await getOne(`${select} WHERE r.id=?`, [req.params.id]));
}));

/* Performance reviews (PID 2.2 "Performance Reports") */
const reviewSelect = `SELECT r.id,r.review_date reviewDate,r.period,r.quality,r.productivity,r.safety,r.reliability,
  r.overall,r.strengths,r.improvements,e.name employee,e.code employeeCode,e.id employeeId,u.name reviewer
  FROM visible_performance_reviews r JOIN visible_employees e ON e.id=r.employee_id JOIN users u ON u.id=r.reviewer_id`;

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
