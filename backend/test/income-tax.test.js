import test from 'node:test';
import assert from 'node:assert/strict';
import {incomeTax} from '../src/lib/income-tax.js';
test('no-tax income ignores a supplied VAT rate and keeps the entered total',()=>{
  assert.deepEqual(incomeTax(1000,{taxTreatment:'None',vatRate:18,amountIncludesVat:true}),
    {taxTreatment:'None',vatRate:0,netAmount:1000,vatAmount:0,totalAmount:1000});
});
test('exclusive VAT adds tax once',()=>{
  assert.deepEqual(incomeTax(1000,{taxTreatment:'Standard',vatRate:18}),
    {taxTreatment:'Standard',vatRate:18,netAmount:1000,vatAmount:180,totalAmount:1180});
});
test('excluding tracking never extracts VAT from the entered receipt',()=>{
  const result=incomeTax(1180,{taxTreatment:'None',vatRate:18});
  assert.equal(result.netAmount,1180);assert.equal(result.vatAmount,0);assert.equal(result.totalAmount,1180);
});
