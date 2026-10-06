import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuotation } from '../src/lib/quotation-calculations.js';

test('one item uses decimal-safe combined VAT', () => {
  const result = calculateQuotation([{ category: 'Tar', quantity: 1.25, rate: 100.10 }], { vatPercent: 18 });
  assert.deepEqual(result, { lines: [{ category: 'Tar', quantity: 1.25, rate: 100.10, amount: 125.13 }],
    categoryTotals: [{ category: 'Tar', subtotal: 125.13, markup: 0, vat: 22.52, total: 147.65 }],
    subtotal: 125.13, markup: 0, vat: 22.52, total: 147.65 });
});

test('combined mode totals dynamic categories once', () => {
  const result = calculateQuotation([
    { category: 'Tar', quantity: 2, rate: 100 },
    { category: 'Asphalt', quantity: 3, rate: 200 },
    { category: 'Concrete', quantity: 0.5, rate: 1000 }
  ], { vatPercent: 18, calculationMode: 'Combined Total' });
  assert.equal(result.subtotal, 1300);
  assert.equal(result.vat, 234);
  assert.equal(result.total, 1534);
});

test('separate mode rounds VAT per category and supports zero VAT', () => {
  const lines = [
    { category: 'Tar', quantity: 1, rate: 0.03 },
    { category: 'Asphalt', quantity: 1, rate: 0.03 },
    { category: 'Concrete', quantity: 1, rate: 0.03 }
  ];
  const separate = calculateQuotation(lines, { vatPercent: 18, calculationMode: 'Separate Category Totals' });
  const combined = calculateQuotation(lines, { vatPercent: 18, calculationMode: 'Combined Total' });
  assert.equal(separate.vat, 0.03);
  assert.equal(combined.vat, 0.02);
  assert.equal(calculateQuotation(lines, { vatPercent: 0 }).vat, 0);
});

test('revision recalculation responds to changed quantity and rate', () => {
  const original = calculateQuotation([{ category: 'Tar', quantity: 1, rate: 100 }], { vatPercent: 18 });
  const revision = calculateQuotation([{ category: 'Tar', quantity: 2.5, rate: 120 }], { vatPercent: 18 });
  assert.equal(original.total, 118);
  assert.equal(revision.total, 354);
});
