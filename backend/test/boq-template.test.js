import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COLUMNS, buildTemplate, parseBoqWorkbook } from '../src/lib/boq-template.js';
import { writeWorkbook } from '../src/lib/xlsx-write.js';

const workbook = (headers, rows) => writeWorkbook([{ name: 'BOQ', rows: [headers, ...rows] }]);
const headers = COLUMNS.map(column => column.header);
const item = category => [category, 'Measured work', 'm3', 2, 125, null, null, null];

test('sectioned client template imports detail once and preserves item references and Excel row numbers', () => {
  const parsed = parseBoqWorkbook(readFileSync(new URL('../fixtures/boq-sectioned-template.xlsx', import.meta.url)));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 60);
  assert.equal(Number(parsed.items.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), 16140350.70);
  assert.ok(parsed.items.every(row => row.problems.length === 0 && row.category === null));
  assert.equal(parsed.items[0].sourceRow, 10);
  assert.match(parsed.items[0].notes, /Ref A-01.*General Item/);
  assert.equal(parsed.items[0].raw.category, 'A-01');
  assert.equal(parsed.items.at(-1).sourceRow, 78);
  assert.equal(parsed.layout.excludedRows.filter(row => row.reason === 'Subtotal').length, 4);
});

test('item reference detection does not hide incomplete items or unknown categories', () => {
  const parsed = parseBoqWorkbook(workbook(headers, [item('A-1'), item('A-2'), ['A-3', 'Incomplete item']]));
  assert.equal(parsed.items.length, 3);
  assert.ok(parsed.items[2].problems.includes('No unit'));
  const unknown = parseBoqWorkbook(workbook(headers, [item('Unrecognised category'.repeat(5))]));
  assert.equal(unknown.items[0].category.length, 60);
  assert.match(unknown.items[0].problems.join(' '), /longer than 60/);
});

test('downloaded BOQ template labels category as optional', () => {
  const parsed = parseBoqWorkbook(buildTemplate());
  assert.equal(parsed.ok, true);
  assert.equal(COLUMNS.find(column => column.key === 'category').required, false);
});

test('BOQ import accepts a blank category and a file with no Category column', () => {
  const blank = parseBoqWorkbook(workbook(headers, [item('')]));
  assert.equal(blank.ok, true);
  assert.equal(blank.items[0].category, null);
  assert.deepEqual(blank.items[0].problems, []);

  const withoutColumn = parseBoqWorkbook(workbook(headers.slice(1), [item(null).slice(1)]));
  assert.equal(withoutColumn.ok, true);
  assert.equal(withoutColumn.items[0].category, null);
  assert.deepEqual(withoutColumn.items[0].problems, []);
});

test('BOQ import accepts saved categories but flags unknown nonblank values', () => {
  const categories = ['Material', 'Earthworks'];
  const saved = parseBoqWorkbook(workbook(headers, [item('earthworks')]), { categories });
  assert.equal(saved.items[0].category, 'Earthworks');
  assert.deepEqual(saved.items[0].problems, []);

  const unknown = parseBoqWorkbook(workbook(headers, [item('Unknown trade')]), { categories });
  assert.equal(unknown.items[0].category, 'Unknown trade');
  assert.match(unknown.items[0].problems.join(' '), /not one of/);
});
