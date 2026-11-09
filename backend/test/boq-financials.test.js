import test from 'node:test';import assert from 'node:assert/strict';
import {calculateBoqFinancials,detectFinancialRows,detectFinancialColumns} from '../src/lib/boq-financials.js';
import {writeWorkbook} from '../src/lib/xlsx-write.js';import {parseBoqWorkbook} from '../src/lib/boq-template.js';
test('BOQ percentage and fixed adjustments use one subtotal, retain signs and round currency',()=>{
 const result=calculateBoqFinancials(1000,[{label:'VAT',direction:'Add',mode:'Percent',value:18},{label:'Retention',direction:'Deduct',mode:'Percent',value:5},{label:'Discount',direction:'Deduct',mode:'Amount',value:30}]);assert.equal(result.total,1100);assert.deepEqual(result.adjustments.map(r=>r.amount),[180,50,30]);assert.equal(calculateBoqFinancials(1000).total,1000);assert.throws(()=>calculateBoqFinancials(10,[{label:'Over deduction',direction:'Deduct',mode:'Amount',value:11}]),/negative/);
});
test('financial detection reads labelled summary rows and fields across workbook sheets',()=>{
 const xlsx=writeWorkbook([{name:'BOQ',rows:[['Description of work','Unit','Quantity','Rate (LKR)'],['Concrete','m3',2,500]]},{name:'Taxes',rows:[['VAT rate',18],['Other deductions',25]]}]);const parsed=parseBoqWorkbook(xlsx);assert.equal(parsed.ok,true);assert.equal(parsed.financialAdjustments.length,2);assert.equal(parsed.financialAdjustments[0].mode,'Percent');assert.equal(parsed.financialAdjustments[1].direction,'Deduct');
 assert.equal(detectFinancialRows([['VAT 18%','180.00']])[0].value,18);assert.equal(detectFinancialRows([['Deduct: Retention (5% of work subtotal)','-50.00']])[0].value,5);assert.equal(detectFinancialRows([['Tax amount','1,200']])[0].value,1200);assert.deepEqual(detectFinancialRows([['Concrete','m3',2,500]]),[]);
 assert.deepEqual(detectFinancialRows([['Custom deduction','Deduct','Amount',25]]).map(r=>[r.label,r.direction,r.mode,r.value]),[['Custom deduction','Deduct','Amount',25]]);
});

test('explicit tax/deduction column fields are proposed with source values',()=>{
 const rows=detectFinancialColumns([['Description','VAT_PERCENT','Deduction amount'],['Works',18,25]],'Cost sheet');
 assert.deepEqual(rows.map(r=>[r.direction,r.mode,r.value]),[['Add','Percent',18],['Deduct','Amount',25]]);
 assert.match(rows[0].source,/row 2/);
});
