import { token } from './api.js';

/*
 * The live connection the workspace holds open.
 *
 * Read with fetch rather than EventSource for one reason: EventSource cannot set request
 * headers, so authenticating it would mean putting the session token in the query string,
 * where every proxy and access log on the way would keep a copy. Reading the body as a
 * stream costs a little more code and keeps the token in the Authorization header where
 * the rest of the application puts it.
 */

const listeners = new Set();

/** Subscribe to live events. Returns the function that stops listening. */
export const onRealtime = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const emit = (type, payload) => {
  for (const listener of [...listeners]) {
    try { listener(type, payload); } catch (error) { console.error('Live update handler failed', error); }
  }
};

/*
 * How long to wait before trying again, growing with each failure.
 *
 * A site office on a weak connection can drop repeatedly. Retrying instantly would spend
 * the connection it has on reconnect attempts; backing off to half a minute and no further
 * keeps it responsive when the network returns without hammering it while it is down.
 */
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

let controller = null;
let attempt = 0;
let stopped = false;
let timer = null;

/** Splits the stream into whole SSE frames and hands each one on. */
function consume(buffer, chunk) {
  const text = buffer + chunk;
  const frames = text.split('\n\n');
  /* The last piece may be an incomplete frame; it stays in the buffer for the next chunk. */
  const rest = frames.pop();
  for (const frame of frames) {
    if (!frame.trim() || frame.startsWith(':')) continue;   /* heartbeat */
    let type = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    let payload = null;
    try { payload = data ? JSON.parse(data) : null; } catch { payload = null; }
    emit(type, payload);
  }
  return rest;
}

/*
 * How long silence is allowed to last before the connection is treated as dead.
 *
 * The server sends a heartbeat every 25 seconds. Without watching for it a connection can
 * sit half-open indefinitely — the API restarts, a proxy between us keeps the browser's
 * socket open, and the read simply never returns. The screen goes on saying it is live
 * while nothing can reach it, which is worse than showing it is disconnected.
 */
const SILENCE_MS = 70000;

let watchdog = null;

const feedWatchdog = () => {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    /* Aborting makes the pending read reject, which drops into the reconnect path. */
    try { controller?.abort(); } catch { /* already gone */ }
  }, SILENCE_MS);
};

async function run() {
  controller = new AbortController();
  const response = await fetch('/api/events', {
    headers: { Authorization: `Bearer ${token.get()}` },
    signal: controller.signal
  });
  /*
   * A session that has expired must not be retried in a loop — it will never succeed, and
   * the workspace has its own handling for being signed out.
   */
  if (response.status === 401) { stopped = true; emit('unauthorised', null); return; }
  if (!response.ok || !response.body) throw new Error(`Live updates refused (${response.status})`);

  attempt = 0;
  emit('connected', null);
  feedWatchdog();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      /* Any traffic at all counts, heartbeats included — that is what they are for. */
      feedWatchdog();
      buffer = consume(buffer, decoder.decode(value, { stream: true }));
    }
  } finally {
    clearTimeout(watchdog);
  }
}

function schedule() {
  if (stopped) return;
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  timer = setTimeout(loop, wait);
}

async function loop() {
  if (stopped) return;
  try {
    await run();
    /* The server closed the stream cleanly — a restart, most likely. Reconnect. */
    if (!stopped) { emit('disconnected', null); schedule(); }
  } catch (error) {
    /*
     * An abort raised by the watchdog is a dropped connection, not a shutdown. Only an
     * abort after stopRealtime() means the workspace is genuinely finished with it.
     */
    if (stopped) return;
    emit('disconnected', null);
    schedule();
  }
}

export function startRealtime() {
  stopped = false;
  attempt = 0;
  loop();
  return stopRealtime;
}

export function stopRealtime() {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(watchdog);
  try { controller?.abort(); } catch { /* already gone */ }
  controller = null;
}
