import test from 'node:test';
import assert from 'node:assert/strict';
import { labourDayFacts, splitLabourCost } from '../src/lib/labour-day-cost.js';

test('labour allocation splits the saved earned day cost across BOQ hours', () => {
  const basis = labourDayFacts({ employeeId: 7, date: '2026-11-09',
    day: { check_in: '07:00', check_out: '17:00' }, basic: 2100, ot: 300, late: 200, source: 'HR attendance' });
  assert.equal(basis.workedHours, 10);
  assert.equal(basis.dailyPay, 2200);
  assert.equal(basis.hourlyCost, 220);
  const rows = splitLabourCost(basis, [{ boqItemId: 1, hours: 4 }, { boqItemId: 2, hours: 6 }]);
  assert.deepEqual(rows.map(row => row.amount), [880, 1320]);
  assert.equal(rows.reduce((total,row) => total + row.amount, 0), 2200);
});

test('labour allocation cannot exceed HR recorded worked hours', () => {
  const basis = labourDayFacts({ employeeId: 7, date: '2026-11-09',
    day: { check_in: '07:00', check_out: '17:00' }, basic: 2200, ot: 0, late: 0, source: 'HR attendance' });
  assert.throws(() => splitLabourCost(basis, [{ hours: 6 }], 5, 1100), /exceed/);
});
