import test from 'node:test';
import assert from 'node:assert/strict';
import {missingCheckout} from './attendance-flags.js';
test('a check-in without checkout is flagged even if the stored status says checked out',()=>{
  for(const state of ['On site','Late','Checked out'])assert.equal(missingCheckout({in:'07:41:00',out:null,state}),true);
});
test('complete, out-only, absent, leave and business trip records are not missing checkout',()=>{
  for(const row of [{in:'07:00',out:'16:30',state:'Checked out'},{in:null,out:'16:37',state:'Checked out'},
    {in:null,out:null,state:'Absent'},...['Absent','On leave','Business trip'].map(state=>({in:'07:00',out:null,state}))])
    assert.equal(missingCheckout(row),false);
});
