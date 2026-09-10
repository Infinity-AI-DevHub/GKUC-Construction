/*
 * A way for code outside React to put a message in front of the person.
 *
 * Banners live in React state, which suits everything raised from a component but leaves
 * the plain modules — the API layer especially — with nowhere to report to. They had been
 * throwing instead, and a rejection is only seen if every call site remembers to catch it.
 * Four of eight did not, so opening a document with pop-ups blocked did nothing at all and
 * said nothing about why.
 *
 * This is the one channel those modules publish on. It holds no state and no React import,
 * so anything may use it; `useBanners` is what listens.
 */

const listeners = new Set();

/** Subscribes to notices. Returns the unsubscribe, for an effect's cleanup. */
export function onNotice(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Shows a notice. `severity` follows the alert vocabulary used everywhere else:
 * 'Info', 'Warning' or 'Critical'.
 */
export function notice({ title, message = '', severity = 'Warning' }) {
  for (const listener of [...listeners]) listener({ title, message, severity });
}
