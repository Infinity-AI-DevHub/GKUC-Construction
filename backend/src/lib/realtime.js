/*
 * Live updates, pushed rather than polled.
 *
 * The workspace used to learn about a new task, a raised alert or a changed record only
 * when somebody reloaded the page. On a site where a supervisor is told to move crews and
 * the coordinator is watching the same board, that delay is the difference between a
 * decision made on what is true and one made on what was true ten minutes ago.
 *
 * Server-sent events carry the change out to every open browser. They are one-directional
 * and travel over the ordinary HTTP connection, which means no second port, no upgrade
 * handshake for Nginx to be configured for, and no new dependency.
 *
 * The subscriber list is held in memory. That is correct for the way this runs — one PM2
 * process in fork mode — and is the same reason the rate limiters and the alert scheduler
 * hold their state here too. Running more than one instance needs a shared bus first.
 */

/** Everyone currently listening. */
const clients = new Set();

let nextId = 1;

/**
 * How long a browser may hear nothing before it assumes the connection died.
 *
 * Nginx and most intermediaries close an idle connection well before the browser does, so
 * a comment line goes out on a timer. It is not an event and the client ignores it; its
 * only job is to keep the pipe demonstrably alive.
 */
const HEARTBEAT_MS = 25000;

/**
 * Registers one browser. The caller has already authenticated, so the user and the
 * permissions they held at connection time travel with the subscriber and decide which
 * events it is allowed to see.
 */
export function subscribe(res, user) {
  const client = { id: nextId++, res, user, connectedAt: Date.now() };
  clients.add(client);

  const beat = setInterval(() => {
    /* A comment line: valid SSE, ignored by the client, enough to keep the socket open. */
    try { res.write(': keep-alive\n\n'); } catch { close(); }
  }, HEARTBEAT_MS);
  beat.unref?.();

  const close = () => {
    clearInterval(beat);
    clients.delete(client);
  };
  return close;
}

/**
 * Whether a subscriber should receive an event.
 *
 * `audience` is a permission key, matching how notifications are addressed elsewhere:
 * an event for 'finance.pay' reaches the people who hold it and nobody else. An event
 * with a `userId` is private to that person. An event with neither is general — a record
 * changed, refresh what you are showing — and goes to everyone signed in, because the
 * screens themselves already only render what the viewer is allowed to see.
 */
const visibleTo = (event, user) => {
  if (event.userId) return user.id === event.userId;
  if (event.audience) return user.permissions?.includes(event.audience);
  return true;
};

/**
 * Sends one event to every subscriber allowed to see it.
 *
 * A write can fail on a connection the client has already abandoned; that subscriber is
 * dropped rather than allowed to throw into whatever action triggered the publish. A
 * notification must never fail because somebody closed their laptop.
 */
export function publish(type, payload = {}, options = {}) {
  const event = { type, payload, audience: options.audience || null, userId: options.userId || null };
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;

  for (const client of [...clients]) {
    if (!visibleTo(event, client.user)) continue;
    try {
      client.res.write(frame);
      delivered += 1;
    } catch {
      clients.delete(client);
    }
  }
  return delivered;
}

/**
 * The general "something changed, re-read what you are showing" signal.
 *
 * Routes call this after a successful write. It deliberately carries only what changed and
 * not the new rows: the client re-fetches through the same permission-checked endpoints it
 * always used, so a live update can never become a way to receive data the viewer would
 * have been refused on request.
 */
export const publishChange = (entity, detail = {}) => publish('data', { entity, ...detail });

export const listenerCount = () => clients.size;

/** For the admin view: who is connected, without exposing the connections themselves. */
export const connectedUsers = () => {
  const seen = new Map();
  for (const client of clients) {
    const existing = seen.get(client.user.id);
    if (!existing || client.connectedAt < existing.since) {
      seen.set(client.user.id, { id: client.user.id, name: client.user.name, since: client.connectedAt });
    }
  }
  return [...seen.values()];
};
