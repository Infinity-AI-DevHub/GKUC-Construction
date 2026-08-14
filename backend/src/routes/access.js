import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, permissionsFor, permit, validate, wrap } from '../lib/http.js';
import { DEPARTMENTS, PERMISSIONS, isPermission } from '../lib/permissions.js';

const router = Router();

/**
 * PID v3 §2.2 — "a simple settings screen showing every role and every permission as a
 * toggle. Turning something on or off for a role takes effect immediately."
 *
 * Permissions are read on every request from the database, so a change here applies to the
 * next action the affected person takes. Nothing is cached and no restart is involved.
 */

const roleSelect = `SELECT r.id,r.name,r.description,r.is_system isSystem,
  (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) users
  FROM roles r`;

/** The catalogue the toggle screen is drawn from. */
router.get('/permissions', auth, permit('admin.roles'), (_req, res) => res.json({
  departments: DEPARTMENTS.filter(department => PERMISSIONS.some(item => item.department === department)),
  permissions: PERMISSIONS
}));

router.get('/roles', auth, permit('admin.roles'), wrap(async (_req, res) => {
  const [roles, grants] = await Promise.all([
    query(`${roleSelect} ORDER BY r.is_system DESC, r.name`),
    query('SELECT role_id roleId,permission_key permissionKey FROM role_permissions')
  ]);
  res.json(roles.map(role => ({
    ...role,
    isSystem: Boolean(role.isSystem),
    permissions: grants.filter(grant => grant.roleId === role.id).map(grant => grant.permissionKey)
  })));
}));

router.post('/roles', auth, permit('admin.roles'), validate(z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(400).optional(),
  permissions: z.array(z.string()).default([])
})), wrap(async (req, res) => {
  const invalid = req.body.permissions.filter(key => !isPermission(key));
  if (invalid.length) return res.status(400).json({ error: `Unknown permission: ${invalid.join(', ')}` });
  try {
    const result = await query('INSERT INTO roles (name,description) VALUES (?,?)',
      [req.body.name, req.body.description || null]);
    for (const key of req.body.permissions) {
      await query('INSERT IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', [result.insertId, key]);
    }
    await audit(pool, req.user.id, 'CREATE', 'role', result.insertId, null, req.body, req.ip);
    res.status(201).json(await getOne(`${roleSelect} WHERE r.id=?`, [result.insertId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A role with that name already exists' });
    throw error;
  }
}));

/** Toggling one permission on a role — the two-tap change the PID describes. */
router.patch('/roles/:id/permissions', auth, permit('admin.roles'), validate(z.object({
  permission: z.string(),
  granted: z.boolean()
})), wrap(async (req, res) => {
  const role = await getOne('SELECT * FROM roles WHERE id=?', [req.params.id]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (!isPermission(req.body.permission)) return res.status(400).json({ error: 'Unknown permission' });
  if (role.is_system && !req.body.granted) {
    return res.status(409).json({ error: 'The Managing Director role always holds every permission' });
  }

  if (req.body.granted) {
    await query('INSERT IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', [role.id, req.body.permission]);
  } else {
    await query('DELETE FROM role_permissions WHERE role_id=? AND permission_key=?', [role.id, req.body.permission]);
  }
  await audit(pool, req.user.id, req.body.granted ? 'GRANT' : 'REVOKE', 'role', role.id,
    null, { role: role.name, permission: req.body.permission }, req.ip);
  const permissions = await query('SELECT permission_key FROM role_permissions WHERE role_id=?', [role.id]);
  res.json({ id: role.id, name: role.name, permissions: permissions.map(row => row.permission_key) });
}));

router.patch('/roles/:id', auth, permit('admin.roles'), validate(z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const role = await getOne('SELECT * FROM roles WHERE id=?', [req.params.id]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system && req.body.name) return res.status(409).json({ error: 'The Managing Director role cannot be renamed' });
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE roles SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), role.id]);
    /* users.role mirrors the role name for display and alert audiences. */
    if (req.body.name) await query('UPDATE users SET role=? WHERE role_id=?', [req.body.name, role.id]);
  }
  await audit(pool, req.user.id, 'UPDATE', 'role', role.id, role, req.body, req.ip);
  res.json(await getOne(`${roleSelect} WHERE r.id=?`, [role.id]));
}));

router.delete('/roles/:id', auth, permit('admin.roles'), wrap(async (req, res) => {
  const role = await getOne('SELECT * FROM roles WHERE id=?', [req.params.id]);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(409).json({ error: 'The Managing Director role cannot be deleted' });
  const [{ count }] = await query('SELECT COUNT(*) count FROM users WHERE role_id=?', [role.id]);
  if (count) return res.status(409).json({ error: `${count} user(s) still hold this role. Move them first.` });
  await query('DELETE FROM roles WHERE id=?', [role.id]);
  await audit(pool, req.user.id, 'DELETE', 'role', role.id, role, null, req.ip);
  res.status(204).end();
}));

/** Moving a person to a different role. */
router.patch('/users/:id/role', auth, permit('admin.users'), validate(z.object({
  roleId: z.number().int().positive()
})), wrap(async (req, res) => {
  const [user, role] = await Promise.all([
    getOne('SELECT id,name,role,role_id FROM users WHERE id=?', [req.params.id]),
    getOne('SELECT * FROM roles WHERE id=?', [req.body.roleId])
  ]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!role) return res.status(404).json({ error: 'Role not found' });
  await query('UPDATE users SET role_id=?, role=? WHERE id=?', [role.id, role.name, user.id]);
  await audit(pool, req.user.id, 'ROLE_CHANGE', 'user', user.id, { role: user.role }, { role: role.name }, req.ip);
  res.json(await getOne('SELECT id,name,email,role,role_id roleId,active FROM users WHERE id=?', [user.id]));
}));

/**
 * Delegation (PID v3 §2.2) — the MD hands one authority to one person, optionally until a
 * date, without changing that person's role or anybody else's.
 */
router.get('/users/:id/permissions', auth, permit('admin.roles'), wrap(async (req, res) => {
  const user = await getOne('SELECT id,name,role,role_id FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const [fromRole, delegated] = await Promise.all([
    user.role_id ? query('SELECT permission_key FROM role_permissions WHERE role_id=?', [user.role_id]) : [],
    query(`SELECT p.id,p.permission_key permissionKey,p.effect,p.reason,p.expires_at expiresAt,u.name grantedBy,p.created_at createdAt
           FROM user_permissions p JOIN users u ON u.id=p.granted_by WHERE p.user_id=? ORDER BY p.id DESC`, [req.params.id])
  ]);
  res.json({
    user: { id: user.id, name: user.name, role: user.role },
    fromRole: fromRole.map(row => row.permission_key),
    delegated,
    effective: await permissionsFor(user.id, user.role_id)
  });
}));

router.post('/users/:id/permissions', auth, permit('admin.roles'), validate(z.object({
  permission: z.string(),
  effect: z.enum(['Grant', 'Revoke']).default('Grant'),
  reason: z.string().max(400).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
})), wrap(async (req, res) => {
  if (!isPermission(req.body.permission)) return res.status(400).json({ error: 'Unknown permission' });
  const user = await getOne('SELECT id,name FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await query(`INSERT INTO user_permissions (user_id,permission_key,effect,reason,expires_at,granted_by)
    VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE effect=VALUES(effect),reason=VALUES(reason),
    expires_at=VALUES(expires_at),granted_by=VALUES(granted_by)`,
  [user.id, req.body.permission, req.body.effect, req.body.reason || null, req.body.expiresAt || null, req.user.id]);
  await audit(pool, req.user.id, 'DELEGATE', 'user', user.id, null,
    { permission: req.body.permission, effect: req.body.effect, expiresAt: req.body.expiresAt || null }, req.ip);
  res.status(201).json(await getOne(`SELECT id,permission_key permissionKey,effect,reason,expires_at expiresAt
    FROM user_permissions WHERE user_id=? AND permission_key=?`, [user.id, req.body.permission]));
}));

router.delete('/users/:id/permissions/:permission', auth, permit('admin.roles'), wrap(async (req, res) => {
  await query('DELETE FROM user_permissions WHERE user_id=? AND permission_key=?', [req.params.id, req.params.permission]);
  await audit(pool, req.user.id, 'DELEGATE_REVOKED', 'user', req.params.id, null, { permission: req.params.permission }, req.ip);
  res.status(204).end();
}));

export default router;
