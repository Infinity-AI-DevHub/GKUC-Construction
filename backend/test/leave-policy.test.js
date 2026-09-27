import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addCalendarMonths} from '../src/lib/leave-policy.js';

test('leave waiting period ends on the clamped calendar-month anniversary',()=>{
  assert.equal(addCalendarMonths('2026-08-31',6),'2027-02-28');
  assert.equal(addCalendarMonths('2027-01-31',1),'2027-02-28');
  assert.equal(addCalendarMonths('2026-01-15',0),'2026-01-15');
});
