import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const select = `SELECT e.id,e.code,e.name,e.category,e.status,e.purchase_date purchaseDate,e.purchase_cost purchaseCost,e.notes,e.qr_token qrToken,
  (SELECT p.name FROM equipment_assignments a JOIN projects p ON p.id=a.project_id
    WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) project,
  (SELECT a.assigned_to FROM equipment_assignments a WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) holder,
  (SELECT a.due_back FROM equipment_assignments a WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) dueBack,
  (SELECT DATEDIFF(CURDATE(), a.due_back) FROM equipment_assignments a
    WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) daysOverdue
  FROM equipment e`;

router.get('/', auth, permit('store.view','store.manage'), wrap(async (_req, res) => res.json(await query(`${select} ORDER BY e.code`))));

/**
 * PID 2.9 "QR Code Support". Each asset carries an opaque token; a label printed with
 * that token resolves to the asset here, so a phone camera on site answers "what is this
 * and who has it" without anyone typing an asset code.
 */
router.get('/scan/:token', auth, permit('store.view','store.manage','store.lending'), wrap(async (req, res) => {
  const item = await getOne(`${select} WHERE e.qr_token=?`, [req.params.token]);
  if (!item) return res.status(404).json({ error: 'No equipment matches that code' });
  res.json(item);
}));

/** Issues (or reissues) the token behind an asset's printed label. */
router.post('/:id/qr', auth, permit('store.lending'), wrap(async (req, res) => {
  const item = await getOne('SELECT * FROM equipment WHERE id=?', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Equipment not found' });
  const token = crypto.randomBytes(16).toString('hex');
  await query('UPDATE equipment SET qr_token=? WHERE id=?', [token, item.id]);
  await audit(pool, req.user.id, 'QR_ISSUED', 'equipment', item.id, { qrToken: item.qr_token }, { qrToken: token }, req.ip);
  res.json({ id: item.id, code: item.code, qrToken: token });
}));

router.get('/:id', auth, permit('store.view','store.manage'), wrap(async (req, res) => {
  const item = await getOne(`${select} WHERE e.id=?`, [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Equipment not found' });
  const [assignments, maintenance] = await Promise.all([
    query(`SELECT a.id,a.assigned_to assignedTo,a.assigned_at assignedAt,a.returned_at returnedAt,a.due_back dueBack,
      a.issued_condition issuedCondition,a.returned_condition returnedCondition,a.condition_note conditionNote,p.name project
      FROM equipment_assignments a JOIN projects p ON p.id=a.project_id WHERE a.equipment_id=? ORDER BY a.id DESC`, [item.id]),
    query('SELECT id,maintenance_type maintenanceType,performed_at performedAt,cost,notes FROM equipment_maintenance WHERE equipment_id=? ORDER BY performed_at DESC', [item.id])
  ]);
  res.json({ ...item, assignments, maintenance });
}));

router.post('/', auth, permit('store.lending'), validate(z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(180),
  category: z.string().min(2).max(100),
  status: z.enum(['Available', 'Assigned', 'Maintenance', 'Retired']).default('Available'),
  purchaseDate: isoDate.optional(),
  purchaseCost: z.number().nonnegative().default(0),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query('INSERT INTO equipment (code,name,category,status,purchase_date,purchase_cost,notes) VALUES (?,?,?,?,?,?,?)',
      [body.code, body.name, body.category, body.status, body.purchaseDate || null, body.purchaseCost, body.notes || null]);
    const row = await getOne(`${select} WHERE e.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'equipment', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That equipment code is already in use' });
    throw error;
  }
}));

/** Assigning marks the asset as held by a site, so it cannot be double-committed. */
router.post('/:id/assign', auth, permit('store.lending'), validate(z.object({
  projectId: z.number().int().positive(),
  assignedTo: z.string().min(2).max(120),
  assignedAt: isoDate,
  dueBack: isoDate.optional(),
  issuedCondition: z.string().max(60).optional(),
  conditionNote: z.string().max(500).optional()
})), wrap(async (req, res) => {
  try {
    const id = await transaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM equipment WHERE id=? FOR UPDATE', [req.params.id]);
      const item = rows[0];
      if (!item) throw Object.assign(new Error('Equipment not found'), { status: 404 });
      if (item.status === 'Retired') throw Object.assign(new Error('Retired equipment cannot be assigned'), { status: 409 });

      /*
       * Whether the asset is out is decided by the lending record, not by the status column.
       *
       * The status is a summary kept for the register to read quickly, and a summary can
       * drift — a return that half-succeeded, or a reassignment written straight into the
       * table, leaves an asset marked Available while its previous lending is still open.
       * Trusting it let the same tool go out to two sites at once, and every screen that
       * lists equipment then showed it twice. The open lending is the fact; the status is
       * repaired from it below.
       */
      const [[open]] = await connection.execute(
        `SELECT a.id, a.assigned_to assignedTo, a.assigned_at assignedAt, p.name project
           FROM equipment_assignments a LEFT JOIN projects p ON p.id=a.project_id
          WHERE a.equipment_id=? AND a.returned_at IS NULL
          ORDER BY a.id DESC LIMIT 1`, [item.id]);
      if (open) {
        if (item.status !== 'Assigned') {
          await connection.execute("UPDATE equipment SET status='Assigned' WHERE id=?", [item.id]);
        }
        throw Object.assign(new Error(
          `This equipment is already out${open.project ? ` on ${open.project}` : ''}`
          + `${open.assignedTo ? ` with ${open.assignedTo}` : ''}. Record its return first.`), { status: 409 });
      }
      if (req.body.dueBack && req.body.dueBack < req.body.assignedAt) {
        throw Object.assign(new Error('The due-back date cannot be before the day it goes out'), { status: 400 });
      }
      const [result] = await connection.execute(`INSERT INTO equipment_assignments
        (equipment_id,project_id,assigned_to,assigned_at,due_back,issued_condition,condition_note,created_by)
        VALUES (?,?,?,?,?,?,?,?)`, [item.id, req.body.projectId, req.body.assignedTo, req.body.assignedAt,
        req.body.dueBack || null, req.body.issuedCondition || null, req.body.conditionNote || null, req.user.id]);
      await connection.execute("UPDATE equipment SET status='Assigned' WHERE id=?", [item.id]);
      await audit(connection, req.user.id, 'ASSIGN', 'equipment', item.id, item, req.body, req.ip);
      return result.insertId;
    });
    res.status(201).json(await getOne('SELECT * FROM equipment_assignments WHERE id=?', [id]));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

router.post('/:id/return', auth, permit('store.lending'), validate(z.object({
  returnedAt: isoDate,
  returnedCondition: z.string().max(60).optional(),
  conditionNote: z.string().max(500).optional(),
  status: z.enum(['Available', 'Maintenance', 'Retired']).default('Available')
})), wrap(async (req, res) => {
  const open = await getOne('SELECT * FROM equipment_assignments WHERE equipment_id=? AND returned_at IS NULL ORDER BY id DESC LIMIT 1', [req.params.id]);
  if (!open) return res.status(409).json({ error: 'This equipment is not currently assigned' });
  await query(`UPDATE equipment_assignments
    SET returned_at=?, returned_condition=COALESCE(?,returned_condition),
        condition_note=COALESCE(?,condition_note) WHERE id=?`,
  [req.body.returnedAt, req.body.returnedCondition || null, req.body.conditionNote || null, open.id]);
  await query('UPDATE equipment SET status=? WHERE id=?', [req.body.status, req.params.id]);
  await audit(pool, req.user.id, 'RETURN', 'equipment', req.params.id, open, req.body, req.ip);
  res.json(await getOne(`${select} WHERE e.id=?`, [req.params.id]));
}));

router.post('/:id/maintenance', auth, permit('store.lending'), validate(z.object({
  maintenanceType: z.string().trim().min(1).max(60),
  performedAt: isoDate,
  cost: z.number().nonnegative().default(0),
  notes: z.string().max(600).optional(),
  setStatus: z.enum(['Available', 'Maintenance']).optional()
})), fromOptions({ maintenanceType: 'vehicle.maintenance' }), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO equipment_maintenance (equipment_id,maintenance_type,performed_at,cost,notes,created_by) VALUES (?,?,?,?,?,?)',
    [req.params.id, body.maintenanceType, body.performedAt, body.cost, body.notes || null, req.user.id]);
  if (body.setStatus) await query('UPDATE equipment SET status=? WHERE id=?', [body.setStatus, req.params.id]);
  const row = await getOne('SELECT * FROM equipment_maintenance WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'equipment_maintenance', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

export default router;
