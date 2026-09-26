import test from 'node:test';
import assert from 'node:assert/strict';
import {insuranceReminderDate} from '../src/lib/insurance-reminders.js';
test('insurance reminders support arbitrary days, weeks, months and exact dates',()=>{
  assert.equal(insuranceReminderDate('2027-03-31',{unit:'Months',value:1}),'2027-02-28');
  assert.equal(insuranceReminderDate('2028-03-31',{unit:'Months',value:1}),'2028-02-29');
  assert.equal(insuranceReminderDate('2027-01-05',{unit:'Weeks',value:1}),'2026-12-29');
  assert.equal(insuranceReminderDate('2027-01-05',{unit:'Days',value:5}),'2026-12-31');
  assert.equal(insuranceReminderDate('2027-01-05',{unit:'Days',value:0}),'2027-01-05');
  assert.equal(insuranceReminderDate('2027-01-05',{unit:'Date',date:'2026-11-01'}),'2026-11-01');
});
