const pow10 = places => 10n ** BigInt(places);

function scaled(value, places) {
  const text = String(value ?? 0).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid numeric value: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const rounded = `${fraction}${'0'.repeat(places + 1)}`;
  let result = BigInt(whole) * pow10(places) + BigInt(rounded.slice(0, places) || 0);
  if (Number(rounded[places] || 0) >= 5) result += 1n;
  return negative ? -result : result;
}

const cents = value => scaled(value, 2);
const money = value => Number(value) / 100;
const multiply = (quantity, rate) => {
  const quantityThousandths = scaled(quantity, 3);
  const rateCents = cents(rate);
  return (quantityThousandths * rateCents + 500n) / 1000n;
};
const percent = (amountCents, rate) => {
  const hundredths = scaled(rate, 2);
  return (amountCents * hundredths + 5000n) / 10000n;
};

export const CALCULATION_MODES = ['Combined Total', 'Separate Category Totals'];

/** One authoritative, decimal-safe quotation calculation used by APIs and documents. */
export function calculateQuotation(lines, { markupPercent = 0, vatPercent = 0,
  calculationMode = 'Combined Total' } = {}) {
  if (!CALCULATION_MODES.includes(calculationMode)) throw new Error('Unknown quotation calculation mode');
  const pricedLines = lines.map(line => ({ ...line, amount: money(multiply(line.quantity, line.rate)) }));
  const groups = new Map();
  for (const line of pricedLines) {
    const category = String(line.category || 'Uncategorised').trim() || 'Uncategorised';
    groups.set(category, (groups.get(category) || 0n) + cents(line.amount));
  }
  const categoryTotals = [...groups].map(([category, base]) => {
    const markup = percent(base, markupPercent);
    const subtotalWithMarkup = base + markup;
    const vat = percent(subtotalWithMarkup, vatPercent);
    return { category, subtotal: money(base), markup: money(markup), vat: money(vat), total: money(subtotalWithMarkup + vat) };
  });
  const subtotalCents = categoryTotals.reduce((sum, group) => sum + cents(group.subtotal), 0n);
  const markupCents = percent(subtotalCents, markupPercent);
  const combinedVat = percent(subtotalCents + markupCents, vatPercent);
  const separateVat = categoryTotals.reduce((sum, group) => sum + cents(group.vat), 0n);
  const vatCents = calculationMode === 'Separate Category Totals' ? separateVat : combinedVat;
  return { lines: pricedLines, categoryTotals, subtotal: money(subtotalCents), markup: money(markupCents),
    vat: money(vatCents), total: money(subtotalCents + markupCents + vatCents) };
}
