import { Router } from 'express';
import { z } from 'zod';
import { audit, clock, getOne, pool, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const LATE_AFTER = process.env.ATTENDANCE_LATE_AFTER || '08:00:00';
const attendanceTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/, 'Enter a time between 00:00 and 23:59');

const select = `SELECT a.id,a.employee_name name,a.role,CASE WHEN a.work_location='Not working' THEN 'Not working' ELSE COALESCE(p.name,'Head office') END site,a.project_id projectId,a.work_location workLocation,a.check_in \`in\`,a.check_out \`out\`,
  a.state,a.work_date workDate,a.employee_id employeeId FROM attendance a LEFT JOIN projects p ON p.id=a.project_id`;

router.get('/site-submissions',auth,permit('hr.attendance','hr.manage'),wrap(async(req,res)=>{
  res.json(await query(`SELECT s.id,s.employee_id employeeId,e.name employee,p.name project,s.state,
    DATE_FORMAT(s.work_date,'%Y-%m-%d') workDate,s.status,u.name submittedBy,s.submitted_at submittedAt
    FROM site_attendance_submissions s JOIN employees e ON e.id=s.employee_id
    JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=s.submitted_by
    WHERE s.status='Pending' ORDER BY s.work_date DESC,s.id DESC LIMIT 150`));
}));

router.post('/site-submissions',auth,permit('site.reports'),validate(z.object({
  projectId:z.number().int().positive(),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries:z.array(z.object({employeeId:z.number().int().positive(),state:z.enum(['On site','Absent'])})).min(1).max(300)
})),wrap(async(req,res)=>{
  const {projectId,date,entries}=req.body;
  if(new Set(entries.map(row=>row.employeeId)).size!==entries.length)return res.status(400).json({error:'Each employee can appear only once.'});
  const project=await getOne('SELECT id FROM projects WHERE id=? AND active=1',[projectId]);
  if(!project)return res.status(404).json({error:'Active project not found.'});
  const existing=await query(`SELECT employee_id employeeId,status FROM site_attendance_submissions WHERE work_date=?
    AND employee_id IN (${entries.map(()=>'?').join(',')})`,[date,...entries.map(row=>row.employeeId)]);
  if(existing.some(row=>row.status!=='Pending'))return res.status(409).json({error:'An employee has already been reviewed for this date. Ask HR to correct the attendance record.'});
  const authoritative=await query(`SELECT employee_id employeeId FROM attendance WHERE work_date=? AND employee_id IN (${entries.map(()=>'?').join(',')})`,[date,...entries.map(row=>row.employeeId)]);
  if(authoritative.length)return res.status(409).json({error:'HR has already recorded attendance for an employee on this date.'});
  await transaction(async connection=>{
    for(const entry of entries){
      const [[employee]]=await connection.execute('SELECT id FROM employees WHERE id=? AND status<>?',[entry.employeeId,'Archived']);
      if(!employee)throw Object.assign(new Error('Choose an active employee.'),{status:400});
      await connection.execute(`INSERT INTO site_attendance_submissions
        (employee_id,project_id,work_date,state,submitted_by) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),state=VALUES(state),submitted_by=VALUES(submitted_by),submitted_at=NOW()`,
      [entry.employeeId,projectId,date,entry.state,req.user.id]);
    }
    await audit(connection,req.user.id,'SUBMIT','site_attendance',projectId,null,{date,entries},req.ip);
  });
  res.status(201).json({submitted:entries.length,status:'Pending HR review'});
}));

router.post('/site-submissions/:id/review',auth,permit('hr.attendance','hr.manage'),validate(z.object({
  decision:z.enum(['Approved','Rejected']),note:z.string().trim().max(500).optional()
})),wrap(async(req,res)=>{
  const outcome=await transaction(async connection=>{
    const [[row]]=await connection.execute('SELECT * FROM site_attendance_submissions WHERE id=? FOR UPDATE',[req.params.id]);
    if(!row)return {status:404,error:'Submission not found'};
    if(row.status!=='Pending')return {status:409,error:'This submission was already reviewed'};
    if(req.body.decision==='Approved'){
      const [[employee]]=await connection.execute('SELECT name,designation FROM employees WHERE id=?',[row.employee_id]);
      const [[existing]]=await connection.execute('SELECT id FROM attendance WHERE employee_id=? AND work_date=?',[row.employee_id,row.work_date]);
      if(existing)return {status:409,error:'HR attendance already exists. Reject this submission or use an audited correction.'};
      await connection.execute(`INSERT INTO attendance
        (employee_name,role,project_id,work_location,employee_id,work_date,state,confirmed_by,source,source_notes)
        VALUES (?,?,?,'Site',?,?,?,?,'Attendance sheet',?)`,
      [employee.name,employee.designation||'Employee',row.project_id,row.employee_id,row.work_date,row.state,req.user.id,`Site submission ${row.id}`]);
    }
    await connection.execute('UPDATE site_attendance_submissions SET status=?,reviewed_by=?,reviewed_at=NOW(),review_note=? WHERE id=?',
      [req.body.decision,req.user.id,req.body.note||null,row.id]);
    await audit(connection,req.user.id,'REVIEW','site_attendance',row.id,row,{decision:req.body.decision,note:req.body.note},req.ip);
    return {id:row.id,status:req.body.decision};
  });
  if(outcome.error)return res.status(outcome.status).json({error:outcome.error});
  res.json(outcome);
}));

router.get('/', auth, permit('hr.attendance','hr.manage'), wrap(async (req, res) => {
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
router.get('/analytics', auth, permit('hr.attendance','hr.manage'), wrap(async (_req, res) => {
  const end = today();
  const start = dateShift(end, -364);
  const [employees, records] = await Promise.all([
    query(`SELECT id,code,name,designation,join_date joinDate,status FROM employees
      WHERE status <> 'Left' ORDER BY name`),
    query(`SELECT employee_id employeeId,employee_name name,work_date workDate,state
      FROM attendance WHERE work_date BETWEEN ? AND ? ORDER BY work_date`, [start, end])
  ]);
  const active = employees.length;
  const activeIds = new Set(employees.map(employee => Number(employee.id)));
  const idsByName = new Map();
  for (const employee of employees) {
    const matches = idsByName.get(employee.name) || [];
    matches.push(Number(employee.id));
    idsByName.set(employee.name, matches);
  }
  const activeEmployeeId = record => {
    if (record.employeeId != null) {
      const id = Number(record.employeeId);
      return activeIds.has(id) ? id : null;
    }
    const matches = idsByName.get(record.name) || [];
    return matches.length === 1 ? matches[0] : null;
  };
  const dayRows = new Map();
  for (const record of records) {
    const day = String(record.workDate).slice(0, 10);
    if (!dayRows.has(day)) dayRows.set(day, []);
    dayRows.get(day).push(record);
  }
  const series = length => Array.from({ length }, (_, index) => dateShift(end, index - length + 1)).map(day => {
    const rows = dayRows.get(day) || [];
    const present = new Set(rows.filter(row => attended(row.state)).map(activeEmployeeId).filter(id => id !== null)).size;
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

router.post('/', auth, permit('hr.attendance'), validate(z.object({
  name: z.string().max(120).optional(),
  role: z.string().max(100).optional(),
  projectId: z.number().int().positive().nullable().optional(),
  workLocation: z.enum(['Office', 'Site']).default('Site'),
  employeeId: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']).default('On site'),
  checkIn: attendanceTime.nullable().optional(),
  checkOut: attendanceTime.nullable().optional(),
  informationSource:z.enum(['Biometric','Attendance sheet','WhatsApp','Signed timesheet','Management instruction','Other']).default('Other'),
  sourceNotes:z.string().trim().max(2000).default('')
}).refine(value => value.workLocation !== 'Site' || Boolean(value.projectId), {
  message: 'Choose the site where this person worked', path: ['projectId']
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    if(!body.employeeId)return res.status(400).json({error:'Select a saved employee. Attendance must belong to one employee profile.'});
    const employee=await getOne('SELECT name,designation FROM employees WHERE id=?',[body.employeeId]);
    if(!employee)return res.status(404).json({error:'Employee not found. Refresh the employee list.'});
    const checkIn = ['Absent', 'On leave'].includes(body.state) ? null : (body.checkIn || null);
    const checkOut = ['Absent', 'On leave'].includes(body.state) ? null : (body.checkOut || null);
    const state = body.state === 'On site' && checkIn > LATE_AFTER ? 'Late' : body.state;
    const projectId = body.workLocation === 'Office' ? null : body.projectId;
    const result = await query(`INSERT INTO attendance (employee_name,role,project_id,work_location,employee_id,work_date,check_in,check_out,state,confirmed_by,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,'Manual')`, [employee.name, employee.designation?.trim() || 'Employee', projectId, body.workLocation, body.employeeId, body.date, checkIn, checkOut, state, req.user.id]);
    await query('UPDATE attendance SET employee_name=?,source=?,source_notes=? WHERE id=?',[employee.name,body.informationSource,body.sourceNotes,result.insertId]);
    const row = await getOne(`${select} WHERE a.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'attendance', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Attendance already exists for this employee and date' });
    throw error;
  }
}));

router.post('/bulk', auth, permit('hr.attendance'), validate(z.object({
  projectId:z.number().int().positive().nullable(),
  workLocation:z.enum(['Office','Site']),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  informationSource:z.enum(['Biometric','Attendance sheet','WhatsApp','Signed timesheet','Management instruction','Other']),
  sourceNotes:z.string().trim().max(2000).default(''),
  entries:z.array(z.object({
    employeeId:z.number().int().positive(),
    state:z.enum(['On site','Late','Checked out','Absent','On leave','Business trip']),
    checkIn:attendanceTime.nullable().optional(),checkOut:attendanceTime.nullable().optional()
  })).min(1).max(300)
})), wrap(async(req,res)=>{
  const b=req.body;
  if(b.workLocation==='Site'&&!b.projectId)return res.status(400).json({error:'Choose the project or site for these attendance records.'});
  const ids=b.entries.map(row=>row.employeeId);
  if(new Set(ids).size!==ids.length)return res.status(400).json({error:'Each employee may appear only once in this attendance batch.'});
  const result=await transaction(async connection=>{
    if(b.workLocation==='Site'){
      const [[project]]=await connection.query('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);
      if(!project)throw Object.assign(new Error('Choose an active project or site.'),{status:400});
    }
    const [employees]=await connection.query(`SELECT id,name,designation,status FROM employees WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);
    const byId=new Map(employees.map(row=>[Number(row.id),row]));
    const missing=ids.filter(id=>!byId.has(id)||byId.get(id).status==='Archived');
    if(missing.length)throw Object.assign(new Error('One or more employees are missing or archived. Refresh the employee list.'),{status:400});
    const [existing]=await connection.query(`SELECT a.employee_id employeeId,e.name FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.work_date=? AND a.employee_id IN (${ids.map(()=>'?').join(',')})`,[b.date,...ids]);
    if(existing.length)throw Object.assign(new Error(`Attendance already exists on ${b.date} for ${existing.map(row=>row.name).join(', ')}. Correct those records separately.`),{status:409});
    const created=[];
    for(const entry of b.entries){
      const employee=byId.get(entry.employeeId);
      const checkIn=['Absent','On leave'].includes(entry.state)?null:(entry.checkIn||null);
      const checkOut=['Absent','On leave'].includes(entry.state)?null:(entry.checkOut||null);
      const state=entry.state==='On site'&&checkIn>LATE_AFTER?'Late':entry.state;
      const [write]=await connection.query(`INSERT INTO attendance
        (employee_name,role,project_id,work_location,employee_id,work_date,check_in,check_out,state,confirmed_by,source,source_notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[employee.name,employee.designation?.trim()||'Employee',b.workLocation==='Site'?b.projectId:null,b.workLocation,employee.id,b.date,checkIn,checkOut,state,req.user.id,b.informationSource,b.sourceNotes]);
      created.push({id:write.insertId,employeeId:employee.id,name:employee.name});
      await audit(connection,req.user.id,'CREATE','attendance',write.insertId,null,{employeeId:employee.id,date:b.date,state,source:b.informationSource},req.ip);
    }
    return created;
  }).catch(error=>{if(error.code==='ER_DUP_ENTRY')throw Object.assign(new Error('Attendance already exists for one of these employees on this date. No records in the batch were saved.'),{status:409});throw error;});
  res.status(201).json({created:result,count:result.length});
}));

/** One button that checks a worker in, then out — supervisors do not have to pick the action. */
router.post('/:id/toggle', auth, permit('hr.attendance'), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Attendance record not found' });
  if(before.work_date!==today())return res.status(409).json({error:'Use attendance correction with a reason to change historical attendance.'});
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
router.patch('/:id', auth, permit('hr.attendance','hr.manage'), validate(z.object({
  state: z.enum(['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']).optional(),
  checkIn: attendanceTime.nullable().optional(),
  checkOut: attendanceTime.nullable().optional(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  projectId: z.number().int().positive().nullable().optional(),
  workLocation: z.enum(['Office', 'Site', 'Not working']).optional(),
  informationSource:z.enum(['Biometric','Attendance sheet','WhatsApp','Signed timesheet','Management instruction','Other']).optional(),sourceNotes:z.string().max(2000).optional(),
  reason: z.string().trim().min(3).max(500)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Attendance record not found' });
  const columns = { state: 'state', checkIn: 'check_in', checkOut: 'check_out', workDate: 'work_date', projectId: 'project_id', workLocation: 'work_location',informationSource:'source',sourceNotes:'source_notes' };
  const body = { ...req.body };
  if (body.workLocation === 'Office' || body.workLocation === 'Not working') body.projectId = null;
  if (body.workLocation === 'Not working' && !['Absent', 'On leave'].includes(body.state || before.state)) {
    return res.status(400).json({ error: 'Not working is only for absent or leave days. Choose Office or a project site for worked days.' });
  }
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
