import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * PID 2.2 "Salary Information". Pay is calculated from what the system already knows —
 * recorded attendance and approved overtime — rather than re-entered by hand, which is
 * where payroll disputes normally start.
 */
const select = `SELECT r.id,r.reference,r.period_start periodStart,r.period_end periodEnd,r.status,r.total,
  u.name createdBy,a.name approvedBy,r.created_at createdAt,
  (SELECT COUNT(*) FROM payslips s WHERE s.run_id=r.id) employees
  FROM payroll_runs r JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.approved_by`;

router.get('/', auth, permit('hr.payroll'), wrap(async (_req, res) => res.json(await query(`${select} ORDER BY r.id DESC`))));

router.get('/:id', auth, permit('hr.payroll'), wrap(async (req, res) => {
  const run = await getOne(`${select} WHERE r.id=?`, [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  const payslips = await query(`SELECT s.id,s.days_present daysPresent,s.days_absent daysAbsent,s.overtime_hours overtimeHours,
    s.basic,s.overtime_pay overtimePay,s.deductions,s.net_pay netPay,e.name employee,e.code employeeCode,e.designation
    FROM payslips s JOIN employees e ON e.id=s.employee_id WHERE s.run_id=? ORDER BY e.code`, [run.id]);
  res.json({ ...run, payslips });
}));

/**
 * Builds a draft run for the period: days present come from attendance, overtime from
 * approved overtime records, and unpaid leave is deducted at the daily rate.
 */
router.post('/', auth, permit('hr.payroll'), validate(z.object({
  periodStart: isoDate,
  periodEnd: isoDate
})), wrap(async (req, res) => {
  const { periodStart, periodEnd } = req.body;
  if (periodEnd < periodStart) return res.status(400).json({ error: 'The period end must fall after its start' });

  const employees = await query(`SELECT e.id,e.name,e.basic_salary,e.daily_rate,e.overtime_rate,
      (SELECT COUNT(*) FROM attendance a WHERE (a.employee_id=e.id OR a.employee_name=e.name)
        AND a.work_date BETWEEN ? AND ? AND a.state IN ('On site','Late','Checked out')) days_present,
      (SELECT COUNT(*) FROM attendance a WHERE (a.employee_id=e.id OR a.employee_name=e.name)
        AND a.work_date BETWEEN ? AND ? AND a.state='Absent') days_absent,
      (SELECT COALESCE(SUM(o.hours),0) FROM overtime_records o WHERE o.employee_id=e.id
        AND o.work_date BETWEEN ? AND ? AND o.status='Approved') overtime_hours,
      (SELECT COALESCE(SUM(l.days),0) FROM leave_requests l WHERE l.employee_id=e.id AND l.status='Approved'
        AND l.leave_type='Unpaid' AND l.from_date BETWEEN ? AND ?) unpaid_days
    FROM employees e WHERE e.status <> 'Left' ORDER BY e.code`,
  [periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd]);

  const reference = await nextReference('PAY', 'payroll_runs');
  try {
    const runId = await transaction(async connection => {
      const [run] = await connection.execute(
        'INSERT INTO payroll_runs (reference,period_start,period_end,created_by) VALUES (?,?,?,?)',
        [reference, periodStart, periodEnd, req.user.id]);

      let total = 0;
      for (const employee of employees) {
        const basicSalary = Number(employee.basic_salary);
        const dailyRate = Number(employee.daily_rate);
        const overtimePay = Number(employee.overtime_hours) * Number(employee.overtime_rate);

        /*
         * GKUC pays two ways, and the run has to know which is which.
         *
         * Staff on a monthly salary are paid that salary, less a day's pay for each day of
         * unpaid leave. Site workers are on a daily rate and are paid for the days they
         * actually worked — there is nothing to deduct, because a day not worked was never
         * going to be paid. Earnings used to be the monthly salary in both cases, so every
         * mason and labourer on the books came out of the run with a payslip for nothing.
         */
        const earnings = basicSalary > 0 ? basicSalary : dailyRate * Number(employee.days_present);
        const deductions = basicSalary > 0 ? Number(employee.unpaid_days) * dailyRate : 0;
        const net = Math.max(0, earnings + overtimePay - deductions);
        total += net;
        await connection.execute(`INSERT INTO payslips
          (run_id,employee_id,days_present,days_absent,overtime_hours,basic,overtime_pay,deductions,net_pay)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        [run.insertId, employee.id, employee.days_present, employee.days_absent, employee.overtime_hours,
          earnings, overtimePay, deductions, net]);
      }
      await connection.execute('UPDATE payroll_runs SET total=? WHERE id=?', [total, run.insertId]);
      await audit(connection, req.user.id, 'CREATE', 'payroll_run', run.insertId, null, { reference, total }, req.ip);
      return run.insertId;
    });
    res.status(201).json(await getOne(`${select} WHERE r.id=?`, [runId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A payroll run already exists for that period' });
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

router.get('/reviews/all', auth, wrap(async (_req, res) => res.json(await query(`${reviewSelect} ORDER BY r.id DESC`))));

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
