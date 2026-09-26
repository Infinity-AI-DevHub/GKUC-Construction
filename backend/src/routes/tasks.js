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
  projectId: z.number().int().positive(),
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
  title: z.string().min(3).max(220).optional(), projectId: z.number().int().positive().optional(),
  assignee: z.string().min(2).max(120).optional(), assigneeEmployeeId: z.number().int().positive().optional(),
  assigneeEmployeeIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  due: z.string().min(2).max(100).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(), status: z.enum(STATUSES).optional(), notes: z.string().max(3000).optional()
});
const resolveAssignees = async body => {
  if (body.assigneeEmployeeIds) {
    const ids = [...new Set(body.assigneeEmployeeIds)];
    if (ids.length !== body.assigneeEmployeeIds.length)
      throw Object.assign(new Error('Each employee can be selected only once.'), { status: 400 });
    const found = await query(`SELECT id,name FROM employees WHERE id IN (${ids.map(() => '?').join(',')})
      AND status IN ('Active','On leave')`, ids);
    if (found.length !== ids.length)
      throw Object.assign(new Error('One or more selected employees are not active. Choose active employees or people on leave.'), { status: 400 });
    const names = new Map(found.map(employee => [Number(employee.id), employee.name]));
    return { assigneeEmployeeId: ids[0], assignee: names.get(ids[0]), ids,
      display: ids.map(id => names.get(id)).join(', ') };
  }
  if (body.assigneeEmployeeId) {
    const employee = await getOne("SELECT id,name FROM employees WHERE id=? AND status IN ('Active','On leave')", [body.assigneeEmployeeId]);
    if (!employee) throw Object.assign(new Error('Choose an active employee for this task.'), { status: 400 });
    return { assigneeEmployeeId: employee.id, assignee: employee.name, ids: [Number(employee.id)], display: employee.name };
  }
  const match = await getOne('SELECT MIN(id) id,COUNT(*) matches FROM employees WHERE LOWER(TRIM(name))=LOWER(TRIM(?))', [body.assignee]);
  const id = Number(match?.matches) === 1 ? Number(match.id) : null;
  return { assigneeEmployeeId: id, assignee: body.assignee, ids: id ? [id] : [], display: body.assignee };
};

/* Named columns rather than t.*, so the shape matches the camelCase every other endpoint returns. */
const TASK_COLUMNS = `t.id,t.title,t.project_id projectId,t.assignee_employee_id assigneeEmployeeId,COALESCE(e.name,t.assignee) assignee,t.due,t.priority,t.status,t.notes,t.due_date dueDate,t.approved_by approvedBy,t.created_at createdAt,t.updated_at updatedAt,p.name project`;

const withProject = async id => withTaskAssignees(await getOne(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN employees e ON e.id=t.assignee_employee_id WHERE t.id=?`, [id]));

router.get('/', auth, permit('site.tasks','projects.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.projectId) { filters.push('t.project_id=?'); params.push(req.query.projectId); }
  if (req.query.status) { filters.push('t.status=?'); params.push(req.query.status); }
  if (req.query.assignee) { filters.push(`(t.assignee=? OR EXISTS (SELECT 1 FROM task_assignees ta
    JOIN employees member ON member.id=ta.employee_id WHERE ta.task_id=t.id AND member.name=?))`);
    params.push(req.query.assignee, req.query.assignee); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await withTaskAssignees(await query(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN employees e ON e.id=t.assignee_employee_id ${where} ORDER BY t.id`, params)));
}));

router.get('/reminder-users', auth, permit('site.tasks'), wrap(async (_req,res) => {
  res.json(await query('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'));
}));

router.get('/:id', auth, permit('site.tasks','projects.view'), wrap(async (req, res) => {
  const task = await withProject(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const [comments, attachments] = await Promise.all([
    query(`SELECT c.id,c.comment,c.created_at createdAt,u.name author FROM task_comments c JOIN users u ON u.id=c.user_id
      WHERE c.task_id=? ORDER BY c.id`, [task.id]),
    listAttachments('task', task.id)
  ]);
  res.json({ ...task, comments, attachments });
}));

router.post('/', auth, permit('site.tasks'), validate(taskSchema), wrap(async (req, res) => {
  const body = req.body;
  if (body.reminderAt || body.reminderFrequency || body.reminderUserIds?.length) {
    if (!body.reminderAt || !body.reminderFrequency || !body.reminderUserIds?.length)
      return res.status(400).json({error:'Choose the reminder date and time, frequency and at least one recipient.'});
    const ids=[...new Set(body.reminderUserIds)];
    const recipients=await query(`SELECT id FROM users WHERE active=1 AND id IN (${ids.map(()=>'?').join(',')})`,ids);
    if (recipients.length!==ids.length) return res.status(400).json({error:'One selected reminder recipient is no longer active. Refresh the user list.'});
  }
  const assignee = await resolveAssignees(body);
  const taskId = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO tasks (title,project_id,assignee,assignee_employee_id,due,due_date,priority,status,notes) VALUES (?,?,?,?,?,?,?,?,?)',
      [body.title, body.projectId, assignee.assignee, assignee.assigneeEmployeeId, body.due, body.dueDate || null, body.priority, body.status, body.notes]);
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
  const before = await getOne('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Task not found' });
  if (req.body.status === 'Approved' && !can(req, 'projects.manage')) {
    return res.status(403).json({ error: 'Only management can approve completed work' });
  }
  const columns = { projectId: 'project_id', assigneeEmployeeId: 'assignee_employee_id', dueDate: 'due_date' };
  const body = { ...req.body };
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
    });
  }
  const after = await withProject(req.params.id);
  await audit(pool, req.user.id, 'UPDATE', 'task', after.id, before, after, req.ip);
  res.json(after);
}));

router.post('/:id/comments', auth, permit('site.tasks','projects.view'), validate(z.object({ comment: z.string().min(1).max(2000) })), wrap(async (req, res) => {
  const task = await getOne('SELECT id FROM tasks WHERE id=?', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const result = await query('INSERT INTO task_comments (task_id,user_id,comment) VALUES (?,?,?)', [task.id, req.user.id, req.body.comment]);
  res.status(201).json(await getOne(`SELECT c.id,c.comment,c.created_at createdAt,u.name author
    FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`, [result.insertId]));
}));


export default router;
