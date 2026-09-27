import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contributionEligibility } from '../src/lib/statutory-eligibility.js';

const policy = statutory_rules => ({ statutory_rules });
const employee = changes => ({ employment_type:'Permanent',pay_basis:'Monthly salary',basic_salary:30000,
  epf_eligible:true,etf_eligible:true,join_date:'2026-01-01',...changes });

test('GKUC contribution policy checks permanent status, salary and start date independently', () => {
  assert.deepEqual([contributionEligibility(employee({}), policy(null), '2026-02-01').epf,
    contributionEligibility(employee({employment_type:'Temporary'}), policy(null), '2026-02-01').epf,
    contributionEligibility(employee({basic_salary:29999}), policy(null), '2026-02-01').epf,
    contributionEligibility(employee({contribution_start_date:'2026-03-01'}), policy(null), '2026-02-01').epf],
  [true,false,false,false]);
  assert.equal(contributionEligibility(employee({epf_eligible:false}),policy(null),'2026-02-01').epf,false);
  assert.equal(contributionEligibility(employee({epf_eligible:false}),policy(null),'2026-02-01').etf,true);
});

test('new effective-dated rule values can allow temporary staff and change the minimum', () => {
  const later = policy({permanentOnly:false,minimumMonthlySalary:20000,weeklyWeeksPerMonth:52/12,dailyDaysPerMonth:25});
  assert.equal(contributionEligibility(employee({employment_type:'Temporary',basic_salary:22000}),later,'2026-02-01').epf,true);
  assert.equal(contributionEligibility(employee({pay_basis:'Daily rate',daily_rate:1200,basic_salary:0}),policy(null),'2026-02-01').epf,true);
  assert.equal(contributionEligibility(employee({pay_basis:'Weekly rate',weekly_rate:6900,basic_salary:0}),policy(null),'2026-02-01').epf,false);
});
