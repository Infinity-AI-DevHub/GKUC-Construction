import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceDue, maintenancePresets, maintenanceReminder } from '../src/lib/vehicle-maintenance.js';

test('GKUC presets separate engine oil from the common brake oil interval', () => {
  assert.deepEqual(maintenancePresets('Japanese').map(row => row.intervalKm), [5000,20000]);
  assert.deepEqual(maintenancePresets('European').map(row => row.intervalKm), [15000,20000]);
});
const schedule = { id: 4, vehicleId: 2, name: 'Engine oil change', intervalKm: 5000,
  lastOdometer: 10000, remindBeforeKm: 500, active: 1, vehicleStatus: 'Available', registration: 'TEST-1', vehicle: 'Test vehicle' };
test('reminders start at the configured advance threshold and use the last completion reading', () => {
  assert.equal(maintenanceReminder({ ...schedule, odometer: 14499 }, 'today'), null);
  const warning = maintenanceReminder({ ...schedule, odometer: 14500 }, 'today');
  assert.equal(warning.severity, 'Warning');
  assert.match(warning.message, /500 km remaining/);
  assert.equal(maintenanceDue(schedule, 15000).kmRemaining, 0);
  assert.equal(maintenanceReminder({ ...schedule, odometer: 15001 }, 'today').severity, 'Critical');
  assert.match(maintenanceReminder({ ...schedule, odometer: 15001 }, 'today').message, /1 km overdue/);
});
test('paused reminders and inactive vehicles do not notify; completions start a new cycle', () => {
  assert.equal(maintenanceReminder({ ...schedule, active: 0, odometer: 20000 }, 'today'), null);
  assert.equal(maintenanceReminder({ ...schedule, vehicleStatus: 'Inactive', odometer: 20000 }, 'today'), null);
  const reset = maintenanceDue({ ...schedule, lastOdometer: 15100 }, 15100);
  assert.equal(reset.nextOdometer, 20100);
  assert.equal(reset.dueSoon, false);
});
