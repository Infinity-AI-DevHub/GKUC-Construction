import test from 'node:test';
import assert from 'node:assert/strict';
import {MODULE_PERMISSIONS,navigationItems} from './navigation.js';
const items=Object.keys(MODULE_PERMISSIONS).map(name=>[name,null]);
const names=user=>navigationItems(items,user).map(([name])=>name);
test('department roles put their permitted primary workspace second',()=>{
  for(const [role,permission,expected] of [['Finance Department Head','finance.view','Finance'],['HR Department Head','hr.view','People'],
    ['QS Department Head','qs.view','Quantity Surveying'],['Transport Department Head','transport.view','Fleet'],
    ['Store Keeper','store.view','Materials'],['Site Supervisor','site.reports','Site Today'],['Project Coordinator','projects.view','Coordination']]){
    assert.deepEqual(names({role,permissions:[permission,'projects.view']}).slice(0,2),['Dashboard',expected]);
  }
});
test('linked employee department takes priority over a generic or conflicting role',()=>{
  assert.equal(names({role:'Office staff',department:'Human Resources',permissions:['hr.view','finance.manage','projects.view']})[1],'People');
  assert.equal(names({role:'HR Department Head',department:'Finance',permissions:['hr.view','finance.view']})[1],'Finance');
});
test('role labels never grant permissions and denied modules cannot enter the menu',()=>{
  assert.deepEqual(names({role:'Managing Director',permissions:[]}),['Dashboard']);
  assert.deepEqual(names({role:'Finance Department Head',permissions:['chat.use']}),['Dashboard','Chat']);
  assert.ok(!names({permissions:['qs.boq']}).includes('Administration'));
  assert.ok(!names({permissions:['finance.vatSchedules']}).includes('Reports'));
  assert.ok(!names({permissions:['unknown.permission']}).includes('Finance'));
});
test('custom roles use effective capability priority and refresh after grants change',()=>{
  assert.equal(names({role:'Custom role',permissions:['projects.view','finance.invoice']})[1],'Finance');
  assert.equal(names({role:'Custom role',permissions:['projects.view','hr.payroll']})[1],'People');
  assert.ok(names({permissions:['qs.boq']}).includes('Quantity Surveying'));
  assert.ok(names({permissions:['store.lending']}).includes('Fleet'));
  assert.ok(names({permissions:['messages.send']}).includes('Administration'));
});
test('filtering is deterministic and does not mutate navigation definitions',()=>{
  const original=items.map(row=>[...row]);
  const user={role:'Read-Only Viewer',permissions:['finance.view','hr.view','projects.view']};
  assert.deepEqual(names(user),names(user));assert.deepEqual(items,original);
});
