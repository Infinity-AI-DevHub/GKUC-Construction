import { query } from '../db.js';
import { isOnline, onlineUserIds, onPresenceChange, publish } from './realtime.js';

/*
 * Who is here, and when the rest were last here.
 *
 * "Online" is not stored: it is whether the person has a browser listening right now, which
 * the realtime hub already knows. Storing it would mean a flag that says somebody is online
 * because the process was killed before it could be cleared — the state that makes presence
 * useless everywhere it is done badly.
 *
 * "Last seen" is stored, because it has to outlive the connection.
 */

/*
 * Written on a timer rather than on every request. The figure is shown as "a few minutes
 * ago", so a write per request would be a great deal of work for a number nobody reads to
 * that precision.
 */
const TOUCH_MS = 60000;
const pending = new Map();

/** Notes that somebody is active. Cheap to call on every request. */
export function touch(userId) {
  const now = Date.now();
  const last = pending.get(userId) || 0;
  if (now - last < TOUCH_MS) return;
  pending.set(userId, now);
  query('UPDATE users SET last_active_at=NOW() WHERE id=?', [userId])
    .catch(error => console.error('Could not record activity', error));
}

/** Everyone's presence, for building the people list. */
export async function presenceMap() {
  const rows = await query('SELECT id,last_active_at lastActiveAt FROM users WHERE active=1');
  const online = new Set(onlineUserIds());
  return rows.map(row => ({
    id: row.id,
    online: online.has(row.id),
    lastActiveAt: row.lastActiveAt
  }));
}

/**
 * Announces arrivals and departures.
 *
 * Everybody signed in is told, because everybody's conversation list shows who is there.
 * The last-seen time is written on the way out — that moment is exactly what it means.
 */
export function startPresence() {
  return onPresenceChange(async (userId, online) => {
    if (!online) {
      await query('UPDATE users SET last_active_at=NOW() WHERE id=?', [userId]).catch(() => {});
    }
    const [row] = await query('SELECT last_active_at lastActiveAt FROM users WHERE id=?', [userId])
      .catch(() => [{}]);
    publish('presence', { userId, online, lastActiveAt: row?.lastActiveAt || null });
  });
}
