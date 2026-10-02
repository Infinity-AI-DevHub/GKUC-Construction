import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, buildTemplate, parseBoqWorkbook } from '../src/lib/boq-template.js';
import { writeWorkbook } from '../src/lib/xlsx-write.js';

const workbook = (headers, rows) => writeWorkbook([{ name: 'BOQ', rows: [headers, ...rows] }]);
const headers = COLUMNS.map(column => column.header);
const item = category => [category, 'Measured work', 'm3', 2, 125, null, null, null];

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
