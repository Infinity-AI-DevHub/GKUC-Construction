import test from 'node:test';
import assert from 'node:assert/strict';
import {valueProgress,progressTotals} from '../src/lib/progress-valuation.js';
const items=[{code:'A1',description:'Drain',unit:'m',quantity:100,rate:1000}];
test('provisional sums use percentage completion and note rows never add money',()=>{
  const schedule=[{code:'N',basis:'Note',description:'Contract conditions',quantity:1,rate:0},
    {code:'PS',basis:'Percentage',description:'Facilities',quantity:1,rate:50000}];
  const before=valueProgress(schedule,{N:0,PS:.5});
  const current=valueProgress(schedule,{N:0,PS:.8},before);
  assert.equal(current[0].current,0);assert.equal(current[1].current,15000);assert.equal(current[1].cumulative,40000);
  assert.throws(()=>valueProgress(schedule,{N:1,PS:.8}));
});
test('progress applications use certified history rather than payments or previous submitted totals',()=>{
  const previous=valueProgress(items,{A1:20});
  const lines=valueProgress(items,{A1:50},previous);
  assert.equal(lines[0].previousAmount,20000);assert.equal(lines[0].current,30000);assert.equal(lines[0].cumulative,50000);
  assert.throws(()=>valueProgress(items,{A1:10},previous));assert.throws(()=>valueProgress(items,{A1:101}));assert.throws(()=>valueProgress(items,{UNKNOWN:1}));
});
test('certificate arithmetic separates retention and advance recovery from stamp duty after VAT',()=>{
  const result=progressTotals([{current:2193254.04}],{retention:200943.33,advance:731084.68,vatRate:18,taxBasis:'After recoveries',stampDuty:25});
  assert.equal(result.netBeforeVat,1261226.03);assert.equal(result.vat,227020.69);assert.equal(result.net,1488221.72);
  assert.throws(()=>progressTotals([{current:10}],{retention:20}));
});
