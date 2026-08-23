import { Router } from 'express';
import { auth } from '../lib/http.js';
import { subscribe, listenerCount, publish } from '../lib/realtime.js';

const router = Router();

/**
 * The live stream every open workspace holds.
 *
 * Authenticated like any other route — the browser opens it with fetch and reads the body
 * as a stream, rather than with EventSource, precisely so the session token travels in the
 * Authorization header. EventSource cannot set headers, and the alternative is putting the
 * token in the query string, where it would be written into every proxy access log.
 */
router.get('/events', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /*
     * Nginx buffers proxied responses by default, which for a stream means the browser
     * receives nothing until the buffer fills — the updates arrive in clumps, minutes late,
     * or not at all. This header switches buffering off for this response, so live updates
     * work behind the standard aaPanel proxy without editing its configuration.
     */
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  /* Tells the client it is connected, and gives it something to react to immediately. */
  res.write(`event: ready\ndata: ${JSON.stringify({ user: req.user.name, listeners: listenerCount() + 1 })}\n\n`);

  const close = subscribe(res, req.user);
  req.on('close', close);
  req.on('error', close);
});

/** How many browsers are currently listening. Useful when live updates look wrong. */
router.get('/events/status', auth, (_req, res) => res.json({ listeners: listenerCount() }));

/*
 * Proves the path end to end, from this process out to the browser that asked.
 * Private to the caller, so testing it never puts a stray banner on somebody else's screen.
 */
router.post('/events/test', auth, (req, res) => {
  const delivered = publish('banner', {
    severity: 'Info',
    title: 'Live updates are working',
    message: `Sent to you at ${new Date().toLocaleTimeString('en-GB')}.`
  }, { userId: req.user.id });
  res.json({ delivered });
});

export default router;
