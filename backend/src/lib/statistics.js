/*
 * The arithmetic the detectors lean on.
 *
 * Kept apart from the rules themselves so it can be tested against known answers rather
 * than judged by whether the findings "look about right" — which is exactly how a detection
 * system ends up confidently wrong.
 */

export const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * How far a value sits from normal, measured in a way a few extreme values cannot distort.
 *
 * The ordinary standard deviation is computed *from* the data it is judging, so a single
 * fraudulent invoice ten times the size of the rest drags the mean and the deviation up
 * with it and then sits comfortably inside "normal" — the outlier hides itself. The median
 * absolute deviation does not move for a handful of extreme values, which is the whole
 * point when the extreme values are what is being looked for.
 *
 * 1.4826 scales MAD so that, for data that is genuinely normal, it matches the standard
 * deviation — so a threshold of "3" means what people expect it to mean.
 */
export function robustZScore(value, history) {
  const centre = median(history);
  if (centre === null) return null;
  const deviations = history.map(one => Math.abs(one - centre));
  const spread = median(deviations) * 1.4826;
  /*
   * Every historical value identical — common early on, when three cement deliveries were
   * all exactly 45,000. Any difference at all is then infinitely unusual by the formula,
   * which is not a useful thing to tell somebody, so it is measured against the centre
   * instead and only a large relative gap counts.
   */
  if (!spread) {
    if (!centre) return null;
    const relative = Math.abs(value - centre) / Math.abs(centre);
    return relative > 0.5 ? relative * 4 : 0;
  }
  return (value - centre) / spread;
}

/**
 * Benford's law: in figures that arise naturally, 1 leads about 30% of the time and 9 about
 * 4.6% — not the 11% each that intuition suggests.
 *
 * People inventing numbers spread their first digits far more evenly, and favour 5 and 9
 * near thresholds. It says nothing about any single figure — only about a body of them —
 * so it is used on a person's or a supplier's whole run of entries, never to accuse one
 * invoice.
 */
const BENFORD = [0.301, 0.176, 0.125, 0.097, 0.079, 0.067, 0.058, 0.051, 0.046];

export function benfordDeviation(amounts) {
  const digits = amounts
    .map(amount => String(Math.abs(Number(amount) || 0)).replace(/[^1-9]/, '').charAt(0))
    .filter(Boolean)
    .map(Number)
    .filter(digit => digit >= 1 && digit <= 9);

  if (digits.length < 30) return null;

  const counts = new Array(9).fill(0);
  for (const digit of digits) counts[digit - 1] += 1;
  const observed = counts.map(count => count / digits.length);

  /*
   * Chi-squared against the expected shape. Reported alongside the digit that is most
   * over-represented, because "too many nines" is something a person can act on, where a
   * chi-squared statistic on its own is not.
   */
  let chi = 0;
  let worst = { digit: null, excess: 0 };
  for (let index = 0; index < 9; index++) {
    const expected = BENFORD[index] * digits.length;
    chi += ((counts[index] - expected) ** 2) / expected;
    const excess = observed[index] - BENFORD[index];
    if (excess > worst.excess) worst = { digit: index + 1, excess };
  }
  /* 20.09 is the 1% point for eight degrees of freedom. */
  return { chi, sample: digits.length, suspicious: chi > 20.09, worst, observed };
}

/** Whether a figure is suspiciously round — 500,000 rather than 487,350. */
export function roundness(amount) {
  const value = Math.abs(Number(amount) || 0);
  if (!value) return 0;
  if (value % 1000000 === 0) return 4;
  if (value % 100000 === 0) return 3;
  if (value % 10000 === 0) return 2;
  if (value % 1000 === 0) return 1;
  return 0;
}

/**
 * How alike two pieces of text are, 0 to 1.
 *
 * Used for near-duplicate descriptions — "Cement 50kg x 200" against "cement 50 kg x200" —
 * where an exact comparison finds nothing and a person reading the two would see the same
 * entry twice.
 */
export function similarity(a, b) {
  const clean = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const left = clean(a);
  const right = clean(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  /* Compared on pairs of characters, which handles words being reordered or split. */
  const pairs = text => {
    const set = new Set();
    for (let index = 0; index < text.length - 1; index++) set.add(text.slice(index, index + 2));
    return set;
  };
  const first = pairs(left);
  const second = pairs(right);
  if (!first.size || !second.size) return 0;
  let shared = 0;
  for (const pair of first) if (second.has(pair)) shared += 1;
  return (2 * shared) / (first.size + second.size);
}
