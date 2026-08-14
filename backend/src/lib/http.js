import crypto from 'node:crypto';
import { query } from '../db.js';
import { isPermission } from './permissions.js';

export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export const bearer = req => req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';

/**
 * A user's effective permissions are what their role grants, plus anything the MD has
 * delegated to them personally, minus anything explicitly revoked. Delegations may carry an
 * expiry date, after which they simply stop counting — nothing has to be cleaned up.
 */
export async function permissionsFor(userId, roleId) {
  const [granted, personal] = await Promise.all([
    roleId ? query('SELECT permission_key FROM role_permissions WHERE role_id=?', [roleId]) : [],
    query(`SELECT permission_key,effect FROM user_permissions
           WHERE user_id=? AND (expires_at IS NULL OR expires_at >= CURDATE())`, [userId])
  ]);
  const effective = new Set(granted.map(row => row.permission_key));
  for (const row of personal) {
    if (row.effect === 'Grant') effective.add(row.permission_key);
    else effective.delete(row.permission_key);
  }
  return [...effective];
}

export const auth = wrap(async (req, res, next) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const rows = await query(`SELECT u.id,u.name,u.email,u.role,u.role_id FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=1`, [tokenHash(token)]);
  if (!rows[0]) return res.status(401).json({ error: 'Session expired' });
  req.user = rows[0];
  req.user.permissions = await permissionsFor(rows[0].id, rows[0].role_id);
  next();
});

/**
 * Guards a route with one or more permission keys. Holding any one of them is enough, which
 * lets a route accept either a departmental permission or a broader one.
 */
export const permit = (...keys) => {
  for (const key of keys) {
    if (!isPermission(key)) throw new Error(`Unknown permission "${key}" — add it to the catalogue`);
  }
  return (req, res, next) => (
    keys.some(key => req.user.permissions.includes(key))
      ? next()
      : res.status(403).json({ error: 'You do not have permission for this action' })
  );
};

export const can = (req, key) => Boolean(req.user?.permissions?.includes(key));

export const validate = schema => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: 'Invalid data', issues: result.error.flatten() });
  req.body = result.data;
  next();
};

/** Throwing this from a route produces a clean client error instead of a 500. */
export const fail = (status, message) => Object.assign(new Error(message), { status });
