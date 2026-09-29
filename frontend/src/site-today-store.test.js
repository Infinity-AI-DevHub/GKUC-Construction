import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeness,draftKey} from './site-today-store.js';

test('field completeness shows exact progress without treating zero workforce as missing',()=>{
  const draft={projectId:4,workforce:0,materials:[{materialId:2,quantity:0}],work:'Site closed today',photos:[]};
  assert.equal(completeness(draft),4);
  assert.equal(completeness({...draft,photos:[{name:'progress.jpg'}]}),5);
  assert.equal(completeness({...draft,work:''}),3);
});

test('offline drafts are partitioned by user, project and work date',()=>{
  assert.notEqual(draftKey(1,2,'2026-09-29'),draftKey(2,2,'2026-09-29'));
  assert.notEqual(draftKey(1,2,'2026-09-29'),draftKey(1,3,'2026-09-29'));
});
