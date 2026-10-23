import test from 'node:test';
import assert from 'node:assert/strict';
import {leavePaymentEligibility} from './leave-payment.js';

const policy={id:1,effective_from:'2020-01-01',waiting_months:6,allow_unpaid_during_wait:1};
test('waiting period offers only Unpaid; paid leave becomes available on the eligibility date',()=>{
  assert.deepEqual(leavePaymentEligibility('2026-10-01',[policy],'2026-10-23').options,['Unpaid']);
  const eligible=leavePaymentEligibility('2026-10-01',[policy],'2027-04-01');
  assert.equal(eligible.eligibleFrom,'2027-04-01');
  assert.deepEqual(eligible.options,['Paid','Unpaid']);
});
test('date-specific waiting months replace the former hard-coded six months',()=>{
  const later={...policy,id:2,effective_from:'2026-10-01',waiting_months:0};
  assert.deepEqual(leavePaymentEligibility('2026-10-01',[policy,later],'2026-10-23').options,['Paid','Unpaid']);
  assert.equal(leavePaymentEligibility('2026-09-01',[policy,later],'2026-09-30').paidAllowed,false);
});
test('blocked waiting period, missing policy and missing employment date offer no invalid choice',()=>{
  assert.deepEqual(leavePaymentEligibility('2026-10-01',[{...policy,allow_unpaid_during_wait:0}],'2026-10-23').options,[]);
  assert.deepEqual(leavePaymentEligibility('2026-10-01',[],'2026-10-23').options,[]);
  assert.deepEqual(leavePaymentEligibility('',[policy],'2026-10-23').options,[]);
});
test('calendar-month waiting periods clamp end-of-month dates',()=>{
  assert.equal(leavePaymentEligibility('2026-08-31',[policy],'2027-03-01').eligibleFrom,'2027-02-28');
});
