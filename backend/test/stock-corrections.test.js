import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctedStock } from '../src/lib/stock-corrections.js';

test('correcting an issue preserves opening stock and subsequent receipts',()=>{
  const history=[{id:1,type:'Issue',quantity:20},{id:2,type:'Receipt',quantity:5}];
  assert.equal(correctedStock(85,history,1,{type:'Issue',quantity:15}),90);
  assert.equal(correctedStock(85,history,1,{type:'Receipt',quantity:15}),120);
});
test('a later receipt cannot hide insufficient stock created by an earlier correction',()=>{
  const history=[{id:1,type:'Receipt',quantity:10},{id:2,type:'Issue',quantity:10},{id:3,type:'Receipt',quantity:10}];
  assert.throws(()=>correctedStock(10,history,1,{type:'Receipt',quantity:5}),error=>error.status===409);
});
