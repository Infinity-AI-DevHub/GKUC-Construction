import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, spendSql, today } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';
import { listAttachments } from './uploads.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const projectSchema = z.object({
  name: z.string().min(3).max(180),
  client: z.string().min(2).max(180),
  manager: z.string().min(2).max(120),
  site: z.string().min(2).max(180),
  stage: z.string().min(2).max(150),
  budget: z.number().nonnegative(),
  progress: z.number().int().min(0).max(100).default(0),
  health: z.enum(['On track', 'Watch', 'At risk']).default('On track'),
  startDate: isoDate.optional(),
  endDate: isoDate.optional()
});

const columns = { startDate: 'start_date', endDate: 'end_date' };
const toRow = body => {
  const entries = Object.entries(body).map(([key, value]) => [columns[key] || key, value]);
  return { fields: entries.map(([key]) => key), values: entries.map(([, value]) => value) };
};

router.get('/', auth, wrap(async (_req, res) => res.json(await query('SELECT * FROM projects WHERE active=1 ORDER BY id'))));

router.get('/:id', auth, wrap(async (req, res) => {
  const project = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const [milestones, documents, team, tasks, expenses, incomes, boqs] = await Promise.all([
    query('SELECT id,title,due_date dueDate,status,completed_at completedAt,notes FROM project_milestones WHERE project_id=? ORDER BY due_date', [project.id]),
    listAttachments('project', project.id),
    query(`SELECT t.id,t.project_role projectRole,e.name,e.designation,e.code FROM project_team t
      JOIN employees e ON e.id=t.employee_id WHERE t.project_id=? AND t.released_at IS NULL ORDER BY e.name`, [project.id]),
    query('SELECT id,title,assignee,due,priority,status FROM tasks WHERE project_id=? ORDER BY id DESC', [project.id]),
    query(`SELECT ${spendSql('p')} total FROM projects p WHERE p.id=?`, [project.id]),
    query('SELECT COALESCE(SUM(amount),0) total FROM incomes WHERE project_id=?', [project.id]),
    query('SELECT id,reference,title,status,total FROM boqs WHERE project_id=? ORDER BY id DESC', [project.id])
  ]);
  res.json({
    ...project,
    milestones,
    documents,
    team,
    tasks,
    boqs,
    finance: { expenses: expenses[0].total, income: incomes[0].total, budget: project.budget }
  });
}));

router.post('/', auth, permit(roles.projects), validate(projectSchema), wrap(async (req, res) => {
  const { fields, values } = toRow(req.body);
  const result = await query(`INSERT INTO projects (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, values);
  const row = await getOne('SELECT * FROM projects WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'project', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit(roles.projects), validate(projectSchema.partial()), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Project not found' });
  const { fields, values } = toRow(req.body);
  if (!fields.length) return res.json(before);
  await query(`UPDATE projects SET ${fields.map(key => `${key}=?`).join(',')} WHERE id=?`, [...values, req.params.id]);
  const after = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'project', after.id, before, after, req.ip);
  res.json(after);
}));

router.delete('/:id', auth, permit(roles.manage), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Project not found' });
  await query('UPDATE projects SET active=0 WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'ARCHIVE', 'project', before.id, before, null, req.ip);
  res.status(204).end();
}));

/* Milestones (PID 2.4) */
router.post('/:id/milestones', auth, permit(roles.projects), validate(z.object({
  title: z.string().min(2).max(180),
  dueDate: isoDate,
  status: z.enum(['Pending', 'In progress', 'Completed', 'Delayed']).default('Pending'),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO project_milestones (project_id,title,due_date,status,notes) VALUES (?,?,?,?,?)',
    [req.params.id, body.title, body.dueDate, body.status, body.notes || null]);
  const row = await getOne('SELECT * FROM project_milestones WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'milestone', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/milestones/:id', auth, permit(roles.projects), validate(z.object({
  status: z.enum(['Pending', 'In progress', 'Completed', 'Delayed'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM project_milestones WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Milestone not found' });
  const completed = req.body.status === 'Completed' ? today() : null;
  await query('UPDATE project_milestones SET status=?,completed_at=? WHERE id=?', [req.body.status, completed, req.params.id]);
  const after = await getOne('SELECT * FROM project_milestones WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'milestone', after.id, before, after, req.ip);
  res.json(after);
}));

/**
 * PID 2.4 "Completion Reports" and section 3 step 10 — the close-out pack, generated
 * from what the system already holds rather than compiled by hand at the end.
 */
router.get('/:id/completion', auth, wrap(async (req, res) => {
  const project = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const [cost, income, byCategory, tasks, milestones, labour, materials, equipment, reports, boq] = await Promise.all([
    getOne(`SELECT ${spendSql('p')} total FROM projects p WHERE p.id=?`, [project.id]),
    getOne('SELECT COALESCE(SUM(amount),0) total FROM incomes WHERE project_id=?', [project.id]),
    query('SELECT source,COALESCE(SUM(amount),0) total FROM expenses WHERE project_id=? GROUP BY source', [project.id]),
    getOne(`SELECT COUNT(*) total, SUM(status IN ('Completed','Approved')) done FROM tasks WHERE project_id=?`, [project.id]),
    getOne(`SELECT COUNT(*) total, SUM(status='Completed') done FROM project_milestones WHERE project_id=?`, [project.id]),
    getOne(`SELECT COUNT(*) shifts, COUNT(DISTINCT employee_name) people FROM attendance
      WHERE project_id=? AND state IN ('On site','Late','Checked out')`, [project.id]),
    query(`SELECT m.name,m.unit,COALESCE(SUM(sm.quantity),0) quantity FROM stock_movements sm JOIN materials m ON m.id=sm.material_id
      WHERE sm.project_id=? AND sm.movement_type='Issue' GROUP BY m.id ORDER BY quantity DESC LIMIT 20`, [project.id]),
    query(`SELECT e.name,e.code,MIN(a.assigned_at) firstUsed,MAX(COALESCE(a.returned_at,CURDATE())) lastUsed
      FROM equipment_assignments a JOIN equipment e ON e.id=a.equipment_id WHERE a.project_id=? GROUP BY e.id`, [project.id]),
    getOne(`SELECT COUNT(*) total, COALESCE(SUM(delay_hours),0) delayHours,
      SUM(issue <> '') issues FROM daily_reports WHERE project_id=?`, [project.id]),
    getOne(`SELECT COALESCE(SUM(total),0) estimated FROM boqs WHERE project_id=? AND status='Approved'`, [project.id])
  ]);

  const spent = Number(cost.total);
  const received = Number(income.total);
  res.json({
    project: {
      id: project.id, name: project.name, client: project.client, site: project.site, manager: project.manager,
      stage: project.stage, progress: project.progress, health: project.health,
      startDate: project.start_date, endDate: project.end_date
    },
    financial: {
      budget: Number(project.budget), estimated: Number(boq.estimated), spent, income: received,
      margin: received - spent,
      marginPercent: received ? Number((((received - spent) / received) * 100).toFixed(1)) : 0,
      variance: Number(project.budget) - spent,
      byCategory
    },
    delivery: {
      tasks: { total: Number(tasks.total), completed: Number(tasks.done || 0) },
      milestones: { total: Number(milestones.total), completed: Number(milestones.done || 0) },
      reports: Number(reports.total), issuesRaised: Number(reports.issues || 0), delayHours: Number(reports.delayHours)
    },
    resources: { labour, materials, equipment }
  });
}));

/* Project team (PID 2.4) */
router.post('/:id/team', auth, permit(roles.projects), validate(z.object({
  employeeId: z.number().int().positive(),
  projectRole: z.string().min(2).max(120)
})), wrap(async (req, res) => {
  try {
    const result = await query('INSERT INTO project_team (project_id,employee_id,project_role) VALUES (?,?,?)',
      [req.params.id, req.body.employeeId, req.body.projectRole]);
    const row = await getOne('SELECT * FROM project_team WHERE id=?', [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'project_team', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That employee is already on this project team' });
    throw error;
  }
}));

export default router;
