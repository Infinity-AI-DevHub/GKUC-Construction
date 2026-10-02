import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeWorkbook } from '../src/lib/xlsx-write.js';
import { parseBoqWorkbook } from '../src/lib/boq-template.js';

test('four-sheet BOQ keeps summaries as controls and detail sheets in order', () => {
  const book = writeWorkbook([
    { name: 'GRAND SUMMARY', rows: [['GRAND SUMMARY'], ['Project: Test drainage'], [], ['ITEM', '', 'AMOUNT (LKR)'],
      ['PRELIMINARIES', 'Rs.', 25], ['BILL NO 1 - SUB STRUCTURE', 'Rs.', 100], ['GRAND TOTAL', 'Rs.', 125]] },
    { name: 'Summary & Collection', rows: [['COLLECTION'], [], [], ['BILL NO 1'], ['ITEM', 'DESCRIPTION', 'AMOUNT (LKR)'],
      ['A', 'DRAINAGE', 100], ['', 'TOTAL CARRIED TO SUMMARY', 100]] },
    { name: 'Preliminaries', rows: [['PRELIMINARIES'], [], [], [], [], [], [], [], [], [], [], [],
      ['Serial No', 'Description', 'Mode of Payment Category', 'Unit', 'Amount (LKR)'],
      ['Site preparation'], ['1', 'Safety facilities', 'C', 'Item', 25], ['', 'TOTAL PRELIMINARIES', '', '', 25]] },
    { name: 'Measured Works', rows: [['BILL NO 1'], ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT', 'RATE (LKR)', 'AMOUNT (LKR)'],
      ['A', 'DRAINAGE'], ['A.1', 'Drain excavation', 2, 'm3', 50, 100], ['', 'TOTAL OF DRAINAGE', '', '', '', 100]] }
  ]);
  const parsed = parseBoqWorkbook(book);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items.map(item => item.sourceSheet), ['Preliminaries', 'Measured Works']);
  assert.deepEqual(parsed.items.map(item => item.amount), [25, 100]);
  assert.deepEqual(parsed.layout.checks.map(check => check.matches), [true, true, true]);
  assert.equal(parsed.layout.summaries.length, 2);
});
