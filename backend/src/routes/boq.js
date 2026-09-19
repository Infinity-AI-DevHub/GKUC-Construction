import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { optionsFor } from '../lib/options.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { assertUniqueManualEntry } from '../lib/ledger-duplicates.js';
import { boqDocument, documentContext } from '../lib/documents.js';
import { sendDocument } from '../lib/document-pdf.js';
import { notify } from '../alerts.js';

const router = Router();
/* Kept only as the fallback grouping for the cost comparison below; the values people
   may choose come from the option list, which the company maintains itself. */
const CATEGORIES = ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead'];

const select = `SELECT b.id,b.reference,b.title,b.status,b.version,b.total,b.notes,b.terms,b.project_id projectId,p.name project,p.client_id clientId,COALESCE(d.name,p.client) client,
  p.company_id companyId,c.name company,
  u.name preparedBy,a.name approvedBy,b.approved_at approvedAt,b.created_at createdAt
  FROM boqs b JOIN projects p ON p.id=b.project_id JOIN companies c ON c.id=p.company_id LEFT JOIN clients d ON d.id=p.client_id
  JOIN users u ON u.id=b.prepared_by LEFT JOIN users a ON a.id=b.approved_by`;

/**
 * A project's approved budget is the sum of its approved BOQ packages plus approved
 * variation orders. Projects with no approved BOQ keep the figure entered by hand,
 * so recalculating never wipes a budget that the estimating workflow does not own.
 */
async function recalculateBudget(connection, projectId) {
  const [rows] = await connection.execute(`SELECT
      (SELECT COUNT(*) FROM boqs WHERE project_id=? AND status='Approved') packages,
      (SELECT COALESCE(SUM(total),0) FROM boqs WHERE project_id=? AND status='Approved') boqTotal,
      (SELECT COALESCE(SUM(amount),0) FROM variation_orders WHERE project_id=? AND status='Approved') variations`,
  [projectId, projectId, projectId]);
  if (!rows[0].packages) return;
  await connection.execute('UPDATE projects SET budget=? WHERE id=?', [Number(rows[0].boqTotal) + Number(rows[0].variations), projectId]);
}

const itemSchema = z.object({
  category: z.string().trim().min(1).max(60),
  description: z.string().min(2).max(300),
  unit: z.string().min(1).max(30),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  materialId: z.number().int().positive().optional(),
  subcontractRateId:z.number().int().positive().optional()
});

/*
 * A bill arrives with all its lines at once, so each line's category is checked rather
 * than one field on the body. Same list, same message, applied across the array.
 */
const checkItemCategories = async (req, res, next) => {
  try {
    const allowed = await optionsFor('boq.category');
    const wrong = (req.body.items || []).find(item => !allowed.includes(item.category));
    if (wrong) {
      return res.status(400).json({
        error: `"${wrong.category}" is not one of the BOQ categories.`,
        issues: { fieldErrors: { category: [`Choose one of: ${allowed.join(', ')}`] } }
      });
    }
    next();
  } catch (error) { next(error); }
};

router.get('/', auth, permit('qs.view','qs.boq'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  res.json(await query(`${select} ${companyId > 0 ? 'WHERE p.company_id=?' : ''} ORDER BY b.id DESC`, companyId > 0 ? [companyId] : []));
}));

/** Live site cost control: approved estimate, daily actuals, forecasts and exceptions. */
router.get('/cost-control', auth, permit('qs.view','qs.boq','finance.view','finance.manage'), wrap(async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) return res.status(400).json({ error: 'Choose a project site' });
  const project = await getOne('SELECT id,name,site,budget,progress,health FROM projects WHERE id=? AND active=1', [projectId]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const [items, expenses, variations, daily, committed] = await Promise.all([
    query(`SELECT bi.id,bi.category,bi.description,bi.unit,bi.quantity,bi.rate,bi.amount expectedAmount,
      b.reference boqReference,b.title boqTitle,b.status boqStatus,
      f.forecast_quantity forecastQuantity,f.forecast_rate forecastRate,f.forecast_amount forecastAmount,f.reason forecastReason,
      COALESCE(SUM(e.amount),0) actualAmount,COALESCE(SUM(e.quantity),0) actualQuantity,COUNT(e.id) expenseCount
      FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
      LEFT JOIN project_cost_forecasts f ON f.boq_item_id=bi.id
      LEFT JOIN expenses e ON e.boq_item_id=bi.id
      WHERE b.project_id=? AND (b.status='Approved' OR NOT EXISTS
        (SELECT 1 FROM boqs approved WHERE approved.project_id=b.project_id AND approved.status='Approved'))
      GROUP BY bi.id,b.reference,b.title,b.status,f.forecast_quantity,f.forecast_rate,f.forecast_amount,f.reason
      ORDER BY b.id,bi.id`, [projectId]),
    query(`SELECT e.id,e.expense_date expenseDate,e.source,e.cost_type costType,e.description,e.amount,e.quantity,e.unit,e.unit_rate unitRate,
      e.reference,e.boq_item_id boqItemId,bi.description boqItem,u.name recordedBy
      FROM expenses e LEFT JOIN boq_items bi ON bi.id=e.boq_item_id JOIN users u ON u.id=e.created_by
      WHERE e.project_id=? ORDER BY e.expense_date DESC,e.id DESC LIMIT 1000`, [projectId]),
    query(`SELECT id,reference,description,amount,status,created_at createdAt FROM variation_orders
      WHERE project_id=? ORDER BY id DESC`, [projectId]),
    query(`SELECT expense_date expenseDate,SUM(amount) total,
      SUM(cost_type='Unexpected') unexpected,COUNT(*) entries FROM expenses WHERE project_id=?
      GROUP BY expense_date ORDER BY expense_date DESC LIMIT 120`, [projectId]),
    getOne(`SELECT COALESCE(SUM(total),0) total FROM purchase_orders
      WHERE project_id=? AND status<>'Cancelled'`, [projectId])
  ]);
  const number = value => Number(value || 0);
  const costItems = items.map(item => {
    const expected = number(item.expectedAmount); const actual = number(item.actualAmount);
    const forecast = item.forecastAmount === null ? expected : number(item.forecastAmount);
    const finalForecast = Math.max(forecast, actual);
    return { ...item, expectedAmount: expected, actualAmount: actual, forecastAmount: forecast,
      finalForecast, variance: actual - expected, forecastVariance: finalForecast - expected,
      variancePercent: expected ? Number(((actual - expected) / expected * 100).toFixed(1)) : (actual ? 100 : 0) };
  });
  const baseline = costItems.reduce((sum, item) => sum + item.expectedAmount, 0);
  const actual = expenses.reduce((sum, item) => sum + number(item.amount), 0);
  const approvedChanges = variations.filter(item => item.status === 'Approved').reduce((sum, item) => sum + number(item.amount), 0);
  const unexpected = expenses.filter(item => item.costType === 'Unexpected').reduce((sum, item) => sum + number(item.amount), 0);
  const unallocated = expenses.filter(item => !item.boqItemId).reduce((sum, item) => sum + number(item.amount), 0);
  /* Unlinked legacy costs are already part of actual-to-date. Adding them to the complete
     baseline would count the same expected work twice; explicit unexpected cost is the
     part that sits outside the approved estimate. */
  const forecast = Math.max(costItems.reduce((sum, item) => sum + item.finalForecast, 0) + unexpected, actual);
  const currentBudget = baseline ? baseline + approvedChanges : number(project.budget);
  const categories = [...costItems.reduce((map, item) => {
    const row = map.get(item.category) || { category: item.category, expected: 0, actual: 0, forecast: 0 };
    row.expected += item.expectedAmount; row.actual += item.actualAmount; row.forecast += item.finalForecast;
    map.set(item.category, row); return map;
  }, new Map()).values()];
  res.json({ project, summary: { baseline, approvedChanges, currentBudget, actual, unexpected, unallocated, committed: number(committed.total), forecast,
    actualVariance: actual - currentBudget, forecastVariance: forecast - currentBudget }, items: costItems, expenses, variations, daily, categories });
}));

router.post('/cost-control/expenses', auth, permit('qs.boq','finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  boqItemId: z.number().int().positive().nullable().optional(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().trim().min(1).max(60),
  costType: z.enum(['Expected','Variation','Unexpected']).default('Expected'),
  description: z.string().min(2).max(400),
  quantity: z.number().positive().nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  unitRate: z.number().nonnegative().nullable().optional(),
  amount: z.number().positive().optional(),
  reference: z.string().max(120).nullable().optional()
}).refine(value => value.amount || (value.quantity && value.unitRate !== undefined && value.unitRate !== null), {
  message: 'Enter an amount, or enter quantity and unit rate', path: ['amount']
})), fromOptions({ source: 'expense.source' }), wrap(async (req, res) => {
  const body = req.body;
  if (body.boqItemId) {
    const item = await getOne(`SELECT bi.id FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
      WHERE bi.id=? AND b.project_id=?`, [body.boqItemId, body.projectId]);
    if (!item) return res.status(400).json({ error: 'That BOQ item does not belong to this project' });
  }
  const amount = body.amount || Number((body.quantity * body.unitRate).toFixed(2));
  const result = await transaction(async connection => {
    await assertUniqueManualEntry(connection, 'expenses', { projectId: body.projectId, reference: body.reference,
      amount, date: body.expenseDate, description: body.description });
    const [inserted] = await connection.execute(`INSERT INTO expenses
    (project_id,boq_item_id,source,cost_type,description,amount,quantity,unit,unit_rate,expense_date,reference,origin_type,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'QS daily cost',?)`, [body.projectId, body.boqItemId || null, body.source, body.costType,
    body.description, amount, body.quantity || null, body.unit || null, body.unitRate ?? null, body.expenseDate, body.reference?.trim() || null, req.user.id]);
    return inserted;
  });
  const row = await getOne('SELECT * FROM expenses WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'project_cost', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/cost-control/expenses/:id', auth, permit('qs.boq','finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  boqItemId: z.number().int().positive(),
  costType: z.enum(['Expected','Variation','Unexpected']).default('Expected'),
  reason: z.string().min(3).max(600)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM expenses WHERE id=? AND project_id=?', [req.params.id, req.body.projectId]);
  if (!before) return res.status(404).json({ error: 'Project expense not found' });
  const item = await getOne(`SELECT bi.id FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
    WHERE bi.id=? AND b.project_id=?`, [req.body.boqItemId, req.body.projectId]);
  if (!item) return res.status(400).json({ error: 'That BOQ item does not belong to this project' });
  await query('UPDATE expenses SET boq_item_id=?,cost_type=? WHERE id=?', [item.id, req.body.costType, before.id]);
  const after = await getOne('SELECT * FROM expenses WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'ALLOCATE', 'project_cost', before.id, before, { ...after, allocationReason: req.body.reason }, req.ip);
  res.json(after);
}));

router.patch('/cost-control/items/:itemId/forecast', auth, permit('qs.boq'), validate(z.object({
  projectId: z.number().int().positive(),
  forecastQuantity: z.number().positive().nullable().optional(),
  forecastRate: z.number().nonnegative().nullable().optional(),
  forecastAmount: z.number().nonnegative(),
  reason: z.string().min(3).max(600)
})), wrap(async (req, res) => {
  const item = await getOne(`SELECT bi.id,bi.amount FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
    WHERE bi.id=? AND b.project_id=?`, [req.params.itemId, req.body.projectId]);
  if (!item) return res.status(404).json({ error: 'BOQ cost item not found' });
  const before = await getOne('SELECT * FROM project_cost_forecasts WHERE boq_item_id=?', [item.id]);
  await query(`INSERT INTO project_cost_forecasts
    (project_id,boq_item_id,forecast_quantity,forecast_rate,forecast_amount,reason,updated_by)
    VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE forecast_quantity=VALUES(forecast_quantity),forecast_rate=VALUES(forecast_rate),
    forecast_amount=VALUES(forecast_amount),reason=VALUES(reason),updated_by=VALUES(updated_by)`,
  [req.body.projectId, item.id, req.body.forecastQuantity ?? null, req.body.forecastRate ?? null,
    req.body.forecastAmount, req.body.reason, req.user.id]);
  const after = await getOne('SELECT * FROM project_cost_forecasts WHERE boq_item_id=?', [item.id]);
  await audit(pool, req.user.id, 'FORECAST', 'boq_item', item.id, before, after, req.ip);
  res.json(after);
}));

/** The bill as a document — for issuing, filing with a tender, or signing off. */
router.get('/:id/document', auth, permit('qs.view', 'qs.boq'), wrap(async (req, res) => {
  const boq = await getOne(`${select} WHERE b.id=?`, [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });

  const [items, variations, context] = await Promise.all([
    query(`SELECT category,description,unit,quantity,rate,amount,method FROM boq_items
      WHERE boq_id=? ORDER BY id`, [boq.id]),
    query(`SELECT reference,description,amount,status FROM variation_orders
      WHERE boq_id=? ORDER BY id`, [boq.id]),
    documentContext(getOne, boq.companyId)
  ]);

  await sendDocument(req, res, boqDocument({ ...context, boq, items, variations }), `${boq.reference}.pdf`);
}));

router.get('/:id', auth, permit('qs.view','qs.boq'), wrap(async (req, res) => {
  const boq = await getOne(`${select} WHERE b.id=?`, [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const [items, variations, actual] = await Promise.all([
    query('SELECT id,category,description,unit,quantity,rate,amount,method,notes,material_id materialId FROM boq_items WHERE boq_id=? ORDER BY id', [boq.id]),
    query(`SELECT v.id,v.reference,v.description,v.amount,v.status,u.name raisedBy FROM variation_orders v
      JOIN users u ON u.id=v.raised_by WHERE v.boq_id=? ORDER BY v.id DESC`, [boq.id]),
    query(`SELECT source,COALESCE(SUM(amount),0) total FROM expenses WHERE project_id=? GROUP BY source`, [boq.projectId])
  ]);
  /* Estimate against actual, by category — PID 2.5 "Final Cost Analysis". */
  const spentBySource = Object.fromEntries(actual.map(row => [row.source, Number(row.total)]));
  const comparison = CATEGORIES.map(category => {
    const estimated = items.filter(item => item.category === category).reduce((sum, item) => sum + Number(item.amount), 0);
    const sourceKey = { Subcontract: 'Subcontractor', Overhead: 'Overhead' }[category] || category;
    return { category, estimated, actual: spentBySource[sourceKey] || 0 };
  });
  res.json({ ...boq, items, variations, comparison });
}));

router.post('/', auth, permit('qs.boq'), validate(z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(3).max(180),
  notes: z.string().max(1000).optional(),
  items: z.array(itemSchema).min(1)
})), checkItemCategories, wrap(async (req, res) => {
  const body = req.body;
  const priced=[];
  for(const item of body.items){
    if(item.subcontractRateId){
      if(item.category!=='Subcontract')return res.status(400).json({error:'A subcontract rate can only price a subcontract BOQ line'});
      const rate=await getOne('SELECT * FROM subcontractor_project_rates WHERE id=? AND project_id=?',
        [item.subcontractRateId,body.projectId]);
      if(!rate)return res.status(400).json({error:'That agreed subcontract rate does not belong to this project'});
      priced.push({...item,rate:Number(rate.rate),unit:rate.unit});
    }else priced.push(item);
  }
  const reference = await nextReference('BOQ', 'boqs');
  const total = priced.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const id = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO boqs (project_id,reference,title,total,prepared_by,notes) VALUES (?,?,?,?,?,?)',
      [body.projectId, reference, body.title, total, req.user.id, body.notes || null]);
    for (const item of priced) {
      await connection.execute('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,material_id,subcontract_rate_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [result.insertId, item.category, item.description, item.unit, item.quantity, item.rate, item.quantity * item.rate, item.materialId || null,item.subcontractRateId||null]);
    }
    await audit(connection, req.user.id, 'CREATE', 'boq', result.insertId, null, { reference, total }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${select} WHERE b.id=?`, [id]));
}));

router.post('/:id/items', auth, permit('qs.boq'), validate(itemSchema),
  fromOptions({ category: 'boq.category' }), wrap(async (req, res) => {
  const boq = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  if (boq.status === 'Approved') return res.status(409).json({ error: 'An approved BOQ cannot be edited — raise a variation order instead' });
  const item = req.body;
  await query('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,material_id) VALUES (?,?,?,?,?,?,?,?)',
    [boq.id, item.category, item.description, item.unit, item.quantity, item.rate, item.quantity * item.rate, item.materialId || null]);
  await query('UPDATE boqs SET total=(SELECT COALESCE(SUM(amount),0) FROM boq_items WHERE boq_id=?) WHERE id=?', [boq.id, boq.id]);
  res.status(201).json(await getOne(`${select} WHERE b.id=?`, [boq.id]));
}));

/**
 * Approving a BOQ writes its total onto the project budget, so estimates and actual
 * costs are afterwards tracked in the same place instead of a separate spreadsheet.
 */
/**
 * The wording on the printed bill — its title, notes and any terms particular to this job.
 *
 * Separate from the status route because approving a BOQ and correcting a heading are
 * different acts by different people: preparing is the QS's, approving is not. Once
 * approved the wording is fixed, since the document has become the agreed record.
 */
router.patch('/:id/wording', auth, permit('qs.boq'), validate(z.object({
  title: z.string().min(3).max(180).optional(),
  notes: z.string().max(1000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })),
wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'BOQ not found' });
  if (before.status === 'Approved') {
    return res.status(409).json({ error: 'An approved BOQ cannot be reworded. Raise a revision instead.' });
  }

  const columns = { title: 'title', notes: 'notes', terms: 'terms' };
  const edits = Object.entries(columns).filter(([key]) => req.body[key] !== undefined);
  await query(`UPDATE boqs SET ${edits.map(([, column]) => `${column}=?`).join(',')} WHERE id=?`,
    [...edits.map(([key]) => req.body[key]), before.id]);

  const after = await getOne(`${select} WHERE b.id=?`, [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'boq', before.id, before, after, req.ip);
  res.json(after);
}));

router.patch('/:id', auth, permit('qs.approve'), validate(z.object({
  status: z.enum(['Draft', 'Submitted', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'BOQ not found' });
  await transaction(async connection => {
    const approved = req.body.status === 'Approved';
    await connection.execute('UPDATE boqs SET status=?,approved_by=?,approved_at=? WHERE id=?',
      [req.body.status, approved ? req.user.id : null, approved ? new Date() : null, before.id]);
    await recalculateBudget(connection, before.project_id);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'boq', before.id, before, { status: req.body.status }, req.ip);
  });
  if (req.body.status === 'Approved') {
    await notify({
      audience: 'qs.view',
      severity: 'Info',
      title: `BOQ ${before.reference} approved`,
      message: 'The approved BOQ total is now the project budget. Actual costs are tracked against it from here.',
      referenceType: 'boq',
      referenceId: before.id
    });
  }
  res.json(await getOne(`${select} WHERE b.id=?`, [before.id]));
}));

/* Variation orders */
router.get('/variations/all', auth, permit('qs.view','qs.boq'), wrap(async (_req, res) => res.json(await query(`SELECT v.id,v.reference,v.description,v.amount,v.status,
  v.created_at createdAt,p.name project,u.name raisedBy FROM variation_orders v JOIN projects p ON p.id=v.project_id
  JOIN users u ON u.id=v.raised_by ORDER BY v.id DESC`))));

router.post('/:id/variations', auth, permit('qs.boq'), validate(z.object({
  description: z.string().min(3).max(600),
  amount: z.number()
})), wrap(async (req, res) => {
  const boq = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const reference = await nextReference('VO', 'variation_orders');
  const result = await query('INSERT INTO variation_orders (project_id,boq_id,reference,description,amount,raised_by) VALUES (?,?,?,?,?,?)',
    [boq.project_id, boq.id, reference, req.body.description, req.body.amount, req.user.id]);
  const row = await getOne('SELECT * FROM variation_orders WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'variation_order', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/variations/:id', auth, permit('qs.approve'), validate(z.object({
  status: z.enum(['Pending', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM variation_orders WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Variation order not found' });
  await transaction(async connection => {
    await connection.execute('UPDATE variation_orders SET status=?,approved_by=? WHERE id=?', [req.body.status, req.user.id, before.id]);
    /* An approved variation moves the approved budget, keeping budget-vs-actual honest. */
    await recalculateBudget(connection, before.project_id);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'variation_order', before.id, before, { status: req.body.status }, req.ip);
  });
  res.json(await getOne('SELECT * FROM variation_orders WHERE id=?', [before.id]));
}));

export default router;
