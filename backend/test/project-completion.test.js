import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCompletion } from '../src/lib/project-completion.js';

test('explicit completion sets consistent health, progress and site status', () => {
  assert.deepEqual(projectCompletion({stage:'Completed',health:'Watch',progress:35,budget:500}),
    {stage:'Completed',health:'Completed',progress:100,budget:500,site_status:'Completed'});
  assert.equal(projectCompletion({budget:500},{stage:'Completed'}).health,'Completed');
});
test('100 percent progress is not automatic completion and completed health requires completion', () => {
  assert.deepEqual(projectCompletion({progress:100},{stage:'Mid-way'}),{progress:100});
  assert.throws(()=>projectCompletion({health:'Completed'},{stage:'Mid-way'}),error=>error.status===400);
});
test('reopening restores active site status and a working health label', () => {
  assert.deepEqual(projectCompletion({stage:'Mid-way',progress:80},{stage:'Completed'}),
    {stage:'Mid-way',progress:80,health:'On track',site_status:'Active'});
});
