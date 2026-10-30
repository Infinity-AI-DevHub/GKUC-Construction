import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('startup never recreates payroll uniqueness across companies', async () => {
  const source = await readFile(new URL('../src/schema.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UNIQUE KEY uq_payroll_period(?:_frequency)?\s*\(/);
  const companyColumn = source.indexOf("await addColumn('payroll_runs', 'company_id'");
  const companyIndex = source.indexOf("await addIndex('payroll_runs', 'uq_payroll_company_period_frequency'");
  assert.ok(companyColumn > 0 && companyIndex > companyColumn);
  assert.match(source, /UNIQUE KEY uq_payroll_company_period_frequency\(company_id,period_start,period_end,pay_frequency\)/);
  assert.match(source, /dropIndex\('payroll_runs', 'uq_payroll_period_frequency'\)/);
});
