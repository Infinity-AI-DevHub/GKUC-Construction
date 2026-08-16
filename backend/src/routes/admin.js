import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, hashPassword, pool, query } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { runAlertScan } from '../alerts.js';


const router = Router();

/* Users and access (PID 2.14) */
router.get('/users', auth, permit('admin.users'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,email,role,role_id roleId,active,created_at createdAt FROM users ORDER BY name'))));

router.get('/users/roles', auth, permit('admin.users', 'admin.roles'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,description FROM roles ORDER BY is_system DESC, name'))));

router.post('/users', auth, permit('admin.users'), validate(z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(10),
  roleId: z.number().int().positive()
})), wrap(async (req, res) => {
  const body = req.body;
  const role = await getOne('SELECT id,name FROM roles WHERE id=?', [body.roleId]);
  if (!role) return res.status(400).json({ error: 'Unknown role' });
  const result = await query('INSERT INTO users (name,email,password_hash,role,role_id) VALUES (?,?,?,?,?)',
    [body.name, body.email.toLowerCase(), hashPassword(body.password), role.name, role.id]);
  const row = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'user', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/users/:id', auth, permit('admin.users'), validate(z.object({
  active: z.boolean().optional(),
  password: z.string().min(10).optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'User not found' });
  if (Number(req.params.id) === req.user.id && req.body.active === false) {
    return res.status(409).json({ error: 'You cannot deactivate your own account' });
  }
  if (req.body.active !== undefined) {
    await query('UPDATE users SET active=? WHERE id=?', [req.body.active, req.params.id]);
    if (!req.body.active) await query('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
  }
  if (req.body.password) {
    await query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(req.body.password), req.params.id]);
    await query('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
  }
  const after = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'user', after.id, before, after, req.ip);
  res.json(after);
}));

/* Immutable audit trail */
router.get('/audit', auth, permit('admin.users'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.entity) { filters.push('a.entity=?'); params.push(req.query.entity); }
  if (req.query.action) { filters.push('a.action=?'); params.push(req.query.action); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT a.id,u.name user,a.action,a.entity,a.entity_id entityId,a.ip_address ip,a.created_at createdAt
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.id DESC LIMIT 500`, params));
}));

/* Notification centre */
router.get('/notifications', auth, wrap(async (req, res) => {
  res.json(await query(`SELECT id,title,message,severity,status,channel,reference_type referenceType,reference_id referenceId,created_at createdAt
    FROM notifications WHERE user_id IS NULL OR user_id=? OR audience=? ORDER BY id DESC LIMIT 100`, [req.user.id, req.user.role]));
}));

router.post('/notifications/:id/read', auth, wrap(async (req, res) => {
  await query("UPDATE notifications SET status='Read' WHERE id=? AND (user_id IS NULL OR user_id=? OR audience IN (?))",
    [req.params.id, req.user.id, req.user.permissions.length ? req.user.permissions : ['']]);
  res.status(204).end();
}));

router.post('/notifications/read-all', auth, wrap(async (req, res) => {
  await query("UPDATE notifications SET status='Read' WHERE status<>'Read' AND (user_id IS NULL OR user_id=? OR audience IN (?))",
    [req.user.id, req.user.permissions.length ? req.user.permissions : ['']]);
  res.status(204).end();
}));

/** Manual trigger for the deadline/threshold scan; it also runs on a schedule. */
router.post('/notifications/scan', auth, permit('admin.users'), wrap(async (_req, res) => {
  res.json({ raised: await runAlertScan() });
}));

export default router;
