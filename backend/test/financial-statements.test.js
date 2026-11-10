import test from 'node:test';
import assert from 'node:assert/strict';
import { financialStatements } from '../src/lib/financial-statements.js';
const fixture = () => ({company:{id:2,name:'Test company'},period:'2024-02',
  accrual:{billedWorkRevenue:1000,revenueAdjustments:50,costAdjustments:25},
  sources:{monthlyExpenses:[{source:'Material',amount:200},{source:'Labour',amount:300},
    {source:'Other',amount:50},{source:'Overhead',originType:'operating_bill',amount:100}],monthlyBills:[{netAmount:100}]},
  workingCapital:{receivables:800,payables:450,payableRows:[{outstanding:300}],billPayables:[{outstanding:100}]},caveats:[]});
const value = (rows,label) => rows.find(row => row.label === label).amount;
test('statements separate direct costs, avoid duplicate bill cost and preserve unknown balances', () => {
  const statement=financialStatements(fixture());
  assert.equal(statement.asAt,'2024-02-29');
  assert.equal(statement.company.id,2);
  assert.equal(value(statement.incomeStatement,'Gross Profit / (Loss)'),550);
  assert.equal(value(statement.incomeStatement,'Total operating expenses'),175);
  assert.equal(value(statement.incomeStatement,'Operating Profit / (Loss) — recorded sources'),375);
  assert.equal(value(statement.incomeStatement,'Net Profit / (Loss)'),null);
  assert.equal(value(statement.financialPosition,'Accounts receivable'),800);
  assert.equal(value(statement.financialPosition,'Payable adjustments'),50);
  for(const label of ['Cash and bank','Total Assets','Capital / share capital','Total Liabilities and Equity'])
    assert.equal(value(statement.financialPosition,label),null,label);
});
test('loss and signed adjustments are retained; empty sources never fabricate a complete balance sheet', () => {
  const pack=fixture();pack.accrual.revenueAdjustments=-900;
  assert.equal(value(financialStatements(pack).incomeStatement,'Operating Profit / (Loss) — recorded sources'),-575);
  pack.sources={monthlyExpenses:[],monthlyBills:[]};
  pack.accrual={billedWorkRevenue:0,revenueAdjustments:0,costAdjustments:0};
  const result=financialStatements(pack);
  assert.equal(value(result.incomeStatement,'Total direct costs'),0);
  assert.equal(value(result.financialPosition,'Total Assets'),null);
});
test('Vehicle source remains a direct project cost in statement totals',()=>{
 const pack=fixture();pack.sources.monthlyExpenses.push({source:'Vehicle',amount:100});const result=financialStatements(pack);
 assert.equal(value(result.incomeStatement,'Vehicle'),100);assert.equal(value(result.incomeStatement,'Total direct costs'),600);
 assert.equal(value(result.incomeStatement,'Total operating expenses'),175);
});
