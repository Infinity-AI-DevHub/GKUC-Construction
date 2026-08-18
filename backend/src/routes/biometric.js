import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { parseBiometricFile } from '../lib/biometric.js';
import { readUpload } from '../lib/storage.js';

const router = Router();
const LATE_AFTER = process.env.ATTENDANCE_LATE_AFTER || '08:00:00';

/**
 * PID v3 §1.2 and problem 9 — the pendrive export is uploaded here, and from that point
 * salary, overtime and leave all read the same attendance record. Nothing about how the
 * workers clock in changes.
 *
 * The upload is a two-step: parse and preview first, commit second. A biometric file is
 * the payroll input, so somebody should see what it contains before it lands.
 */

/**
 * Matches a device row to an employee: by the terminal's enrolment number first, since that
 * is the only identifier the device is sure about, then by GKUC's employee code, then by
 * name. A name is the weakest of the three — the terminal holds first names only — so it is
 * the last resort rather than the first.
 */
async function resolveEmployees(rows) {
  const employees = await query("SELECT id,code,name,biometric_id biometricId FROM employees WHERE status <> 'Left'");
  const key = value => String(value ?? '').trim().toLowerCase();
  const byDevice = new Map(employees.filter(item => item.biometricId).map(item => [key(item.biometricId), item]));
  const byCode = new Map(employees.map(item => [key(item.code), item]));
  const byName = new Map(employees.map(item => [key(item.name), item]));

  return rows.map(row => {
    const match = (row.code && byDevice.get(key(row.code)))
      || (row.code && byCode.get(key(row.code)))
      || (row.name && byName.get(key(row.name)))
      || null;
    return { ...row, employeeId: match?.id || null, employee: match?.name || null };
  });
}

/*
 * Any punch at all means the person was on site that day — the terminal counts a day as
 * attended on a single punch, and so should this. Reading a lone evening punch as an
 * absence would mark somebody away on a day they plainly worked, and payroll follows this.
 */
const stateFor = row => {
  if (!row.checkIn && !row.checkOut) return 'Absent';
  if (row.checkOut) return 'Checked out';
  return row.checkIn > LATE_AFTER ? 'Late' : 'On site';
};

/**
 * Parses the uploaded file and reports what it found without writing anything, so the
 * unmatched names and unreadable rows can be dealt with before the data lands.
 */
router.post('/preview', auth, permit('hr.attendance'), wrap(async (req, res) => {
  const { file } = await readUpload(req);
  const parsed = parseBiometricFile(file);
  if (!parsed.rows.length) {
    return res.status(422).json({
      error: 'Nothing could be read from that file',
      problems: parsed.problems,
      columns: parsed.columns
    });
  }

  const resolved = await resolveEmployees(parsed.rows);
  const dates = resolved.map(row => row.date).sort();
  const existing = await query(
    'SELECT employee_id employeeId,employee_name name,work_date workDate FROM attendance WHERE work_date BETWEEN ? AND ?',
    [dates[0], dates[dates.length - 1]]);
  const alreadyHave = new Set(existing.map(row => `${row.employeeId || row.name}|${String(row.workDate).slice(0, 10)}`));

  const rows = resolved.map(row => ({
    ...row,
    state: stateFor(row),
    duplicate: alreadyHave.has(`${row.employeeId || row.name}|${row.date}`)
  }));

  /* One line per unrecognised device number, so the mapping is offered once rather than
     once per day that person worked. */
  const unknown = new Map();
  for (const row of rows) {
    if (row.employeeId || !row.code) continue;
    const entry = unknown.get(row.code)
      || { code: row.code, name: row.name || '', department: row.department || '', days: 0 };
    entry.days += 1;
    unknown.set(row.code, entry);
  }

  res.json({
    filename: file.filename,
    columns: parsed.columns,
    problems: parsed.problems,
    from: dates[0],
    to: dates[dates.length - 1],
    period: parsed.period || null,
    source: parsed.source || null,
    unknownDevices: [...unknown.values()],
    summary: {
      rows: rows.length,
      matched: rows.filter(row => row.employeeId).length,
      unmatched: rows.filter(row => !row.employeeId).length,
      duplicates: rows.filter(row => row.duplicate).length,
      absent: rows.filter(row => row.state === 'Absent').length,
      late: rows.filter(row => row.state === 'Late').length,
      needsReview: rows.filter(row => row.needsReview).length
    },
    rows
  });
}));

/**
 * Commits reviewed rows. Existing days are updated rather than duplicated, so re-uploading
 * an overlapping export is safe — a pendrive is usually copied in full each time.
 */
router.post('/commit', auth, permit('hr.attendance'), validate(z.object({
  projectId: z.number().int().positive(),
  filename: z.string().max(200).optional(),
  rows: z.array(z.object({
    employeeId: z.number().int().positive().nullable().optional(),
    code: z.string().max(40).nullable().optional(),
    name: z.string().max(120).nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkIn: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable().optional(),
    checkOut: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable().optional(),
    needsReview: z.boolean().optional()
  })).min(1).max(5000)
})), wrap(async (req, res) => {
  const project = await getOne('SELECT id,name FROM projects WHERE id=?', [req.body.projectId]);
  if (!project) return res.status(404).json({ error: 'Site not found' });

  const resolved = await resolveEmployees(req.body.rows);
  const skipped = [];
  let inserted = 0;
  let updated = 0;

  await transaction(async connection => {
    for (const row of resolved) {
      const employeeId = row.employeeId || null;
      const name = row.employee || row.name || row.code;
      if (!name) { skipped.push({ ...row, why: 'No employee could be identified' }); continue; }

      const state = stateFor(row);
      const [existing] = await connection.execute(
        'SELECT id FROM attendance WHERE employee_name=? AND work_date=?', [name, row.date]);

      if (existing[0]) {
        await connection.execute(
          `UPDATE attendance SET check_in=?,check_out=?,state=?,employee_id=COALESCE(?,employee_id),
             needs_review=?,source='Biometric',confirmed_by=? WHERE id=?`,
          [row.checkIn || null, row.checkOut || null, state, employeeId,
            row.needsReview ? 1 : 0, req.user.id, existing[0].id]);
        updated += 1;
      } else {
        const [employee] = employeeId
          ? await connection.execute('SELECT designation FROM employees WHERE id=?', [employeeId])
          : [[]];
        await connection.execute(
          `INSERT INTO attendance (employee_name,role,project_id,employee_id,work_date,check_in,check_out,state,
             needs_review,source,confirmed_by)
           VALUES (?,?,?,?,?,?,?,?,?,'Biometric',?)`,
          [name, employee[0]?.designation || 'Worker', project.id, employeeId, row.date,
            row.checkIn || null, row.checkOut || null, state, row.needsReview ? 1 : 0, req.user.id]);
        inserted += 1;
      }
    }
    await audit(connection, req.user.id, 'IMPORT', 'attendance', project.id, null,
      { filename: req.body.filename || null, inserted, updated, skipped: skipped.length }, req.ip);
  });

  res.status(201).json({ site: project.name, inserted, updated, skipped });
}));

/**
 * Ties a terminal enrolment number to an employee. Done once per person: every future
 * export recognises them without anyone matching names by hand again.
 */
router.post('/mappings', auth, permit('hr.attendance'), validate(z.object({
  code: z.string().min(1).max(40),
  employeeId: z.number().int().positive()
})), wrap(async (req, res) => {
  const employee = await getOne('SELECT id,name,code FROM employees WHERE id=?', [req.body.employeeId]);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const taken = await getOne('SELECT id,name FROM employees WHERE biometric_id=? AND id<>?',
    [req.body.code, employee.id]);
  if (taken) return res.status(409).json({ error: `Device number ${req.body.code} is already ${taken.name}'s` });

  await query('UPDATE employees SET biometric_id=? WHERE id=?', [req.body.code, employee.id]);
  await audit(pool, req.user.id, 'UPDATE', 'employee', employee.id, null,
    { biometricId: req.body.code }, req.ip);
  res.json({ employeeId: employee.id, name: employee.name, code: req.body.code });
}));

/** What has been imported, so a gap in the record is visible. */
router.get('/history', auth, permit('hr.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT a.id,a.created_at createdAt,u.name importedBy,a.after_json detail
    FROM audit_logs a JOIN users u ON u.id=a.user_id
    WHERE a.action='IMPORT' AND a.entity='attendance' ORDER BY a.id DESC LIMIT 50`))));

export default router;
