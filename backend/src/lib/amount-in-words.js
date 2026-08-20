/**
 * Writes an amount the way it is written on a Sri Lankan document — "Rupees Two Million
 * Three Hundred Thousand and Cents Fifty Only".
 *
 * Required rather than decorative: the government's prescribed tax invoice has a "Total
 * Amount in words" line, and quotations carry one so a figure cannot be altered after
 * signing without the words disagreeing.
 *
 * Written in the international scale (million/billion) rather than lakhs and crores, which
 * is what GKUC's own paperwork uses.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];

/** 0–999 in words. */
function underThousand(value) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) words.push(ONES[hundreds], 'Hundred');
  if (rest < 20) {
    if (rest) words.push(ONES[rest]);
  } else {
    words.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push(ONES[rest % 10]);
  }
  return words.join(' ');
}

export function numberInWords(value) {
  const whole = Math.floor(Math.abs(Number(value) || 0));
  if (whole === 0) return 'Zero';

  const parts = [];
  let remaining = whole;
  for (const [size, label] of SCALES) {
    const count = Math.floor(remaining / size);
    if (count) {
      parts.push(`${underThousand(count)} ${label}`);
      remaining %= size;
    }
  }
  if (remaining) parts.push(underThousand(remaining));
  return parts.join(' ');
}

/** The full line as it appears on the document. */
export function amountInWords(value) {
  const amount = Math.abs(Number(value) || 0);
  const rupees = Math.floor(amount);
  /* Rounded, not truncated, so the words match the figure printed beside them. */
  const cents = Math.round((amount - rupees) * 100);

  /* Rounding can carry into the rupees — 99.999 must read as One Hundred, not Ninety Nine
     Rupees and One Hundred Cents. */
  if (cents === 100) return `Rupees ${numberInWords(rupees + 1)} Only`;

  const words = `Rupees ${numberInWords(rupees)}`;
  return cents ? `${words} and Cents ${numberInWords(cents)} Only` : `${words} Only`;
}
