import crypto from 'node:crypto';
import { query } from '../db.js';
import { isPermission } from './permissions.js';
import { isValidOption, optionsFor } from './options.js';

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

/*
 * How long a session may sit untouched before it stops counting.
 *
 * The absolute lifetime alone left a browser open on a site office desk usable for the rest
 * of the day. Idle time is tracked as well, and the two are enforced together.
 */
export const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 60);

export const auth = wrap(async (req, res, next) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const hash = tokenHash(token);
  const rows = await query(
    `SELECT u.id,u.name,u.email,u.role,u.role_id,s.id session_id,s.last_seen_at
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>NOW() AND u.active=1`, [hash]);
  if (!rows[0]) return res.status(401).json({ error: 'Session expired' });

  const session = rows[0];
  const lastSeen = session.last_seen_at ? new Date(session.last_seen_at) : null;
  const idleMs = lastSeen ? Date.now() - lastSeen.getTime() : 0;
  if (lastSeen && idleMs > IDLE_MINUTES * 60000) {
    await query('DELETE FROM sessions WHERE id=?', [session.session_id]);
    return res.status(401).json({ error: 'Signed out after a period of inactivity' });
  }

  /* Written at most once a minute: the point is to notice idleness, not to add a write to
     every request the application makes. */
  if (!lastSeen || idleMs > 60000) {
    await query('UPDATE sessions SET last_seen_at=NOW() WHERE id=?', [session.session_id]);
  }

  req.user = { id: session.id, name: session.name, email: session.email, role: session.role, role_id: session.role_id };
  req.user.permissions = await permissionsFor(session.id, session.role_id);
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

/**
 * Checks fields against the lists the company maintains.
 *
 * Runs after validate(), which has already established the shape. A fixed z.enum() cannot
 * be used for these: it would be decided when the module loaded, and the whole point of
 * these lists is that they change while the system is running.
 *
 *   router.post('/', auth, validate(schema), fromOptions({ category: 'boq.category' }), handler)
 */
export const fromOptions = mapping => async (req, res, next) => {
  try {
    for (const [field, listKey] of Object.entries(mapping)) {
      const value = req.body?.[field];
      /* Absent or deliberately cleared is the schema's business, not this one's. */
      if (value === undefined || value === null || value === '') continue;
      if (!await isValidOption(listKey, value)) {
        const allowed = await optionsFor(listKey);
        return res.status(400).json({
          error: `"${value}" is not one of the options for this field.`,
          issues: { fieldErrors: { [field]: [`Choose one of: ${allowed.join(', ')}`] } }
        });
      }
    }
    next();
  } catch (error) { next(error); }
};

/** Throwing this from a route produces a clean client error instead of a 500. */
export const fail = (status, message) => Object.assign(new Error(message), { status });
