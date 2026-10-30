import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, can, permit, validate, wrap } from '../lib/http.js';
import { withTaskAssignees } from '../lib/task-assignees.js';
import { notify } from '../alerts.js';
import { listAttachments } from './uploads.js';

const router = Router();
const STATUSES = ['Not started', 'In progress', 'Blocked', 'Completed', 'Approved', 'Rejected'];

const taskSchema = z.object({
  title: z.string().min(3).max(220),
  projectId: z.number().int().positive().nullable().optional(),
  companyId: z.number().int().positive().optional(),
  assignee: z.string().min(2).max(120).optional(),
  assigneeEmployeeId: z.number().int().positive().optional(),
  assigneeEmployeeIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  due: z.string().min(2).max(100),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reminderAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  reminderFrequency: z.enum(['Once','Daily','Weekly','Monthly']).optional(),
  reminderUserIds: z.array(z.number().int().positive()).max(100).optional(),
  priority: z.enum(['Low', 'Medium', 'High']),
  status: z.enum(STATUSES).default('Not started'),
  notes: z.string().max(3000).default('')
}).refine(value => value.assignee || value.assigneeEmployeeId || value.assigneeEmployeeIds?.length,
  { message: 'Choose at least one employee for this task', path: ['assigneeEmployeeIds'] });
const taskPatch = z.object({
  title: z.string().min(3).max(220).optional(), projectId: z.number().int().positive().nullable().optional(), companyId: z.number().int().positive().optional(),
  assignee: z.string().min(2).max(120).optional(), assigneeEmployeeId: z.number().int().positive().optional(),
  assigneeEmployeeIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  due: z.string().min(2).max(100).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(), status: z.enum(STATUSES).optional(),
  statusReason: z.string().trim().max(2000).optional(), notes: z.string().max(3000).optional()
});
const resolveAssignees = async body => {
  if (body.assigneeEmployeeIds) {
    const ids = [...new Set(body.assigneeEmployeeIds)];
    if (ids.length !== body.assigneeEmployeeIds.length)
      throw Object.assign(new Error('Each employee can be selected only once.'), { status: 400 });
    const found = await query(`SELECT id,name FROM visible_employees WHERE id IN (${ids.map(() => '?').join(',')})
      AND status IN ('Active','On leave')`, ids);
    if (found.length !== ids.length)
      throw Object.assign(new Error('One or more selected employees are not active. Choose active employees or people on leave.'), { status: 400 });
    const names = new Map(found.map(employee => [Number(employee.id), employee.name]));
    return { assigneeEmployeeId: ids[0], assignee: names.get(ids[0]), ids,
      display: ids.map(id => names.get(id)).join(', ') };
  }
  if (body.assigneeEmployeeId) {
    const employee = await getOne("SELECT id,name FROM visible_employees WHERE id=? AND status IN ('Active','On leave')", [body.assigneeEmployeeId]);
    if (!employee) throw Object.assign(new Error('Choose an active employee for this task.'), { status: 400 });
    return { assigneeEmployeeId: employee.id, assignee: employee.name, ids: [Number(employee.id)], display: employee.name };
  }
  const match = await getOne('SELECT MIN(id) id,COUNT(*) matches FROM visible_employees WHERE LOWER(TRIM(name))=LOWER(TRIM(?))', [body.assignee]);
  const id = Number(match?.matches) === 1 ? Number(match.id) : null;
  return { assigneeEmployeeId: id, assignee: body.assignee, ids: id ? [id] : [], display: body.assignee };
};

async function taskCompany(body) {
  if (body.projectId) {
    const project = await getOne('SELECT company_id companyId FROM projects WHERE id=? AND active=1', [body.projectId]);
    if (!project) throw Object.assign(new Error('Active project not found.'), { status: 404 });
    if (body.companyId && Number(body.companyId) !== Number(project.companyId))
      throw Object.assign(new Error('The project belongs to a different operating company.'), { status: 400 });
    return project.companyId;
  }
  if (!body.companyId || !await getOne('SELECT id FROM companies WHERE id=? AND active=1', [body.companyId]))
    throw Object.assign(new Error('Choose an operating company for an office task.'), { status: 400 });
  return body.companyId;
}

/* Named columns rather than t.*, so the shape matches the camelCase every other endpoint returns. */
const TASK_COLUMNS = `t.id,t.title,t.project_id projectId,t.assignee_employee_id assigneeEmployeeId,CASE WHEN t.assignee_employee_id IS NOT NULL THEN e.name ELSE t.assignee END assignee,t.due,t.priority,t.status,t.notes,t.due_date dueDate,t.approved_by approvedBy,t.created_at createdAt,t.updated_at updatedAt,COALESCE(p.name,'Office / general') project,COALESCE(p.company_id,t.company_id) companyId`;

const withProject = async id => withTaskAssignees(await getOne(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN visible_employees e ON e.id=t.assignee_employee_id WHERE t.id=? AND (t.project_id IS NULL OR p.active=1)`, [id]));

router.get('/', auth, permit('site.tasks','projects.view'), wrap(async (req, res) => {
  const filters = ['(t.project_id IS NULL OR p.active=1)'];
  const params = [];
  if (req.query.companyId) { filters.push('COALESCE(p.company_id,t.company_id)=?'); params.push(req.query.companyId); }
  if (req.query.office === '1') filters.push('t.project_id IS NULL');
  if (req.query.projectId) { filters.push('t.project_id=?'); params.push(req.query.projectId); }
  if (req.query.status) { filters.push('t.status=?'); params.push(req.query.status); }
  if (req.query.assignee) { filters.push(`(t.assignee=? OR EXISTS (SELECT 1 FROM visible_task_assignees ta
    JOIN visible_employees member ON member.id=ta.employee_id WHERE ta.task_id=t.id AND member.name=?))`);
    params.push(req.query.assignee, req.query.assignee); }
  const where = `WHERE ${filters.join(' AND ')}`;
  res.json(await withTaskAssignees(await query(`SELECT ${TASK_COLUMNS} FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN visible_employees e ON e.id=t.assignee_employee_id ${where} ORDER BY t.id`, params)));
}));

router.get('/reminder-users', auth, permit('site.tasks'), wrap(async (_req,res) => {
  res.json(await query('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'));
}));

router.get('/:id', auth, permit('site.tasks','projects.view'), wrap(async (req, res) => {
  const task = await withProject(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const [comments, attachments, changes] = await Promise.all([
    query(`SELECT c.id,c.comment,c.created_at createdAt,u.name author FROM task_comments c JOIN users u ON u.id=c.user_id
      WHERE c.task_id=? ORDER BY c.id`, [task.id]),
    listAttachments('task', task.id),
    query(`SELECT a.before_json beforeValue,a.after_json afterValue,a.created_at changedAt,u.name changedBy
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity='task' AND a.entity_id=? ORDER BY a.id DESC LIMIT 50`, [String(task.id)])
  ]);
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
  const statusHistory = changes.map(change => ({ before: parse(change.beforeValue).status || null,
    after: parse(change.afterValue).status || null, reason: parse(change.afterValue).statusReason || null,
    changedAt: change.changedAt, changedBy: change.changedBy || 'System' }))
    .filter(change => change.after && change.after !== change.before);
  res.json({ ...task, comments, attachments, statusHistory });
}));

router.post('/', auth, permit('site.tasks'), validate(taskSchema), wrap(async (req, res) => {
  const body = req.body;
  const companyId = await taskCompany(body);
  if (body.reminderAt || body.reminderFrequency || body.reminderUserIds?.length) {
    if (!body.reminderAt || !body.reminderFrequency || !body.reminderUserIds?.length)
      return res.status(400).json({error:'Choose the reminder date and time, frequency and at least one recipient.'});
    const ids=[...new Set(body.reminderUserIds)];
    const recipients=await query(`SELECT id FROM users WHERE active=1 AND id IN (${ids.map(()=>'?').join(',')})`,ids);
    if (recipients.length!==ids.length) return res.status(400).json({error:'One selected reminder recipient is no longer active. Refresh the user list.'});
  }
  const assignee = await resolveAssignees(body);
  const taskId = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO tasks (title,project_id,company_id,assignee,assignee_employee_id,due,due_date,priority,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [body.title, body.projectId || null, companyId, assignee.assignee, assignee.assigneeEmployeeId, body.due, body.dueDate || null, body.priority, body.status, body.notes]);
    for (const employeeId of assignee.ids) await connection.execute(
      'INSERT INTO task_assignees (task_id,employee_id) VALUES (?,?)', [result.insertId, employeeId]);
    if (body.dueTime) await connection.execute('UPDATE tasks SET due_time=? WHERE id=?',[body.dueTime,result.insertId]);
    if (body.reminderAt) {
      await connection.execute('INSERT INTO task_reminders (task_id,next_due,frequency) VALUES (?,?,?)',
        [result.insertId,body.reminderAt.replace('T',' ')+':00',body.reminderFrequency]);
      for (const userId of new Set(body.reminderUserIds)) await connection.execute('INSERT INTO task_reminder_users (task_id,user_id) VALUES (?,?)',[result.insertId,userId]);
    }
    return result.insertId;
  });
  const row = await withProject(taskId);
  await audit(pool, req.user.id, 'CREATE', 'task', row.id, null, row, req.ip);
  await notify({
    audience: 'site.tasks',
    severity: body.priority === 'High' ? 'Warning' : 'Info',
    title: `Task assigned — ${body.title}`,
    message: `${assignee.display} ${assignee.ids.length === 1 ? 'is' : 'are'} responsible for this ${body.priority.toLowerCase()}-priority task on ${row.project}, due ${body.due}.`,
    referenceType: 'task',
    referenceId: row.id
  });
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit('site.tasks'), validate(taskPatch), wrap(async (req, res) => {
  const before = await getOne(`SELECT t.*,p.company_id projectCompanyId FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND (t.project_id IS NULL OR p.active=1)`, [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Task not found' });
  if (req.body.status === 'Approved' && !can(req, 'projects.manage')) {
    return res.status(403).json({ error: 'Only management can approve completed work' });
  }
  const nextStatus = req.body.status;
  if (nextStatus === 'Approved' && before.status !== 'Completed')
    return res.status(400).json({ error: 'Submit this task for approval before approving it.' });
  if (nextStatus === 'Rejected' && !can(req, 'projects.manage'))
    return res.status(403).json({ error: 'Only project management can return completed work for correction.' });
  if (nextStatus === 'Rejected' && before.status !== 'Completed')
    return res.status(400).json({ error: 'Only work submitted for approval can be returned for correction.' });
  if ((nextStatus === 'Rejected' || nextStatus === 'Blocked') && !req.body.statusReason?.trim())
    return res.status(400).json({ error: `Explain why this task is ${nextStatus === 'Rejected' ? 'being returned' : 'blocked'} so the assigned team knows what to correct.` });
  if (before.status === 'Approved' && nextStatus && nextStatus !== 'Approved')
    return res.status(400).json({ error: 'Approved work cannot be changed back to an earlier status. Contact a project manager to review the record.' });
  const columns = { companyId: 'company_id', projectId: 'project_id', assigneeEmployeeId: 'assignee_employee_id', dueDate: 'due_date' };
  const body = { ...req.body };
  if ('projectId' in body || 'companyId' in body) body.companyId = await taskCompany({
    projectId: 'projectId' in body ? body.projectId : before.project_id,
    companyId: body.companyId || before.projectCompanyId || before.company_id
  });
  delete body.statusReason;
  const changingAssignees = Boolean(body.assigneeEmployeeIds || body.assigneeEmployeeId || body.assignee);
  const assignees = changingAssignees ? await resolveAssignees(body) : null;
  if (assignees) { body.assigneeEmployeeId = assignees.assigneeEmployeeId; body.assignee = assignees.assignee; }
  delete body.assigneeEmployeeIds;
  const entries = Object.entries(body);
  if (entries.length || changingAssignees) {
    const assignments = entries.map(([key]) => `${columns[key] || key}=?`);
    const values = entries.map(([, value]) => value);
    if (req.body.status === 'Approved') { assignments.push('approved_by=?'); values.push(req.user.id); }
    await transaction(async connection => {
      await connection.execute(`UPDATE tasks SET ${assignments.join(',')} WHERE id=?`, [...values, req.params.id]);
      if (changingAssignees) {
        await connection.execute('DELETE FROM task_assignees WHERE task_id=?', [req.params.id]);
        for (const employeeId of assignees.ids) await connection.execute(
          'INSERT INTO task_assignees (task_id,employee_id) VALUES (?,?)', [req.params.id, employeeId]);
      }
      if (nextStatus && nextStatus !== before.status && req.body.statusReason?.trim())
        await connection.execute('INSERT INTO task_comments (task_id,user_id,comment) VALUES (?,?,?)',
          [req.params.id, req.user.id, `${nextStatus === 'Rejected' ? 'Returned for correction' : 'Blocked'}: ${req.body.statusReason.trim()}`]);
    });
  }
  const after = await withProject(req.params.id);
  await audit(pool, req.user.id, 'UPDATE', 'task', after.id, before, { ...after, statusReason: req.body.statusReason || null }, req.ip);
  res.json(after);
}));

router.post('/:id/comments', auth, permit('site.tasks','projects.view'), validate(z.object({ comment: z.string().min(1).max(2000) })), wrap(async (req, res) => {
  const task = await getOne(`SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND (t.project_id IS NULL OR p.active=1)`, [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const result = await query('INSERT INTO task_comments (task_id,user_id,comment) VALUES (?,?,?)', [task.id, req.user.id, req.body.comment]);
  res.status(201).json(await getOne(`SELECT c.id,c.comment,c.created_at createdAt,u.name author
    FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`, [result.insertId]));
}));


export default router;
