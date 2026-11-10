import {inferSiteStop,siteStopProblem,usesSiteTravelPunches} from '../lib/site-travel-ot.js';
import {registerBiometricCorrections} from '../lib/biometric-correction.js';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { parseBiometricFile } from '../lib/biometric.js';
import { resolveScannerRows } from '../lib/biometric-identities.js';
import { readUpload, readUploadedFile } from '../lib/storage.js';

const router = Router();
registerBiometricCorrections(router);
const LATE_AFTER = process.env.ATTENDANCE_LATE_AFTER || '08:00:00';

/**
 * PID v3 §1.2 and problem 9 — the pendrive export is uploaded here, and from that point
 * salary, overtime and leave all read the same attendance record. Nothing about how the
 * workers clock in changes.
 *
 * The upload is a two-step: parse and preview first, commit second. A biometric file is
 * the payroll input, so somebody should see what it contains before it lands.
 */

/** Saved scanner names are internal matching data, never employee display names. */
async function resolveEmployees(rows) {
  const mappings = await query(`SELECT b.code,b.scanner_name scannerName,e.id,e.name,e.status,e.deactivated_at deactivatedAt
    FROM employee_biometric_ids b JOIN employees e ON e.id=b.employee_id`);
  return resolveScannerRows(rows, mappings);
}

/*
 * Any punch at all means the person was on site that day — the terminal counts a day as
 * attended on a single punch, and so should this. Reading a lone evening punch as an
 * absence would mark somebody away on a day they plainly worked, and payroll follows this.
 */
const stateFor = row => {
  if (row.declaredState) return row.declaredState;
  if (!row.checkIn && !row.checkOut) return 'Absent';
  if (row.checkOut) return 'Checked out';
  return row.checkIn > LATE_AFTER ? 'Late' : 'On site';
};

/**
 * Parses the uploaded file and reports what it found without writing anything, so the
 * unmatched names and unreadable rows can be dealt with before the data lands.
 */
router.post('/preview', auth, permit('hr.attendance'), wrap(async (req, res) => {
  const { file, discard } = await readUpload(req);
  /* A spreadsheet has to be parsed whole, so this is one of the few places the bytes are
     genuinely needed in memory. Attendance exports are small; documents never come here. */
  let parsed;
  try {
    parsed = parseBiometricFile({ ...file, buffer: await readUploadedFile(file.path) });
  } finally {
    await discard();
  }
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
    'SELECT employee_id employeeId,employee_name name,work_date workDate FROM visible_attendance WHERE work_date BETWEEN ? AND ?',
    [dates[0], dates[dates.length - 1]]);
  const alreadyHave = new Set(existing.map(row => `${row.employeeId || row.name}|${String(row.workDate).slice(0, 10)}`));
  const planned = await query(`SELECT employee_id employeeId,work_date workDate,work_location workLocation,project_id projectId
    FROM visible_employee_work_locations WHERE work_date BETWEEN ? AND ?`, [dates[0], dates[dates.length - 1]]);
  const plannedByDay = new Map(planned.map(row => [`${row.employeeId}|${String(row.workDate).slice(0, 10)}`, row]));

  const rows = resolved.map(row => {
    const plan = plannedByDay.get(`${row.employeeId}|${row.date}`);
    return { ...row, state: stateFor(row),
      plannedWorkLocation: plan?.workLocation || null, plannedProjectId: plan?.projectId || null,
      duplicate: alreadyHave.has(`${row.employeeId || row.name}|${row.date}`) };
  });

  /* One line per unrecognised device number, so the mapping is offered once rather than
     once per day that person worked. */
  const unknown = new Map();
  const employees = await query("SELECT id,code,name,designation,payroll_category FROM visible_employees WHERE status <> 'Left' ORDER BY name");
  const normal = value => String(value || '').trim().toLowerCase();
  for (const row of rows) {
    if (row.employeeId || !row.code) continue;
    const suggested = employees.find(person => normal(person.code) === normal(row.code))
      || employees.find(person => normal(person.name) === normal(row.name));
    const entry = unknown.get(row.code)
      || { code: row.code, name: row.name || '', department: row.department || '', days: 0,
        firstDate: row.date, suggestedEmployeeId: suggested?.id || null,
        suggestedEmployee: suggested?.name || null };
    entry.days += 1;
    if (row.date < entry.firstDate) entry.firstDate = row.date;
    unknown.set(row.code, entry);
  }

  for(const row of rows){
    const person=employees.find(employee=>Number(employee.id)===Number(row.employeeId));
    if(person&&usesSiteTravelPunches(person)){
      row.siteStop=inferSiteStop(row);row.siteStopReview=Boolean(row.checkIn&&row.checkOut&&!row.siteStop);
    }
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
  filename: z.string().max(200).optional(),
  rows: z.array(z.object({
    employeeId: z.number().int().positive().nullable().optional(),
    code: z.string().max(40).nullable().optional(),
    name: z.string().max(120).nullable().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkIn: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable().optional(),
    checkOut: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).nullable().optional(),
    siteStop:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).nullable().optional(),
    punchTimes:z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)).max(100).optional(),
    needsReview: z.boolean().optional(),
    declaredState: z.enum(['Absent', 'On leave', 'Business trip']).nullable().optional(),
    correctionReason: z.string().trim().min(3).max(500).nullable().optional()
  }).extend({
    workLocation: z.enum(['Office', 'Site', 'Not working']).nullable().optional(),
    projectId: z.number().int().positive().nullable().default(null)
  })).min(1).max(5000)
})), wrap(async (req, res) => {

  const resolved = await resolveEmployees(req.body.rows);
  if (resolved.length !== req.body.rows.length) {
    return res.status(409).json({ error: 'Some selected employees are deactivated. Refresh the import preview before continuing.' });
  }
  const unresolved = resolved.filter(row => !row.employeeId);
  if (unresolved.length) {
    return res.status(409).json({ error: `${unresolved.length} attendance row(s) still need an identity decision` });
  }
  const projectIds = [...new Set(resolved.filter(row => row.workLocation === 'Site').map(row => row.projectId))];
  const projects = projectIds.length ? await query(
    `SELECT id,name FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`, projectIds) : [];
  const projectById = new Map(projects.map(project => [Number(project.id), project]));
  for (const row of resolved) {
    const notWorking = ['Absent', 'On leave'].includes(stateFor(row));
    if (!row.workLocation && row.projectId === null) continue;
    const valid = notWorking
      ? row.workLocation === 'Not working' && row.projectId === null
      : row.workLocation === 'Office' ? row.projectId === null
        : row.workLocation === 'Site' && projectById.has(row.projectId);
    if (!valid) return res.status(400).json({ error: `Check the work location for ${row.employee || row.name || row.code} on ${row.date}. Choose Office or an existing project site; absent and leave days must be Not working.` });
  }
  const skipped = [];
  let inserted = 0;
  let updated = 0;
  let currentRecord;

  await transaction(async connection => {
    const [lockedMappings]=await connection.query('SELECT b.code,b.employee_id FROM employee_biometric_ids b ORDER BY b.code FOR UPDATE');
    for(const row of resolved){const mapping=lockedMappings.find(m=>String(m.code).toLowerCase()===String(row.code||'').toLowerCase());
      if(mapping&&Number(mapping.employee_id)!==Number(row.employeeId))throw Object.assign(new Error('A scanner mapping changed. Refresh the import preview.'),{status:409});}
    // Consistent employee lock order also serializes overlapping imports for the same person.
    const ordered = [...resolved].sort((a, b) => a.employeeId - b.employeeId || a.date.localeCompare(b.date));
    for (const row of ordered) {
      currentRecord = row;
      const employeeId = row.employeeId || null;
      const [employees] = await connection.execute('SELECT name,designation,payroll_category FROM visible_employees WHERE id=? FOR UPDATE', [employeeId]);
      const employee = employees[0];
      if (!employee) throw Object.assign(new Error('An employee was deactivated while this import was being reviewed. Refresh the preview.'), { status: 409 });
      const name = employee.name;
      const siteStop=['Absent','On leave','Business trip'].includes(stateFor(row))?null:row.siteStop!==undefined?row.siteStop:usesSiteTravelPunches(employee)?inferSiteStop(row):null;
      const boundaryProblem=siteStopProblem(row.checkIn,siteStop,row.checkOut);if(boundaryProblem)throw Object.assign(new Error(boundaryProblem),{status:400});

      const state = stateFor(row);
      const checkIn = ['Absent', 'On leave', 'Business trip'].includes(state) ? null : row.checkIn || null;
      const checkOut = ['Absent', 'On leave', 'Business trip'].includes(state) ? null : row.checkOut || null;
      const [existing] = await connection.execute(
        'SELECT * FROM attendance WHERE employee_id=? AND work_date=? LIMIT 1 FOR UPDATE', [employeeId, row.date]);
      if (!existing.length) {
        const [namesakes] = await connection.execute('SELECT id FROM employees WHERE name=?', [name]);
        if (namesakes.length === 1) {
          const [legacy] = await connection.execute(
            'SELECT * FROM attendance WHERE identity_archived_at IS NULL AND employee_id IS NULL AND employee_name=? AND work_date=? ORDER BY id LIMIT 2 FOR UPDATE',
            [name, row.date]);
          if (legacy.length === 1) existing.push(legacy[0]);
        }
      }
      const workLocation = row.workLocation || (['Absent', 'On leave'].includes(state)
        ? 'Not working' : existing[0]?.work_location || 'Unassigned');
      const projectId = row.workLocation ? row.projectId
        : workLocation === 'Site' ? existing[0]?.project_id ?? null : null;

      if (existing[0]) {
        /* Re-uploading a file must not silently erase an HR correction already used by payroll. */
        if (existing[0].correction_reason && !row.correctionReason) {
          skipped.push({ code: row.code, date: row.date, why: 'A manual correction was kept' });
          continue;
        }
        await connection.execute(
          `UPDATE attendance SET employee_name=?,role=?,project_id=?,work_location=?,check_in=?,check_out=?,state=?,employee_id=COALESCE(?,employee_id),
             site_stop=?,raw_punches=?,biometric_code=?,needs_review=?,source='Biometric',correction_reason=COALESCE(?,correction_reason),confirmed_by=? WHERE id=?`,
          [name, employee.designation || 'Worker', projectId, workLocation, checkIn, checkOut, state, employeeId,
            siteStop,JSON.stringify(row.punchTimes||[]),row.code||null,row.needsReview ? 1 : 0, row.correctionReason || null, req.user.id, existing[0].id]);
        if (row.correctionReason) await audit(connection, req.user.id, 'IMPORT_CORRECTION', 'attendance', existing[0].id,
          existing[0], { ...row, state, correctionReason: row.correctionReason }, req.ip);
        updated += 1;
      } else {
        const [created] = await connection.execute(
          `INSERT INTO attendance (employee_name,role,project_id,work_location,employee_id,work_date,check_in,check_out,state,
             needs_review,source,correction_reason,confirmed_by,site_stop,raw_punches,biometric_code)
           VALUES (?,?,?,?,?,?,?,?,?,?,'Biometric',?,?,?,?,?)`,
          [name, employee.designation || 'Worker', projectId, workLocation, employeeId, row.date,
            checkIn, checkOut, state, row.needsReview ? 1 : 0, row.correctionReason || null, req.user.id,siteStop,JSON.stringify(row.punchTimes||[]),row.code||null]);
        if (row.correctionReason) await audit(connection, req.user.id, 'IMPORT_CORRECTION', 'attendance', created.insertId,
          null, { ...row, state, correctionReason: row.correctionReason }, req.ip);
        inserted += 1;
      }
    }
    await audit(connection, req.user.id, 'IMPORT', 'attendance', null, null,
      { filename: req.body.filename || null, inserted, updated, skipped: skipped.length,
        locations: [...new Set(resolved.map(row => row.workLocation === 'Site' ? `Site:${row.projectId}` : row.workLocation))] }, req.ip);
  }).catch(error => {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    if (error.sqlMessage?.includes('uq_employee_day')) {
      throw Object.assign(new Error('The attendance database still uses the old name-based duplicate rule. Apply the latest attendance database migration, then retry. No attendance from this import was saved.'), { status: 409 });
    }
    throw Object.assign(new Error(`Attendance conflicts for ${currentRecord?.employee || currentRecord?.code || 'an employee'} on ${currentRecord?.date || 'a selected date'}. No attendance from this import was saved. Refresh the preview and retry.`), { status: 409 });
  });

  res.status(201).json({ site: 'assigned work locations', inserted, updated, skipped });
}));

/**
 * Ties the terminal number and optional export name to an employee using the existing
 * HR decision. Saved names are internal aliases, not replacement profile names.
 */
router.post('/mappings', auth, permit('hr.attendance'), validate(z.object({
  code: z.string().trim().min(1).max(40),
  scannerName: z.string().trim().min(1).max(120).optional(),
  employeeId: z.number().int().positive(),
  replaceExisting: z.boolean().optional()
})), wrap(async (req, res) => {
  const employee = await getOne("SELECT id,name,code FROM visible_employees WHERE id=? AND status<>'Left'", [req.body.employeeId]);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  await transaction(async connection => {
    const [[owner]] = await connection.execute(`SELECT e.id,e.name,b.scanner_name scannerName FROM employee_biometric_ids b
      JOIN employees e ON e.id=b.employee_id WHERE b.code=? FOR UPDATE`, [req.body.code]);
    const taken = owner?.id !== employee.id ? owner : null;
    if (taken && !req.body.replaceExisting) throw Object.assign(
      new Error(`Device number ${req.body.code} is already ${taken.name}'s. Confirm reassignment before changing it.`),
      { status: 409 });
    if (taken) {
      await connection.execute('UPDATE employees SET biometric_id=NULL WHERE id=? AND biometric_id=?', [taken.id, req.body.code]);
      await connection.execute('UPDATE employee_biometric_ids SET employee_id=? WHERE code=?', [employee.id, req.body.code]);
    } else {
      await connection.execute(`INSERT INTO employee_biometric_ids (code,employee_id) VALUES (?,?)
        ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id)`, [req.body.code, employee.id]);
    }
    if (req.body.scannerName || taken) await connection.execute(
      'UPDATE employee_biometric_ids SET scanner_name=? WHERE code=? AND employee_id=?',
      [req.body.scannerName || null, req.body.code, employee.id]);
    await connection.execute('UPDATE employees SET biometric_id=? WHERE id=? AND biometric_id IS NULL', [req.body.code, employee.id]);
    await audit(connection, req.user.id, taken ? 'REASSIGN' : 'UPDATE', 'employee_biometric', employee.id,
      owner ? { employeeId: owner.id, scannerName: owner.scannerName || null } : null,
      { biometricId: req.body.code, scannerName: req.body.scannerName || (taken ? null : owner?.scannerName) || null }, req.ip);
  });
  const codes = await query('SELECT code FROM visible_employee_biometric_ids WHERE employee_id=? ORDER BY code', [employee.id]);
  res.json({ employeeId: employee.id, name: employee.name, code: req.body.code, codes: codes.map(row => row.code) });
}));

/** Create the minimum safe employee profile from a scanner identity. HR can enrich it later. */
router.post('/people', auth, permit('hr.attendance'), validate(z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(2).max(120),
  department: z.string().max(120).optional(),
  firstDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
})), wrap(async (req, res) => {
  const body = req.body;
  const taken = await getOne(`SELECT e.id,e.name FROM visible_employee_biometric_ids b
    JOIN visible_employees e ON e.id=b.employee_id WHERE b.code=?`, [body.code]);
  if (taken) return res.status(409).json({ error: `Device number ${body.code} already belongs to ${taken.name}` });

  const created = await transaction(async connection => {
    let departmentId = null;
    if (body.department?.trim()) {
      const [departments] = await connection.execute('SELECT id FROM departments WHERE LOWER(name)=LOWER(?) LIMIT 1', [body.department.trim()]);
      if (departments[0]) departmentId = departments[0].id;
      else {
        const [department] = await connection.execute('INSERT INTO departments (name,description) VALUES (?,?)',
          [body.department.trim(), 'Created from biometric attendance import']);
        departmentId = department.insertId;
      }
    }
    const baseCode = `BIO-${body.code}`.slice(0, 40);
    let employeeCode = baseCode;
    let suffix = 1;
    while ((await connection.execute('SELECT id FROM visible_employees WHERE code=?', [employeeCode]))[0].length) {
      employeeCode = `${baseCode.slice(0, 35)}-${suffix++}`;
    }
    const officeDepartment = /human resources|(^| )hr($| )|account|finance|administration|(^| )admin($| )|quantity survey|(^| )qs($| )/i.test(body.department || '');
    const [result] = await connection.execute(`INSERT INTO employees
      (code,name,department_id,designation,worker_type,join_date,status,biometric_id,notes)
      VALUES (?,?,?,?,?,?,'Active',?,?)`, [employeeCode, body.name.trim(), departmentId,
      body.department?.trim() ? `${body.department.trim()} team` : 'Worker', officeDepartment ? 'Office' : 'Site', body.firstDate, body.code,
      'Profile created from biometric import; HR review required.']);
    await connection.execute('INSERT INTO employee_biometric_ids (code,employee_id,scanner_name) VALUES (?,?,?)', [body.code, result.insertId, body.name.trim()]);
    await audit(connection, req.user.id, 'CREATE', 'employee', result.insertId, null,
      { code: employeeCode, name: body.name.trim(), biometricId: body.code, source: 'Biometric import' }, req.ip);
    return { id: result.insertId, code: employeeCode };
  });
  res.status(201).json({ ...created, name: body.name.trim(), biometricId: body.code });
}));

/** What has been imported, so a gap in the record is visible. */
router.get('/history', auth, permit('hr.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT a.id,a.created_at createdAt,u.name importedBy,a.after_json detail
    FROM audit_logs a JOIN users u ON u.id=a.user_id
    WHERE a.action='IMPORT' AND a.entity='attendance' ORDER BY a.id DESC LIMIT 50`))));

export default router;
