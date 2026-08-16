import { Router } from 'express';
import { z } from 'zod';
import { audit, clock, getOne, pool, query, today } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const LATE_AFTER = process.env.ATTENDANCE_LATE_AFTER || '08:00:00';

const select = `SELECT a.id,a.employee_name name,a.role,p.name site,a.project_id projectId,a.check_in \`in\`,a.check_out \`out\`,
  a.state,a.work_date workDate,a.employee_id employeeId FROM attendance a JOIN projects p ON p.id=a.project_id`;

router.get('/', auth, permit('hr.view','site.attendance','hr.attendance'), wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  res.json(await query(`${select} WHERE a.work_date=? ORDER BY a.id`, [date]));
}));

router.post('/', auth, permit('site.attendance'), validate(z.object({
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(100),
  projectId: z.number().int().positive(),
  employeeId: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave']).default('On site')
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const checkIn = ['Absent', 'On leave'].includes(body.state) ? null : clock();
    const state = body.state === 'On site' && checkIn > LATE_AFTER ? 'Late' : body.state;
    const result = await query(`INSERT INTO attendance (employee_name,role,project_id,employee_id,work_date,check_in,state,confirmed_by)
      VALUES (?,?,?,?,?,?,?,?)`, [body.name, body.role, body.projectId, body.employeeId || null, body.date, checkIn, state, req.user.id]);
    const row = await getOne(`${select} WHERE a.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'attendance', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Attendance already exists for this employee and date' });
    throw error;
  }
}));

/** One button that checks a worker in, then out — supervisors do not have to pick the action. */
router.post('/:id/toggle', auth, permit('site.attendance'), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Attendance record not found' });
  const now = clock();
  if (before.check_in && !before.check_out) {
    await query("UPDATE attendance SET check_out=?,state='Checked out',confirmed_by=? WHERE id=?", [now, req.user.id, before.id]);
  } else {
    const state = now > LATE_AFTER ? 'Late' : 'On site';
    await query('UPDATE attendance SET check_in=?,check_out=NULL,state=?,confirmed_by=? WHERE id=?', [now, state, req.user.id, before.id]);
  }
  const after = await getOne('SELECT * FROM attendance WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'attendance', after.id, before, after, req.ip);
  res.json(after);
}));

/** Corrections are allowed but always carry a reason and land in the audit log. */
router.patch('/:id', auth, permit('site.attendance'), validate(z.object({
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave']).optional(),
  checkIn: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  checkOut: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  reason: z.string().min(3).max(500)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Attendance record not found' });
  await query('UPDATE attendance SET state=COALESCE(?,state),check_in=COALESCE(?,check_in),check_out=COALESCE(?,check_out),correction_reason=?,confirmed_by=? WHERE id=?',
    [req.body.state || null, req.body.checkIn || null, req.body.checkOut || null, req.body.reason, req.user.id, before.id]);
  const after = await getOne('SELECT * FROM attendance WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'CORRECTION', 'attendance', after.id, before, after, req.ip);
  res.json(after);
}));

export default router;
