import crypto from 'node:crypto';
import { query } from '../db.js';

const OWNER = 'Owner / Director';
const ADMIN = 'Administrator';
const MANAGER = 'Project Manager';
const SUPERVISOR = 'Site Supervisor';
const STORE = 'Storekeeper';
const FINANCE = 'Finance / Accounts';
const HR = 'HR';
const QS = 'QS / Estimator';
const TRANSPORT = 'Transport Officer';

/** Write permissions per PID section 2.14. Read access is granted to every signed-in user. */
export const roles = {
  manage: [OWNER, ADMIN],
  projects: [OWNER, ADMIN, MANAGER],
  site: [OWNER, ADMIN, MANAGER, SUPERVISOR],
  stock: [OWNER, ADMIN, MANAGER, SUPERVISOR, STORE],
  purchasing: [OWNER, ADMIN, MANAGER, STORE, FINANCE],
  finance: [OWNER, ADMIN, FINANCE],
  hr: [OWNER, ADMIN, HR],
  qs: [OWNER, ADMIN, MANAGER, QS],
  transport: [OWNER, ADMIN, MANAGER, TRANSPORT]
};

export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');

export const bearer = req => req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';

export const auth = wrap(async (req, res, next) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const rows = await query(`SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.active=1`, [tokenHash(token)]);
  if (!rows[0]) return res.status(401).json({ error: 'Session expired' });
  req.user = rows[0];
  next();
});

export const permit = allowed => (req, res, next) =>
  allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission for this action' });

export const validate = schema => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: 'Invalid data', issues: result.error.flatten() });
  req.body = result.data;
  next();
};

/** Throwing this from a route produces a clean client error instead of a 500. */
export const fail = (status, message) => Object.assign(new Error(message), { status });
