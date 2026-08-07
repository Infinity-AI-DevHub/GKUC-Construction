import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';

const router = Router();
const CATEGORIES = ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead'];

const select = `SELECT b.id,b.reference,b.title,b.status,b.version,b.total,b.notes,b.project_id projectId,p.name project,
  u.name preparedBy,a.name approvedBy,b.approved_at approvedAt,b.created_at createdAt
  FROM boqs b JOIN projects p ON p.id=b.project_id JOIN users u ON u.id=b.prepared_by LEFT JOIN users a ON a.id=b.approved_by`;

const itemSchema = z.object({
  category: z.enum(CATEGORIES),
  description: z.string().min(2).max(300),
  unit: z.string().min(1).max(30),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  materialId: z.number().int().positive().optional()
});

router.get('/', auth, wrap(async (_req, res) => res.json(await query(`${select} ORDER BY b.id DESC`))));

router.get('/:id', auth, wrap(async (req, res) => {
  const boq = await getOne(`${select} WHERE b.id=?`, [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const [items, variations, actual] = await Promise.all([
    query('SELECT id,category,description,unit,quantity,rate,amount,material_id materialId FROM boq_items WHERE boq_id=? ORDER BY id', [boq.id]),
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

router.post('/', auth, permit(roles.qs), validate(z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(3).max(180),
  notes: z.string().max(1000).optional(),
  items: z.array(itemSchema).min(1)
})), wrap(async (req, res) => {
  const body = req.body;
  const reference = await nextReference('BOQ', 'boqs');
  const total = body.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const id = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO boqs (project_id,reference,title,total,prepared_by,notes) VALUES (?,?,?,?,?,?)',
      [body.projectId, reference, body.title, total, req.user.id, body.notes || null]);
    for (const item of body.items) {
      await connection.execute('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,material_id) VALUES (?,?,?,?,?,?,?,?)',
        [result.insertId, item.category, item.description, item.unit, item.quantity, item.rate, item.quantity * item.rate, item.materialId || null]);
    }
    await audit(connection, req.user.id, 'CREATE', 'boq', result.insertId, null, { reference, total }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${select} WHERE b.id=?`, [id]));
}));

router.post('/:id/items', auth, permit(roles.qs), validate(itemSchema), wrap(async (req, res) => {
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
router.patch('/:id', auth, permit(roles.manage), validate(z.object({
  status: z.enum(['Draft', 'Submitted', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'BOQ not found' });
  await transaction(async connection => {
    const approved = req.body.status === 'Approved';
    await connection.execute('UPDATE boqs SET status=?,approved_by=?,approved_at=? WHERE id=?',
      [req.body.status, approved ? req.user.id : null, approved ? new Date() : null, before.id]);
    if (approved) await connection.execute('UPDATE projects SET budget=? WHERE id=?', [before.total, before.project_id]);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'boq', before.id, before, { status: req.body.status }, req.ip);
  });
  if (req.body.status === 'Approved') {
    await notify({
      audience: 'Project Manager',
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
router.get('/variations/all', auth, wrap(async (_req, res) => res.json(await query(`SELECT v.id,v.reference,v.description,v.amount,v.status,
  v.created_at createdAt,p.name project,u.name raisedBy FROM variation_orders v JOIN projects p ON p.id=v.project_id
  JOIN users u ON u.id=v.raised_by ORDER BY v.id DESC`))));

router.post('/:id/variations', auth, permit(roles.qs), validate(z.object({
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

router.patch('/variations/:id', auth, permit(roles.manage), validate(z.object({
  status: z.enum(['Pending', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM variation_orders WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Variation order not found' });
  await transaction(async connection => {
    await connection.execute('UPDATE variation_orders SET status=?,approved_by=? WHERE id=?', [req.body.status, req.user.id, before.id]);
    /* An approved variation moves the approved budget, keeping budget-vs-actual honest. */
    if (req.body.status === 'Approved' && before.status !== 'Approved') {
      await connection.execute('UPDATE projects SET budget=budget+? WHERE id=?', [before.amount, before.project_id]);
    }
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'variation_order', before.id, before, { status: req.body.status }, req.ip);
  });
  res.json(await getOne('SELECT * FROM variation_orders WHERE id=?', [before.id]));
}));

export default router;
