import { Router } from 'express';
import { z } from 'zod';
import { audit, clock, getOne, pool, query, today } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const LATE_AFTER = process.env.ATTENDANCE_LATE_AFTER || '08:00:00';

const select = `SELECT a.id,a.employee_name name,a.role,COALESCE(p.name,'Head office') site,a.project_id projectId,a.work_location workLocation,a.check_in \`in\`,a.check_out \`out\`,
  a.state,a.work_date workDate,a.employee_id employeeId FROM attendance a LEFT JOIN projects p ON p.id=a.project_id`;

router.get('/', auth, permit('hr.view','site.attendance','hr.attendance'), wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  res.json(await query(`${select} WHERE a.work_date=? ORDER BY a.id`, [date]));
}));

const attended = state => ['On site', 'Late', 'Checked out', 'Business trip'].includes(state);
const dateShift = (iso, days) => {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const workdays = (from, to) => {
  let total = 0;
  for (let day = from; day <= to; day = dateShift(day, 1)) {
    if (new Date(`${day}T12:00:00`).getDay() !== 0) total += 1;
  }
  return total;
};
const percentage = (value, total) => total ? Math.round((value / total) * 100) : 0;

/** Workforce picture for the attendance dashboard, calculated from live records. */
router.get('/analytics', auth, permit('hr.view','site.attendance','hr.attendance'), wrap(async (_req, res) => {
  const end = today();
  const start = dateShift(end, -364);
  const [employees, records] = await Promise.all([
    query(`SELECT id,code,name,designation,join_date joinDate,status FROM employees
      WHERE status <> 'Left' ORDER BY name`),
    query(`SELECT employee_id employeeId,employee_name name,work_date workDate,state
      FROM attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date`, [start, end])
  ]);
  const active = employees.length;
  const dayRows = new Map();
  for (const record of records) {
    const day = String(record.workDate).slice(0, 10);
    if (!dayRows.has(day)) dayRows.set(day, []);
    dayRows.get(day).push(record);
  }
  const series = length => Array.from({ length }, (_, index) => dateShift(end, index - length + 1)).map(day => {
    const rows = dayRows.get(day) || [];
    const present = new Set(rows.filter(row => attended(row.state)).map(row => row.employeeId || row.name)).size;
    return { day, present, absent: Math.max(0, active - present), rate: percentage(present, active) };
  });
  const weekly = series(7);
  const monthly = series(30);
  const todayRow = monthly[monthly.length - 1];
  const scheduled = rows => rows.filter(row => new Date(`${row.day}T12:00:00`).getDay() !== 0);

  const people = employees.map(person => {
    const mine = records.filter(row => row.employeeId === person.id || (!row.employeeId && row.name === person.name));
    const personStart = String(person.joinDate).slice(0, 10) > start ? String(person.joinDate).slice(0, 10) : start;
    const expected = workdays(personStart, end);
    const present = new Set(mine.filter(row => attended(row.state)).map(row => String(row.workDate).slice(0, 10))).size;
    return { id: person.id, code: person.code, name: person.name, designation: person.designation,
      present, expected, rate: percentage(present, expected) };
  });
  const ranked = people.filter(person => person.expected >= 5).sort((a, b) => a.rate - b.rate);
  const middle = ranked.length ? ranked[Math.floor((ranked.length - 1) / 2)].rate : 0;
  const quartile = Math.ceil(ranked.length / 4);
  const lowAttendance = ranked.slice(0, quartile).filter(person => person.rate < middle);

  res.json({
    today: { ...todayRow, total: active },
    weekly: { rate: percentage(scheduled(weekly).reduce((sum, row) => sum + row.present, 0), active * scheduled(weekly).length), series: weekly },
    monthly: { rate: percentage(scheduled(monthly).reduce((sum, row) => sum + row.present, 0), active * scheduled(monthly).length), series: monthly },
    cohortMedian: middle,
    lowAttendance
  });
}));

router.post('/', auth, permit('site.attendance','hr.attendance'), validate(z.object({
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(100),
  projectId: z.number().int().positive().nullable().optional(),
  workLocation: z.enum(['Office', 'Site']).default('Site'),
  employeeId: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']).default('On site'),
  checkIn: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  checkOut: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional()
}).refine(value => value.workLocation !== 'Site' || Boolean(value.projectId), {
  message: 'Choose the site where this person worked', path: ['projectId']
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const checkIn = ['Absent', 'On leave', 'Business trip'].includes(body.state) ? null : (body.checkIn || clock());
    const checkOut = ['Absent', 'On leave', 'Business trip'].includes(body.state) ? null : (body.checkOut || null);
    const state = body.state === 'On site' && checkIn > LATE_AFTER ? 'Late' : body.state;
    const projectId = body.workLocation === 'Office' ? null : body.projectId;
    const result = await query(`INSERT INTO attendance (employee_name,role,project_id,work_location,employee_id,work_date,check_in,check_out,state,confirmed_by,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,'Manual')`, [body.name, body.role, projectId, body.workLocation, body.employeeId || null, body.date, checkIn, checkOut, state, req.user.id]);
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
router.patch('/:id', auth, permit('site.attendance','hr.attendance'), validate(z.object({
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']).optional(),
  checkIn: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  checkOut: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  projectId: z.number().int().positive().nullable().optional(),
  workLocation: z.enum(['Office', 'Site']).optional(),
  reason: z.string().min(3).max(500)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Attendance record not found' });
  const columns = { state: 'state', checkIn: 'check_in', checkOut: 'check_out', workDate: 'work_date', projectId: 'project_id', workLocation: 'work_location' };
  const body = { ...req.body };
  if (body.workLocation === 'Office') body.projectId = null;
  const changes = Object.entries(body).filter(([key]) => key !== 'reason');
  try {
    await query(`UPDATE attendance SET ${changes.map(([key]) => `${columns[key]}=?`).join(',')}${changes.length ? ',' : ''}
      correction_reason=?,confirmed_by=?,needs_review=0 WHERE id=?`,
    [...changes.map(([, value]) => value), req.body.reason, req.user.id, before.id]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Attendance already exists for that employee and date' });
    throw error;
  }
  const after = await getOne('SELECT * FROM attendance WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'CORRECTION', 'attendance', after.id, before, after, req.ip);
  res.json(after);
}));

export default router;
