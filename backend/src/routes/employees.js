import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, can, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { listAttachments } from './uploads.js';
import { OVERTIME_TYPES, PAY_BASES, PAY_FREQUENCIES, PAYROLL_CATEGORIES,
  payProfileError, resolveOvertimeRate } from '../lib/payroll-policy.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const employeeSchema = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(120),
  departmentId: z.number().int().positive().optional(),
  designation: z.string().min(2).max(120),
  workerType: z.enum(['Office', 'Site']).default('Site'),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  joinDate: isoDate,
  basicSalary: z.number().nonnegative().default(0),
  dailyRate: z.number().nonnegative().default(0),
  weeklyRate: z.number().nonnegative().default(0),
  overtimeRate: z.number().nonnegative().default(0),
  payBasis: z.enum(PAY_BASES).default('Monthly salary'),
  payFrequency: z.enum(PAY_FREQUENCIES).default('Monthly'),
  payrollCategory: z.enum(PAYROLL_CATEGORIES).default('Site labourer'),
  payrollCompanyId: z.number().int().positive().default(1),
  compensationEffectiveFrom: isoDate.optional(),
  epfEligible: z.boolean().default(false),
  etfEligible: z.boolean().default(false),
  customOfficeOtRate: z.number().nonnegative().nullable().optional(),
  customSiteOtRate: z.number().nonnegative().nullable().optional(),
  customTravelOtRate: z.number().nonnegative().nullable().optional(),
  status: z.enum(['Active', 'On leave', 'Suspended', 'Left']).default('Active'),
  notes: z.string().max(600).optional()
});

const listQuery = `SELECT e.id,e.code,e.name,e.designation,e.phone,e.email,e.status,e.join_date joinDate,
  e.basic_salary basicSalary,e.daily_rate dailyRate,e.weekly_rate weeklyRate,e.overtime_rate overtimeRate,
  e.pay_basis payBasis,e.pay_frequency payFrequency,e.payroll_category payrollCategory,
  e.payroll_company_id payrollCompanyId,
  e.compensation_effective_from compensationEffectiveFrom,e.epf_eligible epfEligible,e.etf_eligible etfEligible,
  e.custom_office_ot_rate customOfficeOtRate,e.custom_site_ot_rate customSiteOtRate,e.custom_travel_ot_rate customTravelOtRate,
  e.department_id departmentId,d.name department,
  e.notes,e.photo_url photoUrl,e.biometric_id biometricId,e.worker_type workerType,e.current_project_id currentProjectId,cp.name currentProject
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN projects cp ON cp.id=e.current_project_id`;

/*
 * What someone earns is not part of "view employee records".
 *
 * hr.view is held widely — a storekeeper or a site clerk needs to look up a phone number
 * or check who is on the books. Pay is a separate matter, and the permission list already
 * separates it: running payroll and maintaining the register are their own rights. So the
 * rates travel only to people who hold one of those, and everyone else gets the record
 * without them rather than a different, second endpoint to keep in step.
 */
const PAY_FIELDS = ['basicSalary', 'dailyRate', 'weeklyRate', 'overtimeRate', 'payBasis', 'payFrequency',
  'payrollCategory', 'payrollCompanyId', 'compensationEffectiveFrom', 'epfEligible', 'etfEligible',
  'customOfficeOtRate', 'customSiteOtRate', 'customTravelOtRate'];
const seesPay = req => ['hr.payroll', 'hr.manage'].some(key => req.user.permissions.includes(key));
const withoutPay = row => {
  const copy = { ...row };
  for (const field of PAY_FIELDS) delete copy[field];
  return copy;
};
const forViewer = (req, rows) => (seesPay(req) ? rows : (Array.isArray(rows) ? rows.map(withoutPay) : withoutPay(rows)));

/* Departments */
router.get('/departments', auth, permit('hr.view','hr.manage'), wrap(async (_req, res) => res.json(await query(`SELECT d.id,d.name,d.description,
  (SELECT COUNT(*) FROM employees e WHERE e.department_id=d.id) headcount FROM departments d ORDER BY d.name`))));

router.post('/departments', auth, permit('hr.manage'), validate(z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const result = await query('INSERT INTO departments (name,description) VALUES (?,?)', [req.body.name, req.body.description || null]);
  const row = await getOne('SELECT * FROM departments WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'department', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

/* Employees */
router.get('/', auth, permit('hr.view','hr.manage'), wrap(async (req, res) =>
  res.json(forViewer(req, await query(`${listQuery} ORDER BY e.code`)))));

/** Daily deployment plan, independent of scanner attendance and project-team membership. */
router.get('/work-locations', auth, permit('hr.view','hr.manage','hr.attendance','site.attendance','resources.view','resources.reassign','projects.schedule'), wrap(async (req, res) => {
  const from = isoDate.safeParse(req.query.from);
  const to = isoDate.safeParse(req.query.to);
  if (!from.success || !to.success || to.data < from.data)
    return res.status(400).json({ error: 'Choose a valid work-location date range.' });
  const rows = await query(`SELECT w.id,w.employee_id employeeId,w.work_date workDate,w.work_location workLocation,
    w.project_id projectId,p.name project,w.note,w.updated_at updatedAt
    FROM employee_work_locations w LEFT JOIN projects p ON p.id=w.project_id
    WHERE w.work_date BETWEEN ? AND ? ORDER BY w.work_date,w.employee_id`, [from.data, to.data]);
  res.json(rows);
}));

router.post('/work-locations', auth, permit('hr.manage','hr.attendance','resources.reassign','projects.schedule'), validate(z.object({
  employeeId: z.number().int().positive(),
  from: isoDate, to: isoDate,
  workLocation: z.enum(['Office','Site','Unassigned']),
  projectId: z.number().int().positive().nullable(),
  reason: z.string().trim().min(3).max(500)
})), wrap(async (req, res) => {
  const { employeeId, from, to, workLocation, projectId, reason } = req.body;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > 62)
    return res.status(400).json({ error: 'Choose a date range of no more than 62 days, with the end on or after the start.' });
  const employee = await getOne("SELECT id,name,worker_type workerType FROM employees WHERE id=? AND status <> 'Left'", [employeeId]);
  if (!employee) return res.status(404).json({ error: 'This active employee could not be found.' });
  if (workLocation === 'Office' && employee.workerType === 'Site')
    return res.status(400).json({ error: 'Site workers cannot be scheduled at the office. Change the employee type first if needed.' });
  if (workLocation === 'Site' && (!projectId || !await getOne('SELECT id FROM projects WHERE id=? AND active=1', [projectId])))
    return res.status(400).json({ error: 'Choose an active project site for these dates.' });
  if (workLocation !== 'Site' && projectId !== null)
    return res.status(400).json({ error: 'Only a project-site assignment can include a project.' });
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.parse(`${from}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
  await transaction(async connection => {
    const [before] = await connection.execute('SELECT * FROM employee_work_locations WHERE employee_id=? AND work_date BETWEEN ? AND ?', [employeeId, from, to]);
    for (const date of dates) {
      if (workLocation === 'Unassigned') await connection.execute('DELETE FROM employee_work_locations WHERE employee_id=? AND work_date=?', [employeeId, date]);
      else await connection.execute(`INSERT INTO employee_work_locations
        (employee_id,work_date,work_location,project_id,note,updated_by) VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE work_location=VALUES(work_location),project_id=VALUES(project_id),note=VALUES(note),updated_by=VALUES(updated_by)`,
      [employeeId, date, workLocation, projectId, reason, req.user.id]);
    }
    await audit(connection, req.user.id, 'WORK_LOCATION_PLAN', 'employee', employeeId, before,
      { from, to, workLocation, projectId, reason }, req.ip);
  });
  res.status(200).json({ employeeId, from, to, workLocation, projectId, days });
}));

/** A date-specific deployment board: leave wins over attendance, which wins over plans. */
router.get('/availability', auth, permit('hr.view','hr.manage','site.attendance','hr.attendance','resources.view','resources.reassign','projects.schedule'), wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toLocaleDateString('en-CA');
  const [employees, attendance, leave, assignments, locations] = await Promise.all([
    query(`SELECT e.id,e.code,e.name,e.designation,e.worker_type workerType,e.photo_url photoUrl,e.status employmentStatus,
      d.name department FROM employees e LEFT JOIN departments d ON d.id=e.department_id
      WHERE e.status <> 'Left' AND e.join_date<=? ORDER BY e.name`, [date]),
    query(`SELECT a.employee_id employeeId,a.employee_name employeeName,a.state,a.work_location workLocation,
      p.id projectId,p.name project FROM attendance a LEFT JOIN projects p ON p.id=a.project_id WHERE a.work_date=?`, [date]),
    query(`SELECT l.employee_id employeeId,l.leave_type leaveType FROM leave_requests l
      WHERE l.status='Approved' AND ? BETWEEN l.from_date AND l.to_date`, [date]),
    query(`SELECT pt.employee_id employeeId,p.id projectId,p.name project,pt.project_role projectRole
      FROM project_team pt JOIN projects p ON p.id=pt.project_id
      WHERE DATE(pt.assigned_at)<=? AND (pt.released_at IS NULL OR DATE(pt.released_at)>=?)
      ORDER BY pt.assigned_at DESC`, [date, date]),
    query(`SELECT w.employee_id employeeId,w.work_location workLocation,w.project_id projectId,p.name project
      FROM employee_work_locations w LEFT JOIN projects p ON p.id=w.project_id WHERE w.work_date=?`, [date])
  ]);
  const byAttendance = new Map(attendance.map(row => [row.employeeId || `name:${row.employeeName}`, row]));
  const byLeave = new Map(leave.map(row => [row.employeeId, row]));
  const byAssignment = new Map();
  for (const row of assignments) if (!byAssignment.has(row.employeeId)) byAssignment.set(row.employeeId, row);
  const byLocation = new Map(locations.map(row => [row.employeeId, row]));
  const people = employees.map(person => {
    const day = byAttendance.get(person.id) || byAttendance.get(`name:${person.name}`);
    const away = byLeave.get(person.id);
    const plan = byAssignment.get(person.id);
    const datedLocation = byLocation.get(person.id);
    let status = 'Free', group = 'free', location = 'Not assigned', projectId = null, available = true;
    if (person.employmentStatus === 'Suspended') { status = 'Not working'; group = 'not-working'; location = 'Suspended'; available = false; }
    else if (away) { status = 'On leave'; group = 'leave'; location = away.leaveType; available = false; }
    else if (day?.state === 'Absent') { status = 'Not working'; group = 'not-working'; location = 'Absent'; available = false; }
    else if (day?.state === 'On leave') { status = 'On leave'; group = 'leave'; location = 'On leave'; available = false; }
    else if (day?.workLocation === 'Not working') { status = 'Not working'; group = 'not-working'; location = day.state || 'Not working'; available = false; }
    else if (day?.state === 'Business trip') { status = 'Business trip'; group = 'business-trip'; location = day.project || 'Away'; projectId = day.projectId; available = false; }
    else if (day?.workLocation === 'Office') { status = 'At office'; group = 'office'; location = 'Head office'; available = false; }
    else if (day) { status = 'At site'; group = 'site'; location = day.project || 'Site'; projectId = day.projectId; available = false; }
    else if (datedLocation?.workLocation === 'Office') { status = 'Scheduled at office'; group = 'office'; location = 'Head office'; available = false; }
    else if (datedLocation) { status = 'Scheduled at site'; group = 'site'; location = datedLocation.project || 'Site'; projectId = datedLocation.projectId; available = false; }
    else if (plan) { status = 'Scheduled at site'; group = 'site'; location = plan.project; projectId = plan.projectId; available = false; }
    else if (person.workerType === 'Office') { status = 'Expected at office'; group = 'office'; location = 'Head office'; available = false; }
    return { ...person, status, group, location, projectId, available };
  });
  const count = key => people.filter(person => person.group === key).length;
  const sites = [...people.filter(person => person.group === 'site').reduce((map, person) => {
    const current = map.get(person.location) || { name: person.location, people: 0 };
    current.people += 1; map.set(person.location, current); return map;
  }, new Map()).values()].sort((a, b) => b.people - a.people);
  res.json({ date, summary: { total: people.length, site: count('site'), office: count('office'), free: count('free'), leave: count('leave'), notWorking: count('not-working') }, sites, people });
}));

router.get('/:id', auth, permit('hr.view','hr.manage'), wrap(async (req, res) => {
  const found = await getOne(`${listQuery} WHERE e.id=?`, [req.params.id]);
  if (!found) return res.status(404).json({ error: 'Employee not found' });
  const employee = forViewer(req, found);
  const [leave, overtime, documents, attendance, projects, tasks, reports, reviews, biometricIds] = await Promise.all([
    query('SELECT id,leave_type leaveType,from_date fromDate,to_date toDate,days,reason,status FROM leave_requests WHERE employee_id=? ORDER BY id DESC', [employee.id]),
    query(`SELECT o.id,o.work_date workDate,o.overtime_type overtimeType,o.hours,o.rate,o.status,p.name project FROM overtime_records o
      LEFT JOIN projects p ON p.id=o.project_id WHERE o.employee_id=? ORDER BY o.id DESC`, [employee.id]),
    listAttachments('employee', employee.id),
    query(`SELECT a.id,a.work_date workDate,a.check_in \`in\`,a.check_out \`out\`,a.state,a.source,a.work_location workLocation,a.needs_review needsReview,
      a.correction_reason correctionReason,CASE WHEN a.work_location='Not working' THEN 'Not working' ELSE COALESCE(p.name,'Head office') END site,p.id projectId FROM attendance a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.employee_id=? OR a.employee_name=? ORDER BY a.work_date DESC LIMIT 1500`, [employee.id, employee.name]),
    query(`SELECT 'Project manager' projectRole,a.assigned_at assignedAt,a.released_at releasedAt,
      p.id projectId,p.name project
      FROM project_manager_assignments a JOIN projects p ON p.id=a.project_id WHERE a.employee_id=?
      UNION ALL
      SELECT t.project_role projectRole,t.assigned_at assignedAt,t.released_at releasedAt,p.id projectId,p.name project
      FROM project_team t JOIN projects p ON p.id=t.project_id
      WHERE t.employee_id=? AND (p.manager_employee_id IS NULL OR p.manager_employee_id<>?)
      ORDER BY assignedAt DESC`, [employee.id, employee.id, employee.id]),
    query(`SELECT t.id,t.title,t.status,t.priority,t.due_date dueDate,t.updated_at updatedAt,p.id projectId,p.name project
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.employee_id=?)
        OR t.assignee_employee_id=? OR (t.assignee_employee_id IS NULL AND LOWER(t.assignee)=LOWER(?)
        AND (SELECT COUNT(*) FROM employees WHERE LOWER(name)=LOWER(?))=1)
      ORDER BY t.updated_at DESC`, [employee.id, employee.id, employee.name, employee.name]),
    query(`SELECT r.id,r.report_date reportDate,r.work_completed work,r.issue,r.workforce,p.id projectId,p.name project
      FROM daily_reports r JOIN projects p ON p.id=r.project_id WHERE LOWER(r.supervisor)=LOWER(?)
      AND (SELECT COUNT(*) FROM employees WHERE LOWER(name)=LOWER(?))=1
      ORDER BY r.report_date DESC LIMIT 1500`, [employee.name, employee.name]),
    (can(req, 'hr.payroll') || can(req, 'hr.manage'))
      ? query(`SELECT r.id,r.review_date reviewDate,r.period,r.quality,r.productivity,r.safety,r.reliability,r.overall,
          r.strengths,r.improvements,u.name reviewer FROM performance_reviews r JOIN users u ON u.id=r.reviewer_id
          WHERE r.employee_id=? ORDER BY r.review_date`, [employee.id])
      : Promise.resolve([]),
    query('SELECT code FROM employee_biometric_ids WHERE employee_id=? ORDER BY code', [employee.id])
  ]);
  const presentStates = new Set(['On site', 'Late', 'Checked out', 'Business trip']);
  const monthMap = new Map();
  for (const row of attendance) {
    const month = String(row.workDate).slice(0, 7);
    const item = monthMap.get(month) || { month, present: 0, absent: 0, leave: 0, late: 0, total: 0 };
    item.total += 1;
    if (presentStates.has(row.state)) item.present += 1;
    if (row.state === 'Absent') item.absent += 1;
    if (row.state === 'On leave') item.leave += 1;
    if (row.state === 'Late') item.late += 1;
    monthMap.set(month, item);
  }
  const monthlyTrend = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map(item => ({
    ...item, rate: item.present + item.absent ? Math.round(item.present / (item.present + item.absent) * 100) : 0
  }));
  const attendanceStats = attendance.reduce((stats, row) => {
    stats.total += 1;
    if (presentStates.has(row.state)) stats.present += 1;
    if (row.state === 'Absent') stats.absent += 1;
    if (row.state === 'Late') stats.late += 1;
    if (row.needsReview) stats.needsReview += 1;
    return stats;
  }, { total: 0, present: 0, absent: 0, late: 0, needsReview: 0 });
  attendanceStats.rate = attendanceStats.present + attendanceStats.absent
    ? Math.round(attendanceStats.present / (attendanceStats.present + attendanceStats.absent) * 100) : 0;
  const completedTasks = tasks.filter(task => ['Completed', 'Approved'].includes(task.status)).length;
  const projectWork = new Map(projects.map(project => [project.projectId, { ...project, tasks: 0, completedTasks: 0, reports: 0, attendanceDays: 0 }]));
  const recordWork = (projectId, project, date) => {
    if (!projectId) return null;
    if (!projectWork.has(projectId)) projectWork.set(projectId, {
      projectId, project, projectRole: 'Work recorded', assignedAt: date, releasedAt: null,
      tasks: 0, completedTasks: 0, reports: 0, attendanceDays: 0
    });
    return projectWork.get(projectId);
  };
  for (const task of tasks) {
    const work = recordWork(task.projectId, task.project, task.updatedAt);
    if (work) { work.tasks += 1; if (['Completed', 'Approved'].includes(task.status)) work.completedTasks += 1; }
  }
  for (const report of reports) { const work = recordWork(report.projectId, report.project, report.reportDate); if (work) work.reports += 1; }
  for (const day of attendance) {
    if (!presentStates.has(day.state)) continue;
    const work = recordWork(day.projectId, day.site, day.workDate);
    if (work) work.attendanceDays += 1;
  }
  const averagePerformance = reviews.length
    ? Number((reviews.reduce((sum, review) => sum + Number(review.overall), 0) / reviews.length).toFixed(1)) : null;
  res.json({ ...employee, biometricIds: biometricIds.map(row => row.code), leave, overtime, documents, attendance,
    projects: [...projectWork.values()], tasks, reports, reviews, monthlyTrend,
    attendanceStats, workStats: { tasks: tasks.length, completedTasks, reports: reports.length, averagePerformance } });
}));

router.post('/', auth, permit('hr.manage'), validate(employeeSchema), wrap(async (req, res) => {
  const body = req.body;
  const profileError = payProfileError(body);
  if (profileError) return res.status(400).json({ error: profileError });
  try {
    const result = await query(`INSERT INTO employees
      (code,name,department_id,designation,worker_type,phone,email,join_date,basic_salary,daily_rate,weekly_rate,overtime_rate,
       pay_basis,pay_frequency,payroll_category,payroll_company_id,compensation_effective_from,epf_eligible,etf_eligible,
       custom_office_ot_rate,custom_site_ot_rate,custom_travel_ot_rate,status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [body.code, body.name, body.departmentId || null, body.designation, body.workerType, body.phone || null,
      body.email || null, body.joinDate, body.basicSalary, body.dailyRate, body.weeklyRate, body.overtimeRate,
      body.payBasis, body.payFrequency, body.payrollCategory, body.payrollCompanyId, body.compensationEffectiveFrom || body.joinDate,
      body.epfEligible, body.etfEligible, body.customOfficeOtRate ?? null, body.customSiteOtRate ?? null,
      body.customTravelOtRate ?? null, body.status, body.notes || null]);
    const row = await getOne(`${listQuery} WHERE e.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'employee', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That employee code is already in use' });
    throw error;
  }
}));

router.patch('/:id', auth, permit('hr.manage'), validate(employeeSchema.partial()), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM employees WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Employee not found' });
  const profileError = payProfileError({
    payBasis: req.body.payBasis ?? before.pay_basis,
    payFrequency: req.body.payFrequency ?? before.pay_frequency
  });
  if (profileError) return res.status(400).json({ error: profileError });
  const columns = {
    departmentId: 'department_id', joinDate: 'join_date', basicSalary: 'basic_salary',
    dailyRate: 'daily_rate', weeklyRate: 'weekly_rate', overtimeRate: 'overtime_rate', workerType: 'worker_type',
    payBasis: 'pay_basis', payFrequency: 'pay_frequency', payrollCategory: 'payroll_category', payrollCompanyId: 'payroll_company_id',
    compensationEffectiveFrom: 'compensation_effective_from', epfEligible: 'epf_eligible', etfEligible: 'etf_eligible',
    customOfficeOtRate: 'custom_office_ot_rate', customSiteOtRate: 'custom_site_ot_rate', customTravelOtRate: 'custom_travel_ot_rate'
  };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE employees SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), req.params.id]);
  }
  const after = await getOne(`${listQuery} WHERE e.id=?`, [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee', after.id, before, after, req.ip);
  res.json(after);
}));

/* Leave management */
router.get('/leave/all', auth, permit('hr.view','hr.leave'), wrap(async (_req, res) => res.json(await query(`SELECT l.id,l.leave_type leaveType,l.from_date fromDate,
  l.to_date toDate,l.days,l.reason,l.status,l.created_at createdAt,e.name employee,e.code employeeCode,e.id employeeId
  FROM leave_requests l JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC`))));

router.post('/:id/leave', auth, permit('hr.manage', 'hr.leave'), validate(z.object({
  leaveType: z.string().trim().min(1).max(60),
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().min(3).max(600)
}).refine(value => value.toDate >= value.fromDate, {
  message: 'Leave cannot end before it starts', path: ['toDate']
})), fromOptions({ leaveType: 'leave.type' }), wrap(async (req, res) => {
  const body = req.body;
  const days = Math.max(1, Math.round((new Date(body.toDate) - new Date(body.fromDate)) / 86400000) + 1);
  const result = await query('INSERT INTO leave_requests (employee_id,leave_type,from_date,to_date,days,reason) VALUES (?,?,?,?,?,?)',
    [req.params.id, body.leaveType, body.fromDate, body.toDate, days, body.reason]);
  const row = await getOne('SELECT * FROM leave_requests WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'leave_request', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/leave/:id', auth, permit('hr.manage', 'hr.leave'), validate(z.object({ status: z.enum(['Pending', 'Approved', 'Rejected']) })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM leave_requests WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Leave request not found' });
  await query('UPDATE leave_requests SET status=?,decided_by=?,decided_at=NOW() WHERE id=?', [req.body.status, req.user.id, req.params.id]);
  if (req.body.status === 'Approved') await query("UPDATE employees SET status='On leave' WHERE id=?", [before.employee_id]);
  const after = await getOne('SELECT * FROM leave_requests WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'leave_request', after.id, before, after, req.ip);
  res.json(after);
}));

/* Overtime */
router.get('/overtime/all', auth, permit('hr.view','hr.leave'), wrap(async (_req, res) => res.json(await query(`SELECT o.id,o.work_date workDate,o.hours,o.rate,o.status,
  o.overtime_type overtimeType,e.name employee,e.code employeeCode,p.name project FROM overtime_records o JOIN employees e ON e.id=o.employee_id
  LEFT JOIN projects p ON p.id=o.project_id ORDER BY o.id DESC`))));

router.post('/:id/overtime', auth, permit('site.attendance', 'hr.leave', 'hr.manage'), validate(z.object({
  projectId: z.number().int().positive().optional(),
  workDate: isoDate,
  hours: z.number().positive().max(24),
  overtimeType: z.enum(OVERTIME_TYPES).default('Site')
})), wrap(async (req, res) => {
  const employee = await getOne('SELECT * FROM employees WHERE id=?', [req.params.id]);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const policy = await getOne(`SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=?
    ORDER BY effective_from DESC,id DESC LIMIT 1`, [employee.payroll_company_id, req.body.workDate]);
  if (!policy) return res.status(409).json({ error: 'Configure an overtime policy for this date first' });
  let rate;
  try { rate = resolveOvertimeRate(employee, req.body.overtimeType, policy); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const result = await query(`INSERT INTO overtime_records
    (employee_id,project_id,work_date,overtime_type,hours,rate,policy_id) VALUES (?,?,?,?,?,?,?)`,
  [employee.id, req.body.projectId || null, req.body.workDate, req.body.overtimeType, req.body.hours, rate, policy.id]);
  const row = await getOne('SELECT * FROM overtime_records WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'overtime', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/overtime/:id', auth, permit('hr.manage', 'hr.leave'), validate(z.object({ status: z.enum(['Pending', 'Approved', 'Rejected']) })), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM overtime_records WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Overtime record not found' });
  await query('UPDATE overtime_records SET status=?,approved_by=? WHERE id=?', [req.body.status, req.user.id, req.params.id]);
  const after = await getOne('SELECT * FROM overtime_records WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'overtime', after.id, before, after, req.ip);
  res.json(after);
}));


export default router;
