import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubcontractQuoteText, suggestSubcontractors } from '../src/lib/subcontract-quote-pdf.js';

test('extracts quotation identity, metadata, priced rows and total', () => {
  const parsed = parseSubcontractQuoteText(`From: ABC Electrical Ltd
Quotation No: Q-123
Date: 2026-09-18
Telephone: 0771234567
Address: Colombo
Scope of work: Cable installation
1 Cable installation      m  12  450.00  5400.00
2 Light fittings          no  4  1200.00  4800.00
Total 10,200.00`);
  assert.equal(parsed.subcontractor.name, 'ABC Electrical Ltd');
  assert.equal(parsed.quotation.theirReference, 'Q-123');
  assert.equal(parsed.quotation.quoteDate, '2026-09-18');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[1].rate, 1200);
  assert.equal(parsed.statedTotal, 10200);
  assert.deepEqual(parsed.warnings, []);
});

test('flags row and grand-total disagreements for human review', () => {
  const parsed = parseSubcontractQuoteText(`Supplier: BuildCo
Date: 18/09/2026
1 Masonry work      m2  3  1000.00  2500.00
Total 3,500.00`);
  assert.equal(parsed.quotation.quoteDate, '2026-09-18');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.warnings.length, 2);
});

test('matches existing subcontractor by registration, name or phone without auto-linking', () => {
  const parsed = { subcontractor: { name: 'Build Co Ltd', businessId: 'PV 12345', phone: '077 1234567' } };
  const matches = suggestSubcontractors(parsed, [
    { id: 1, name: 'Other Ltd', businessId: 'PV-12345', phone: '' },
    { id: 2, name: 'Build Co Ltd', businessId: '', phone: '' },
    { id: 3, name: 'Unrelated', businessId: '', phone: '0771234567' },
    { id: 4, name: 'No match', businessId: '', phone: '' }
  ]);
  assert.deepEqual(matches.map(row => row.id), [1, 2, 3]);
});
