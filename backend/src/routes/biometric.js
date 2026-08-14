import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { parseBiometricExport } from '../lib/biometric.js';
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

/** Matches a device row to an employee by code first, then by name. */
async function resolveEmployees(rows) {
  const employees = await query("SELECT id,code,name FROM employees WHERE status <> 'Left'");
  const byCode = new Map(employees.map(item => [String(item.code).toLowerCase(), item]));
  const byName = new Map(employees.map(item => [item.name.toLowerCase(), item]));
  return rows.map(row => {
    const match = (row.code && byCode.get(String(row.code).toLowerCase()))
      || (row.name && byName.get(String(row.name).toLowerCase()))
      || null;
    return { ...row, employeeId: match?.id || null, employee: match?.name || null };
  });
}

const stateFor = row => {
  if (!row.checkIn) return 'Absent';
  if (row.checkOut) return 'Checked out';
  return row.checkIn > LATE_AFTER ? 'Late' : 'On site';
};

/**
 * Parses the uploaded file and reports what it found without writing anything, so the
 * unmatched names and unreadable rows can be dealt with before the data lands.
 */
router.post('/preview', auth, permit('hr.attendance'), wrap(async (req, res) => {
  const { file } = await readUpload(req);
  const parsed = parseBiometricExport(file.buffer.toString('utf8'));
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

  res.json({
    filename: file.filename,
    columns: parsed.columns,
    problems: parsed.problems,
    from: dates[0],
    to: dates[dates.length - 1],
    summary: {
      rows: rows.length,
      matched: rows.filter(row => row.employeeId).length,
      unmatched: rows.filter(row => !row.employeeId).length,
      duplicates: rows.filter(row => row.duplicate).length,
      absent: rows.filter(row => row.state === 'Absent').length,
      late: rows.filter(row => row.state === 'Late').length
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
    checkOut: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable().optional()
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
          `UPDATE attendance SET check_in=?,check_out=?,state=?,employee_id=COALESCE(?,employee_id),confirmed_by=? WHERE id=?`,
          [row.checkIn || null, row.checkOut || null, state, employeeId, req.user.id, existing[0].id]);
        updated += 1;
      } else {
        const [employee] = employeeId
          ? await connection.execute('SELECT designation FROM employees WHERE id=?', [employeeId])
          : [[]];
        await connection.execute(
          `INSERT INTO attendance (employee_name,role,project_id,employee_id,work_date,check_in,check_out,state,confirmed_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [name, employee[0]?.designation || 'Worker', project.id, employeeId, row.date,
            row.checkIn || null, row.checkOut || null, state, req.user.id]);
        inserted += 1;
      }
    }
    await audit(connection, req.user.id, 'IMPORT', 'attendance', project.id, null,
      { filename: req.body.filename || null, inserted, updated, skipped: skipped.length }, req.ip);
  });

  res.status(201).json({ site: project.name, inserted, updated, skipped });
}));

/** What has been imported, so a gap in the record is visible. */
router.get('/history', auth, permit('hr.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT a.id,a.created_at createdAt,u.name importedBy,a.after_json detail
    FROM audit_logs a JOIN users u ON u.id=a.user_id
    WHERE a.action='IMPORT' AND a.entity='attendance' ORDER BY a.id DESC LIMIT 50`))));

export default router;
