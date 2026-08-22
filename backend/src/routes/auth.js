import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, hashPassword, pool, query, verifyPassword } from '../db.js';
import { auth, bearer, permissionsFor, tokenHash, validate, wrap } from '../lib/http.js';

const SESSION_HOURS = 12;
const router = Router();

/*
 * Throttling sign-in attempts.
 *
 * Nothing stood between an attacker and unlimited guesses: the password rules are decent
 * but a shared or weak one falls to a script in minutes, and every attempt was free. Counts
 * are held per address and per account — per address alone lets one attacker work through
 * a list of staff from one IP, and per account alone lets a botnet spread the load.
 *
 * Held in memory deliberately: this is one process against one database, and a limiter that
 * needs its own store is a limiter that gets switched off. Behind more than one instance
 * this wants moving to the database or a shared cache.
 */
/* A real hash to check against when the address is unknown, so both paths cost the same. */
const DECOY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

const ATTEMPT_LIMIT = Number(process.env.LOGIN_ATTEMPT_LIMIT || 8);
const ATTEMPT_WINDOW_MS = Number(process.env.LOGIN_ATTEMPT_WINDOW_MINUTES || 15) * 60000;
const attempts = new Map();

const attemptKeys = (req, email) => [`ip:${req.ip}`, `user:${email}`];

const tooManyAttempts = keys => {
  const now = Date.now();
  return keys.some(key => {
    const record = attempts.get(key);
    if (!record || now > record.until) { attempts.delete(key); return false; }
    return record.count >= ATTEMPT_LIMIT;
  });
};

const recordFailure = keys => {
  const now = Date.now();
  for (const key of keys) {
    const record = attempts.get(key);
    if (!record || now > record.until) attempts.set(key, { count: 1, until: now + ATTEMPT_WINDOW_MS });
    else record.count += 1;
  }
  /* A failed-attempt table is still a table: drop what has aged out rather than grow. */
  if (attempts.size > 5000) {
    for (const [key, record] of attempts) if (now > record.until) attempts.delete(key);
  }
};

const clearAttempts = keys => { for (const key of keys) attempts.delete(key); };

async function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000);
  await query('INSERT INTO sessions (user_id,token_hash,expires_at) VALUES (?,?,?)', [userId, tokenHash(token), expires]);
  await query('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
  return { token, expires };
}

router.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(8) })), wrap(async (req, res) => {
  const email = req.body.email.toLowerCase();
  const keys = attemptKeys(req, email);

  if (tooManyAttempts(keys)) {
    await audit(pool, null, 'LOGIN_THROTTLED', 'session', '', null, { email }, req.ip);
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.' });
  }

  const user = await getOne('SELECT * FROM users WHERE email=? AND active=1', [email]);

  /*
   * The hash is verified even when no such account exists.
   *
   * Skipping it answered an unknown address in a fraction of the time a real one took,
   * which is enough to sort a list of guessed addresses into staff and non-staff without
   * ever getting a password right.
   */
  const correct = user
    ? verifyPassword(req.body.password, user.password_hash)
    : verifyPassword(req.body.password, DECOY_HASH) && false;

  if (!correct) {
    recordFailure(keys);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  clearAttempts(keys);
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
