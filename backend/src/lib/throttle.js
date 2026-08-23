import crypto from 'node:crypto';

/*
 * Request throttling.
 *
 * Sign-in had a limiter of its own, but everything behind it had none: a stolen token, or
 * an account someone still holds after they should not, could pull every table in the
 * database as fast as the network allowed, or simply hold the connection pool open until
 * the site stopped working for everyone else.
 *
 * Two buckets, because they answer different questions. The steady rate is what one account
 * legitimately needs — a busy screen loads a dozen endpoints, not a thousand. The burst
 * allowance is what keeps that from tripping when a page opens.
 *
 * Held in memory, as with the sign-in limiter: this is one process against one database, and
 * a limiter that needs its own datastore is a limiter that gets turned off. Behind more than
 * one instance it wants moving to a shared cache — the shape here does not change.
 */

const WINDOW_MS = Number(process.env.RATE_WINDOW_SECONDS || 60) * 1000;
const MAX_REQUESTS = Number(process.env.RATE_MAX_REQUESTS || 600);
const MAX_WRITES = Number(process.env.RATE_MAX_WRITES || 120);

const buckets = new Map();

const bucketFor = (key, now) => {
  const found = buckets.get(key);
  if (found && now < found.until) return found;
  const fresh = { count: 0, writes: 0, until: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
};

/* Anything that changes data is held to a tighter count than reading does. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const rateLimit = (req, res, next) => {
  const now = Date.now();

  /*
   * The live stream is exempt.
   *
   * It is one request that stays open for as long as the workspace does, so counting it
   * says nothing about load. Worse, a browser that reconnects after a dropped connection —
   * a laptop lid closing, a site office losing signal — would spend its allowance on
   * retries and then be refused the very stream it was trying to restore.
   */
  if (req.path === '/events') return next();

  /*
   * Counted per session where there is one, per address otherwise.
   *
   * The bearer token is used rather than the user id because this runs ahead of
   * authentication — deliberately, so a refusal costs nothing. Hashing it keeps the token
   * itself out of the map. Keying only on address would punish a whole site office behind
   * one connection; keying only on the session would leave sign-in uncovered.
   */
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const key = bearer
    ? `session:${crypto.createHash('sha256').update(bearer).digest('hex').slice(0, 32)}`
    : `ip:${req.ip}`;
  const bucket = bucketFor(key, now);
  const isWrite = WRITE_METHODS.has(req.method);

  bucket.count += 1;
  if (isWrite) bucket.writes += 1;

  const overRead = bucket.count > MAX_REQUESTS;
  const overWrite = isWrite && bucket.writes > MAX_WRITES;

  if (overRead || overWrite) {
    const retryAfter = Math.max(1, Math.ceil((bucket.until - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many requests. Slow down and try again shortly.'
    });
  }

  res.setHeader('X-RateLimit-Limit', String(isWrite ? MAX_WRITES : MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining',
    String(Math.max(0, (isWrite ? MAX_WRITES - bucket.writes : MAX_REQUESTS - bucket.count))));

  /* Expired buckets are dropped in passing rather than by a timer. */
  if (buckets.size > 10000) {
    for (const [id, held] of buckets) if (now > held.until) buckets.delete(id);
  }
  return next();
};
