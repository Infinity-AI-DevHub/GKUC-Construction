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
  assert.equal(contributionEligibility(employee({pay_basis:'Daily rate',daily_rate:1200,basic_salary:30000}),policy(null),'2026-02-01').epf,true);
  assert.equal(contributionEligibility(employee({pay_basis:'Weekly rate',weekly_rate:6900,basic_salary:29999}),policy(null),'2026-02-01').epf,false);
});

test('contribution explanations distinguish eligibility, run frequency and rate without changing eligibility',async()=>{
  const {contributionExplanation}=await import('../src/lib/statutory-eligibility.js');
  const rates={id:7,epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3};
  const before=employee({});
  const good=contributionExplanation(before,rates,'2026-02-01','Monthly');
  assert.deepEqual(good.epfReasons,[]);assert.equal(good.basis,30000);assert.equal(good.employeeEpfRate,8);
  assert.ok(contributionExplanation(before,rates,'2026-02-01','Weekly').epfReasons.some(reason=>reason.includes('Weekly')));
  const excluded=contributionExplanation(employee({epf_eligible:false,employment_type:'Probation',basic_salary:0,contribution_start_date:'2026-03-01'}),{...rates,epf_employee_rate:0},'2026-02-01','Monthly');
  for (const text of ['Probation','below','2026-03-01','disabled','rate is zero']) assert.ok(excluded.epfReasons.some(reason=>reason.includes(text)),text);
  assert.equal(before.epf_eligible,true);
});

test('monthly contribution rate validation blocks zero eligible rates without affecting exclusions or weekly pay',async()=>{
  const {contributionRateProblems}=await import('../src/lib/statutory-eligibility.js');
  const zero={epf_employee_rate:0,epf_employer_rate:0,etf_employer_rate:0};
  assert.deepEqual(contributionRateProblems({epf_eligible:true,etf_eligible:true},zero,'Monthly'),['Employee EPF','Employer EPF','Employer ETF']);
  assert.deepEqual(contributionRateProblems({epf_eligible:false,etf_eligible:false},zero,'Monthly'),[]);
  assert.deepEqual(contributionRateProblems({epf_eligible:true,etf_eligible:true},zero,'Weekly'),[]);
  assert.deepEqual(contributionRateProblems({epf_eligible:true,etf_eligible:true},{epf_employee_rate:8,epf_employer_rate:12,etf_employer_rate:3},'Monthly'),[]);
});
