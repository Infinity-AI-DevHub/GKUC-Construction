import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseBiometricFile } from '../src/lib/biometric.js';

function report(bookType) {
  const workbook = XLSX.utils.book_new();
  const period = '2026-10-01 ~ 2026-10-03';
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Attendance Logs'], ['Date', null, period],
    ['ID', null, 101, null, 'Name', null, 'Test employee'],
    [1, 2, 3], ['Thu', 'Fri', 'Sat'], ['07:31\n17:15', '17:05', null]
  ]), 'Attendance Logs');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Attendance summary'], ['Date', period], ['ID', 'Name', 'Dept.'], [],
    [101, 'Test employee', 'Test department']
  ]), 'Attendance summary');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Schedule information sheet'], ['Date', period],
    ['ID', 'Name', 'Dept.', 1, 2, 3], [null, null, null, 'Thu', 'Fri', 'Sat'],
    [101, 'Test employee', 'Test department', 2, 2, 2]
  ]), 'Schedule information sheet');
  return XLSX.write(workbook, { bookType, type: 'buffer' });
}

for (const [bookType, extension] of [['biff8', 'xls'], ['xlsx', 'xlsx']]) {
  test(`${extension} calendar report preserves punches, single-punch review and absences`, () => {
    const result = parseBiometricFile({ filename: `All Report.${extension}`, buffer: report(bookType) });
    assert.deepEqual(result.period, { from: '2026-10-01', to: '2026-10-03' });
    assert.equal(result.rows.length, 3);
    const [first, single, absent] = result.rows;
    assert.equal(first.code, '101');
    assert.equal(first.department, 'Test department');
    assert.equal(first.checkIn, '07:31:00');
    assert.equal(first.checkOut, '17:15:00');
    assert.equal(first.needsReview, false);
    assert.equal(single.checkIn, null);
    assert.equal(single.checkOut, '17:05:00');
    assert.equal(single.needsReview, true);
    assert.equal(absent.declaredState, 'Absent');
    assert.equal(absent.date, '2026-10-03');
  });
}

test('legacy workbook signature is recognized regardless of filename', () => {
  const result = parseBiometricFile({ filename: 'report.dat', buffer: report('biff8') });
  assert.equal(result.rows.length, 3);
});

test('equivalent xls and xlsx reports produce identical attendance', () => {
  const parse = bookType => parseBiometricFile({ filename: 'report', buffer: report(bookType) });
  assert.deepEqual(parse('biff8'), parse('xlsx'));
});

test('CSV exports continue to parse', () => {
  const result = parseBiometricFile({ filename: 'punches.csv', buffer: Buffer.from(
    'EmployeeID,Date,In,Out\n101,2026-10-01,07:31,17:15\n'
  ) });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].checkOut, '17:15:00');
});

test('unreadable Excel files produce an actionable 422 instead of binary column names', () => {
  for (const filename of ['broken.xls', 'broken.xlsx']) {
    assert.throws(() => parseBiometricFile({ filename, buffer: Buffer.from('not a workbook') }),
      error => error.status === 422 && /Excel file could not be read/.test(error.message));
  }
});

test('workbooks without attendance logs report the missing sheet', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Other data']]), 'Other');
  const result = parseBiometricFile({ filename: 'other.xls', buffer: XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }) });
  assert.equal(result.rows.length, 0);
  assert.match(result.problems[0], /no "Attendance Logs" sheet/);
});
