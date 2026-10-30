import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateCheque} from '../src/lib/cheque-allocations.js';
const invoices=[{id:2,invoiceNo:'B',invoiceDate:'2026-10-20',availableAmount:200.5},{id:1,invoiceNo:'A',invoiceDate:'2026-10-10',availableAmount:100.25},{id:3,invoiceNo:'C',invoiceDate:'2026-10-25',availableAmount:300.75}];
test('one cheque settles the selected invoice balances exactly',()=>{
 const plan=allocateCheque(invoices,601.5);
 assert.equal(plan.invoiceTotal,601.5);assert.equal(plan.overridden,false);
 assert.deepEqual(plan.allocations.map(row=>row.amount),[100.25,200.5,300.75]);
});
test('an adjusted amount requires a reason and allocates oldest first in cents',()=>{
 assert.throws(()=>allocateCheque(invoices,250.5),/reason/);
 const plan=allocateCheque(invoices,250.5,'Part settlement agreed');
 assert.equal(plan.overridden,true);
 assert.deepEqual(plan.allocations.map(row=>[row.invoiceId,row.amount]),[[1,100.25],[2,150.25],[3,0]]);
 assert.equal(plan.allocations.reduce((sum,row)=>sum+Math.round(row.amount*100),0),25050);
});
test('overpayments and fully reserved invoices cannot be allocated',()=>{
 assert.throws(()=>allocateCheque(invoices,700,'Advance requested'),error=>error.status===409);
 assert.throws(()=>allocateCheque([{...invoices[0],availableAmount:0}],1,'Override'),error=>error.status===409);
});
