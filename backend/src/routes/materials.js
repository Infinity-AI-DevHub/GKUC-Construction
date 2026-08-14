import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { stockState } from './bootstrap.js';

const router = Router();

/** Receipts and returns add to stock; issues, transfers and negative adjustments remove from it. */
const INBOUND = ['Receipt', 'Return'];

router.get('/', auth, wrap(async (_req, res) => {
  const materials = await query('SELECT * FROM materials WHERE active=1 ORDER BY id');
  res.json(materials.map(material => ({ ...material, state: stockState(material) })));
}));

router.get('/movements', auth, wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.materialId) { filters.push('m.material_id=?'); params.push(req.query.materialId); }
  if (req.query.projectId) { filters.push('m.project_id=?'); params.push(req.query.projectId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT m.id,m.movement_type type,m.quantity,m.reference,m.notes,m.destination,m.created_at createdAt,
    mat.name material,mat.unit,u.name recordedBy,p.name project
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN users u ON u.id=m.user_id
    LEFT JOIN projects p ON p.id=m.project_id ${where} ORDER BY m.id DESC LIMIT 200`, params));
}));

router.post('/', auth, permit('store.manage'), validate(z.object({
  name: z.string().min(2).max(180),
  unit: z.string().min(1).max(30),
  stock: z.number().nonnegative().default(0),
  minimum: z.number().nonnegative(),
  site: z.string().min(2).max(180),
  unitCost: z.number().nonnegative().default(0),
  supplier: z.string().max(180).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO materials (name,unit,stock,minimum,site,supplier,unit_cost) VALUES (?,?,?,?,?,?,?)',
    [body.name, body.unit, body.stock, body.minimum, body.site, body.supplier || null, body.unitCost]);
  const row = await getOne('SELECT * FROM materials WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'material', row.id, null, row, req.ip);
  res.status(201).json({ ...row, state: stockState(row) });
}));

router.patch('/:id', auth, permit('store.manage'), validate(z.object({
  minimum: z.number().nonnegative().optional(),
  site: z.string().min(2).max(180).optional(),
  unitCost: z.number().nonnegative().optional(),
  supplier: z.string().max(180).optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM materials WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Material not found' });
  const columns = { unitCost: 'unit_cost' };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE materials SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), req.params.id]);
  }
  const after = await getOne('SELECT * FROM materials WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'material', after.id, before, after, req.ip);
  res.json({ ...after, state: stockState(after) });
}));

/**
 * Stock movements are transactional: the balance, the movement row and the audit entry
 * either all commit or none do, so recorded stock can never drift from its history.
 */
router.post('/:id/movements', auth, permit('store.manage'), validate(z.object({
  type: z.enum(['Receipt', 'Issue', 'Return', 'Adjustment', 'Transfer']),
  quantity: z.number().positive().max(1000000),
  reference: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  projectId: z.number().int().positive().optional(),
  destination: z.string().max(180).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const after = await transaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM materials WHERE id=? FOR UPDATE', [req.params.id]);
      const before = rows[0];
      if (!before) throw Object.assign(new Error('Material not found'), { status: 404 });
      const direction = INBOUND.includes(body.type) ? 1 : -1;
      const stock = Number(before.stock) + direction * body.quantity;
      if (stock < 0) throw Object.assign(new Error('Insufficient stock for this movement'), { status: 409 });
      await connection.execute('UPDATE materials SET stock=? WHERE id=?', [stock, before.id]);
      await connection.execute(`INSERT INTO stock_movements (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id)
        VALUES (?,?,?,?,?,?,?,?)`, [before.id, body.type, body.quantity, body.reference || '', body.notes || '',
        body.projectId || null, body.destination || null, req.user.id]);

      /* Issuing material to a project is a project cost, so record it against the budget straight away. */
      if (body.type === 'Issue' && body.projectId && Number(before.unit_cost) > 0) {
        await connection.execute(`INSERT INTO expenses (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
          VALUES (?,'Material',?,?,CURDATE(),?, 'stock_movement', ?, ?)`,
        [body.projectId, `${before.name} issued to site (${body.quantity} ${before.unit})`,
          body.quantity * Number(before.unit_cost), body.reference || '', String(before.id), req.user.id]);
      }

      const updated = { ...before, stock };
      await audit(connection, req.user.id, 'STOCK_MOVEMENT', 'material', before.id, before, updated, req.ip);
      return updated;
    });
    res.status(201).json({ ...after, state: stockState(after) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

export default router;
