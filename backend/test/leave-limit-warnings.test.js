import test from 'node:test';
import assert from 'node:assert/strict';
import {leaveLimitWarnings} from '../src/lib/leave-limit-warnings.js';
const employee={annual:14,casual:7},policy={monthly_limit:5};
test('annual and monthly overages warn without rejecting and rejected leave does not consume allowance',()=>{
  const request={leaveType:'Annual',fromDate:'2027-02-01',toDate:'2027-02-10'};
  const prior=[{leave_type:'Annual',from_date:'2027-01-01',to_date:'2027-01-10',status:'Approved'}];
  const warnings=leaveLimitWarnings(employee,policy,request,prior);
  assert.ok(warnings.some(row=>row.includes('exceeded by 6')));
  assert.ok(warnings.some(row=>row.includes('2027-02 advisory')));
  assert.equal(leaveLimitWarnings(employee,policy,{...request,toDate:'2027-02-05'},[{...prior[0],status:'Rejected'}]).length,0);
});
test('cross-month/year requests use only days in each balance period and separate casual allowances',()=>{
  const warnings=leaveLimitWarnings(employee,policy,{leaveType:'Annual',fromDate:'2027-12-25',toDate:'2028-01-04'},[]);
  assert.equal(warnings.length,1);assert.ok(warnings[0].includes('2027-12'));
  assert.equal(leaveLimitWarnings(employee,policy,{leaveType:'Casual',fromDate:'2028-02-01',toDate:'2028-02-04'},[
    {leave_type:'Annual',from_date:'2028-01-01',to_date:'2028-01-31',status:'Approved'}]).length,0);
});
