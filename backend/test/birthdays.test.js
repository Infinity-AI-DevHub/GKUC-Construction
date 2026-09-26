import test from 'node:test';
import assert from 'node:assert/strict';
import {upcomingBirthday, BIRTHDAY_REMINDER_DAYS} from '../src/lib/birthdays.js';

test('birthday reminders cover the requested unique milestones', () => {
  assert.deepEqual(BIRTHDAY_REMINDER_DAYS, [7,5,3,1,0]);
  for (const days of BIRTHDAY_REMINDER_DAYS) {
    const stamp = `2026-09-${String(27-days).padStart(2,'0')}`;
    assert.equal(upcomingBirthday('1990-09-27',stamp).remaining,days);
  }
});
test('birthdays handle year boundaries, past birthdays and leap years', () => {
  assert.deepEqual(upcomingBirthday('1990-01-02','2026-12-26'), {date:'2027-01-02',remaining:7});
  assert.equal(upcomingBirthday('1990-09-27','2026-09-28').date,'2027-09-27');
  assert.deepEqual(upcomingBirthday('2000-02-29','2027-02-28'), {date:'2027-02-28',remaining:0});
  assert.deepEqual(upcomingBirthday('2000-02-29','2028-02-28'), {date:'2028-02-29',remaining:1});
  assert.equal(upcomingBirthday(null,'2026-09-27'),null);
});
