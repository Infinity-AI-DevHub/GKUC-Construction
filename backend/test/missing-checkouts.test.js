import test from 'node:test';
import assert from 'node:assert/strict';
import {colomboClock} from '../src/lib/missing-checkouts.js';
test('checkout deadlines use Sri Lanka time including the midnight boundary',()=>{
  assert.deepEqual(colomboClock(new Date('2026-10-24T10:59:00Z')),{day:'2026-10-24',time:'16:29'});
  assert.deepEqual(colomboClock(new Date('2026-10-24T11:00:00Z')),{day:'2026-10-24',time:'16:30'});
  assert.deepEqual(colomboClock(new Date('2026-10-24T19:00:00Z')),{day:'2026-10-25',time:'00:30'});
});
