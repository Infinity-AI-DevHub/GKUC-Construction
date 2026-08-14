import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, verifyPassword } from '../db.js';
import { auth, bearer, permissionsFor, tokenHash, validate, wrap } from '../lib/http.js';

const SESSION_HOURS = 12;
const router = Router();

async function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000);
  await query('INSERT INTO sessions (user_id,token_hash,expires_at) VALUES (?,?,?)', [userId, tokenHash(token), expires]);
  await query('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  return { token, expires };
}

router.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(8) })), wrap(async (req, res) => {
  const user = await getOne('SELECT * FROM users WHERE email=? AND active=1', [req.body.email.toLowerCase()]);
  if (!user || !verifyPassword(req.body.password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const session = await issueSession(user.id);
  await audit(pool, user.id, 'LOGIN', 'session', '', null, { expires: session.expires }, req.ip);
  res.json({
    token: session.token,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      permissions: await permissionsFor(user.id, user.role_id)
    }
  });
}));

router.post('/logout', auth, wrap(async (req, res) => {
  await query('DELETE FROM sessions WHERE token_hash=?', [tokenHash(bearer(req))]);
  res.status(204).end();
}));

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

router.post('/password', auth, validate(z.object({ current: z.string().min(8), password: z.string().min(10) })), wrap(async (req, res) => {
  const { hashPassword } = await import('../db.js');
  const user = await getOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!verifyPassword(req.body.current, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  await query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(req.body.password), req.user.id]);
  await query('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', [req.user.id, tokenHash(bearer(req))]);
  await audit(pool, req.user.id, 'PASSWORD_CHANGE', 'user', req.user.id, null, null, req.ip);
  res.status(204).end();
}));

export default router;
