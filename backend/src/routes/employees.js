import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { listAttachments } from './uploads.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const employeeSchema = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(120),
  departmentId: z.number().int().positive().optional(),
  designation: z.string().min(2).max(120),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  joinDate: isoDate,
  basicSalary: z.number().nonnegative().default(0),
  dailyRate: z.number().nonnegative().default(0),
  overtimeRate: z.number().nonnegative().default(0),
  status: z.enum(['Active', 'On leave', 'Suspended', 'Left']).default('Active'),
  notes: z.string().max(600).optional()
});

const listQuery = `SELECT e.id,e.code,e.name,e.designation,e.phone,e.email,e.status,e.join_date joinDate,
  e.basic_salary basicSalary,e.daily_rate dailyRate,e.overtime_rate overtimeRate,e.department_id departmentId,d.name department
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id`;

/*
 * What someone earns is not part of "view employee records".
 *
 * hr.view is held widely — a storekeeper or a site clerk needs to look up a phone number
 * or check who is on the books. Pay is a separate matter, and the permission list already
 * separates it: running payroll and maintaining the register are their own rights. So the
 * rates travel only to people who hold one of those, and everyone else gets the record
 * without them rather than a different, second endpoint to keep in step.
 */
const PAY_FIELDS = ['basicSalary', 'dailyRate', 'overtimeRate'];
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

router.get('/:id', auth, permit('hr.view','hr.manage'), wrap(async (req, res) => {
  const found = await getOne(`${listQuery} WHERE e.id=?`, [req.params.id]);
  if (!found) return res.status(404).json({ error: 'Employee not found' });
  const employee = forViewer(req, found);
  const [leave, overtime, documents, attendance, projects] = await Promise.all([
    query('SELECT id,leave_type leaveType,from_date fromDate,to_date toDate,days,reason,status FROM leave_requests WHERE employee_id=? ORDER BY id DESC', [employee.id]),
    query(`SELECT o.id,o.work_date workDate,o.hours,o.rate,o.status,p.name project FROM overtime_records o
      LEFT JOIN projects p ON p.id=o.project_id WHERE o.employee_id=? ORDER BY o.id DESC`, [employee.id]),
    listAttachments('employee', employee.id),
    query(`SELECT a.id,a.work_date workDate,a.check_in \`in\`,a.check_out \`out\`,a.state,p.name site FROM attendance a
      JOIN projects p ON p.id=a.project_id WHERE a.employee_id=? OR a.employee_name=? ORDER BY a.work_date DESC LIMIT 30`, [employee.id, employee.name]),
    query(`SELECT t.project_role projectRole,p.name project FROM project_team t JOIN projects p ON p.id=t.project_id
      WHERE t.employee_id=? AND t.released_at IS NULL`, [employee.id])
  ]);
  res.json({ ...employee, leave, overtime, documents, attendance, projects });
}));

router.post('/', auth, permit('hr.manage'), validate(employeeSchema), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query(`INSERT INTO employees (code,name,department_id,designation,phone,email,join_date,basic_salary,daily_rate,overtime_rate,status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [body.code, body.name, body.departmentId || null, body.designation, body.phone || null,
      body.email || null, body.joinDate, body.basicSalary, body.dailyRate, body.overtimeRate, body.status, body.notes || null]);
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
  const columns = {
    departmentId: 'department_id', joinDate: 'join_date', basicSalary: 'basic_salary',
    dailyRate: 'daily_rate', overtimeRate: 'overtime_rate'
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
  leaveType: z.enum(['Annual', 'Casual', 'Medical', 'Unpaid', 'Other']),
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().min(3).max(600)
}).refine(value => value.toDate >= value.fromDate, {
  message: 'Leave cannot end before it starts', path: ['toDate']
})), wrap(async (req, res) => {
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
  e.name employee,e.code employeeCode,p.name project FROM overtime_records o JOIN employees e ON e.id=o.employee_id
  LEFT JOIN projects p ON p.id=o.project_id ORDER BY o.id DESC`))));

router.post('/:id/overtime', auth, permit('site.attendance', 'hr.leave', 'hr.manage'), validate(z.object({
  projectId: z.number().int().positive().optional(),
  workDate: isoDate,
  hours: z.number().positive().max(24)
})), wrap(async (req, res) => {
  const employee = await getOne('SELECT * FROM employees WHERE id=?', [req.params.id]);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const result = await query('INSERT INTO overtime_records (employee_id,project_id,work_date,hours,rate) VALUES (?,?,?,?,?)',
    [employee.id, req.body.projectId || null, req.body.workDate, req.body.hours, employee.overtime_rate]);
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
