/*
 * The alert sound.
 *
 * Synthesised rather than shipped as a file: an audio asset would be another request, and
 * the CSP the server sets allows no external media anyway. Two short tones, a rising
 * interval for ordinary news and a lower repeated one for something critical, so a person
 * with their back to the screen can tell the difference without looking.
 */

let context = null;

/*
 * A browser will not let a page make noise until the person has interacted with it. The
 * context is therefore created on first use — by which time a sign-in has happened — and
 * resumed if the browser suspended it.
 */
const audioContext = () => {
  if (!context) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
};

const tone = (ctx, frequency, startAt, duration, peak) => {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  /* Shaped rather than switched: a square-edged start and stop clicks audibly. */
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
};

const MUTED_KEY = 'gkuc-alert-sound';

export const soundMuted = () => localStorage.getItem(MUTED_KEY) === 'off';
export const setSoundMuted = muted => localStorage.setItem(MUTED_KEY, muted ? 'off' : 'on');

/** severity: 'Critical' | 'Warning' | 'Info' */
export function playChime(severity = 'Info') {
  if (soundMuted()) return;
  const ctx = audioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (severity === 'Critical') {
    /* Lower and repeated: reads as urgent without being shrill. */
    tone(ctx, 440, now, 0.16, 0.18);
    tone(ctx, 440, now + 0.22, 0.16, 0.18);
    tone(ctx, 330, now + 0.44, 0.26, 0.16);
  } else {
    tone(ctx, 660, now, 0.12, 0.12);
    tone(ctx, 880, now + 0.13, 0.20, 0.12);
  }
}
