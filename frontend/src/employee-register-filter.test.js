import test from 'node:test';
import assert from 'node:assert/strict';
import {filterEmployeeRegister} from './employee-register-filter.js';
const rows=[{id:1,name:'Anne Silva',code:'EMP-101',department:'HR',designation:'HR officer',workerType:'Office',status:'Active'},
  {id:2,name:'Nimal Perera',code:'BIO-202',department:'Operations',designation:'Driver',workerType:'Driver',status:'On leave'}];
test('employee register searches names, codes and designations with case insensitive words',()=>{
  for(const search of ['ANNE','emp-101','officer','silva hr'])assert.deepEqual(filterEmployeeRegister(rows,{search}).map(row=>row.id),[1]);
  assert.equal(filterEmployeeRegister(rows,{search:'missing'}).length,0);
});
test('employee register combines filters with search and resets without modifying source rows',()=>{
  assert.equal(filterEmployeeRegister(rows,{search:'perera',department:'Operations',workerType:'Driver',status:'On leave'}).length,1);
  assert.equal(filterEmployeeRegister(rows,{search:'perera',status:'Active'}).length,0);
  assert.equal(filterEmployeeRegister(rows,{}).length,2);assert.equal(rows.length,2);
});
