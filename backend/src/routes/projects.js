import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, spendSql, today } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { listAttachments } from './uploads.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const projectShape = z.object({
  companyId: z.number().int().positive().default(1),
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

/* A programme that finishes before it starts is a typo, not a plan. */
const runsForwards = value => !value.startDate || !value.endDate || value.endDate >= value.startDate;
const backwards = { message: 'Target completion cannot be before the start date', path: ['endDate'] };

const projectSchema = projectShape.refine(runsForwards, backwards);
const projectPatch = projectShape.partial().refine(runsForwards, backwards);

const columns = { companyId: 'company_id', startDate: 'start_date', endDate: 'end_date' };
const toRow = body => {
  const entries = Object.entries(body).map(([key, value]) => [columns[key] || key, value]);
  return { fields: entries.map(([key]) => key), values: entries.map(([, value]) => value) };
};

router.get('/', auth, permit('projects.view'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId || 0);
  res.json(await query(`SELECT p.*,p.company_id companyId,c.name company,c.code companyCode FROM projects p JOIN companies c ON c.id=p.company_id
    WHERE p.active=1 ${companyId ? 'AND p.company_id=?' : ''} ORDER BY p.id`, companyId ? [companyId] : []));
}));

router.get('/:id', auth, permit('projects.view'), wrap(async (req, res) => {
  const project = await getOne(`SELECT p.*,p.company_id companyId,c.name company,c.code companyCode
    FROM projects p JOIN companies c ON c.id=p.company_id WHERE p.id=?`, [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const [milestones, documents, team, tasks, expenses, incomes, boqs, reports, quotations,
    invoices, purchaseOrders, costBreakdown, expenseLedger, incomeLedger, attendanceLedger,
    materialUsage, equipmentUsage, supplierInvoices, costItems, variationLedger, updates, subcontractRates] = await Promise.all([
    query('SELECT id,title,due_date dueDate,status,completed_at completedAt,notes FROM project_milestones WHERE project_id=? ORDER BY due_date', [project.id]),
    listAttachments('project', project.id),
    query(`SELECT t.id,t.project_role projectRole,e.name,e.designation,e.code FROM project_team t
      JOIN employees e ON e.id=t.employee_id WHERE t.project_id=? AND t.released_at IS NULL ORDER BY e.name`, [project.id]),
    query('SELECT id,title,assignee,due,priority,status FROM tasks WHERE project_id=? ORDER BY id DESC', [project.id]),
    query(`SELECT ${spendSql('p')} total FROM projects p WHERE p.id=?`, [project.id]),
    query('SELECT COALESCE(SUM(amount),0) total FROM incomes WHERE project_id=?', [project.id]),
    query('SELECT id,reference,title,status,total FROM boqs WHERE project_id=? ORDER BY id DESC', [project.id]),
    query(`SELECT id,report_date reportDate,supervisor,workforce,work_completed workCompleted,
      issue,weather,delay_hours delayHours,created_at createdAt
      FROM daily_reports WHERE project_id=? ORDER BY report_date DESC,id DESC LIMIT 12`, [project.id]),
    query(`SELECT id,reference,title,status,total,quote_date quoteDate,valid_until validUntil
      FROM quotations_client WHERE project_id=? ORDER BY id DESC LIMIT 20`, [project.id]),
    query(`SELECT id,reference,title,kind,status,net_payable netPayable,paid_amount paidAmount,
      invoice_date invoiceDate,due_date dueDate
      FROM client_invoices WHERE project_id=? ORDER BY id DESC LIMIT 20`, [project.id]),
    query(`SELECT o.id,o.reference,o.status,o.order_date orderDate,o.total,s.name supplier
      FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id
      WHERE o.project_id=? ORDER BY o.id DESC LIMIT 20`, [project.id]),
    query(`SELECT source,COALESCE(SUM(amount),0) total FROM expenses
      WHERE project_id=? GROUP BY source ORDER BY total DESC`, [project.id]),
    query(`SELECT e.id,e.expense_date date,e.source,e.cost_type costType,e.description,e.amount,e.reference,
      e.boq_item_id boqItemId,bi.description boqItem FROM expenses e LEFT JOIN boq_items bi ON bi.id=e.boq_item_id
      WHERE e.project_id=? ORDER BY e.expense_date DESC,e.id DESC LIMIT 500`, [project.id]),
    query(`SELECT id,received_date date,description,amount,method,reference FROM incomes
      WHERE project_id=? ORDER BY received_date DESC,id DESC LIMIT 500`, [project.id]),
    query(`SELECT work_date date,state,COUNT(DISTINCT COALESCE(CAST(employee_id AS CHAR),CONCAT('name:',employee_name))) people,
      MIN(check_in) firstIn,MAX(check_out) lastOut FROM attendance WHERE project_id=?
      GROUP BY work_date,state ORDER BY work_date DESC LIMIT 500`, [project.id]),
    query(`SELECT m.name,m.unit,SUM(sm.quantity) quantity,COUNT(*) movements
      FROM stock_movements sm JOIN materials m ON m.id=sm.material_id
      WHERE sm.project_id=? AND sm.movement_type='Issue' GROUP BY m.id,m.name,m.unit ORDER BY quantity DESC`, [project.id]),
    query(`SELECT e.code,e.name,a.assigned_to assignedTo,a.assigned_at assignedAt,a.returned_at returnedAt,
      a.condition_note conditionNote FROM equipment_assignments a JOIN equipment e ON e.id=a.equipment_id
      WHERE a.project_id=? ORDER BY a.assigned_at DESC`, [project.id]),
    query(`SELECT si.invoice_no invoiceNo,s.name supplier,si.invoice_date invoiceDate,si.due_date dueDate,
      si.amount,si.paid_amount paidAmount,si.status FROM supplier_invoices si
      JOIN suppliers s ON s.id=si.supplier_id JOIN purchase_orders po ON po.id=si.order_id
      WHERE po.project_id=? ORDER BY si.invoice_date DESC`, [project.id]),
    query(`SELECT bi.id,bi.category,bi.description,bi.unit,bi.quantity,bi.rate,bi.amount expectedAmount,
      COALESCE(SUM(e.amount),0) actualAmount,COALESCE(f.forecast_amount,bi.amount) forecastAmount,f.reason forecastReason
      FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id LEFT JOIN expenses e ON e.boq_item_id=bi.id
      LEFT JOIN project_cost_forecasts f ON f.boq_item_id=bi.id
      WHERE b.project_id=? AND b.status='Approved' GROUP BY bi.id,f.forecast_amount,f.reason ORDER BY bi.id`, [project.id]),
    query(`SELECT reference,description,amount,status,created_at createdAt FROM variation_orders
      WHERE project_id=? ORDER BY id DESC`, [project.id]),
    query(`SELECT u.id,u.kind,u.title,u.details,u.category,u.status,u.priority,u.owner,u.due_date dueDate,
      u.created_at createdAt,u.updated_at updatedAt,a.name author FROM project_updates u
      JOIN users a ON a.id=u.created_by WHERE u.project_id=? ORDER BY u.id DESC`,[project.id]),
    query(`SELECT r.id,r.subcontractor_id subcontractorId,s.name subcontractor,s.trade,s.phone,s.email,
      s.address,s.business_id businessId,s.contact_type contactType,r.work_item workItem,r.unit,r.rate,
      r.agreed_on agreedOn,r.valid_until validUntil,r.notes
      FROM subcontractor_project_rates r JOIN subcontractors s ON s.id=r.subcontractor_id
      WHERE r.project_id=? ORDER BY s.name,r.work_item`,[project.id])
  ]);
  res.json({
    ...project,
    milestones,
    documents,
    team,
    tasks,
    updates,
    subcontractRates,
    boqs,
    reports,
    quotations,
    invoices,
    purchaseOrders,
    costBreakdown,
    reporting: { expenseLedger, incomeLedger, attendanceLedger, materialUsage, equipmentUsage, supplierInvoices, costItems, variationLedger },
    finance: { expenses: expenses[0].total, income: incomes[0].total, budget: project.budget }
  });
}));

const updateShape=z.object({kind:z.enum(['Update','Issue']).default('Update'),title:z.string().trim().min(3).max(220),
  details:z.string().trim().min(3).max(4000),category:z.string().trim().min(2).max(80).default('General'),
  status:z.enum(['Open','In progress','Resolved']).default('Open'),priority:z.enum(['Low','Medium','High']).default('Medium'),
  owner:z.string().trim().max(120).optional(),dueDate:isoDate.optional()});
router.post('/:id/updates',auth,permit('projects.manage','site.tasks'),validate(updateShape),wrap(async(req,res)=>{
  const project=await getOne('SELECT id FROM projects WHERE id=? AND active=1',[req.params.id]);
  if(!project)return res.status(404).json({error:'Project not found'});
  const b=req.body,result=await query(`INSERT INTO project_updates
    (project_id,kind,title,details,category,status,priority,owner,due_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [project.id,b.kind,b.title,b.details,b.category,b.status,b.priority,b.owner||null,b.dueDate||null,req.user.id]);
  await audit(pool,req.user.id,'CREATE','project_update',result.insertId,null,b,req.ip);
  res.status(201).json({id:result.insertId});
}));
router.patch('/updates/:id',auth,permit('projects.manage','site.tasks'),validate(z.object({status:z.enum(['Open','In progress','Resolved']),
  details:z.string().trim().min(3).max(4000).optional()})),wrap(async(req,res)=>{
  const before=await getOne('SELECT * FROM project_updates WHERE id=?',[req.params.id]);
  if(!before)return res.status(404).json({error:'Project update not found'});
  await query('UPDATE project_updates SET status=?,details=COALESCE(?,details) WHERE id=?',
    [req.body.status,req.body.details||null,before.id]);
  await audit(pool,req.user.id,'UPDATE','project_update',before.id,before,req.body,req.ip);
  res.json({id:before.id,status:req.body.status});
}));

router.post('/', auth, permit('projects.manage'), validate(projectSchema), wrap(async (req, res) => {
  const { fields, values } = toRow(req.body);
  const result = await query(`INSERT INTO projects (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, values);
  const row = await getOne(`SELECT p.*,p.company_id companyId,c.name company,c.code companyCode
    FROM projects p JOIN companies c ON c.id=p.company_id WHERE p.id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'project', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit('projects.manage'), validate(projectPatch), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Project not found' });

  /* Only one end of the range may be in the request, so the other comes from the record. */
  const asDate = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
  const startDate = req.body.startDate ?? asDate(before.start_date);
  const endDate = req.body.endDate ?? asDate(before.end_date);
  if (startDate && endDate && endDate < startDate) {
    return res.status(400).json({ error: 'Invalid data', issues: { formErrors: [], fieldErrors: { endDate: [backwards.message] } } });
  }

  const { fields, values } = toRow(req.body);
  if (!fields.length) return res.json(before);
  await query(`UPDATE projects SET ${fields.map(key => `${key}=?`).join(',')} WHERE id=?`, [...values, req.params.id]);
  const after = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'project', after.id, before, after, req.ip);
  res.json(after);
}));

router.delete('/:id', auth, permit('projects.manage'), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM projects WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Project not found' });
  await query('UPDATE projects SET active=0 WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'ARCHIVE', 'project', before.id, before, null, req.ip);
  res.status(204).end();
}));

/* Milestones (PID 2.4) */
router.post('/:id/milestones', auth, permit('projects.manage'), validate(z.object({
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

router.patch('/milestones/:id', auth, permit('projects.manage'), validate(z.object({
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
router.get('/:id/completion', auth, permit('projects.view'), wrap(async (req, res) => {
  const project = await getOne(`SELECT p.*,c.name company FROM projects p
    JOIN companies c ON c.id=p.company_id WHERE p.id=?`, [req.params.id]);
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
      id: project.id, name: project.name, company: project.company, client: project.client, site: project.site, manager: project.manager,
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
router.post('/:id/team', auth, permit('projects.manage'), validate(z.object({
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
