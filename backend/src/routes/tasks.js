import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, can, permit, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';
import { listAttachments } from './uploads.js';

const router = Router();
const STATUSES = ['Not started', 'In progress', 'Blocked', 'Completed', 'Approved'];

const taskSchema = z.object({
  title: z.string().min(3).max(220),
  projectId: z.number().int().positive(),
  assignee: z.string().min(2).max(120),
  due: z.string().min(2).max(100),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.enum(['Low', 'Medium', 'High']),
  status: z.enum(STATUSES).default('Not started'),
  notes: z.string().max(3000).default('')
});

/* Named columns rather than t.*, so the shape matches the camelCase every other endpoint returns. */
const TASK_COLUMNS = `t.id,t.title,t.project_id projectId,t.assignee,t.due,t.priority,t.status,t.notes,t.due_date dueDate,t.approved_by approvedBy,t.created_at createdAt,t.updated_at updatedAt,p.name project`;

const withProject = id => getOne(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, [id]);

router.get('/', auth, permit('site.tasks','projects.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.projectId) { filters.push('t.project_id=?'); params.push(req.query.projectId); }
  if (req.query.status) { filters.push('t.status=?'); params.push(req.query.status); }
  if (req.query.assignee) { filters.push('t.assignee=?'); params.push(req.query.assignee); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id=t.project_id ${where} ORDER BY t.id`, params));
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
  const result = await query('INSERT INTO tasks (title,project_id,assignee,due,due_date,priority,status,notes) VALUES (?,?,?,?,?,?,?,?)',
    [body.title, body.projectId, body.assignee, body.due, body.dueDate || null, body.priority, body.status, body.notes]);
  const row = await withProject(result.insertId);
  await audit(pool, req.user.id, 'CREATE', 'task', row.id, null, row, req.ip);
  await notify({
    audience: 'site.tasks',
    severity: body.priority === 'High' ? 'Warning' : 'Info',
    title: `Task assigned — ${body.title}`,
    message: `${body.assignee} is responsible for this ${body.priority.toLowerCase()}-priority task on ${row.project}, due ${body.due}.`,
    referenceType: 'task',
    referenceId: row.id
  });
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit('site.tasks'), validate(taskSchema.partial()), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM tasks WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Task not found' });
  if (req.body.status === 'Approved' && !can(req, 'projects.manage')) {
    return res.status(403).json({ error: 'Only management can approve completed work' });
  }
  const columns = { projectId: 'project_id', dueDate: 'due_date' };
  const entries = Object.entries(req.body);
  if (entries.length) {
    const assignments = entries.map(([key]) => `${columns[key] || key}=?`);
    const values = entries.map(([, value]) => value);
    if (req.body.status === 'Approved') { assignments.push('approved_by=?'); values.push(req.user.id); }
    await query(`UPDATE tasks SET ${assignments.join(',')} WHERE id=?`, [...values, req.params.id]);
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
