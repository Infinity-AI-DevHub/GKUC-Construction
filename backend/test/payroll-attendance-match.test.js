import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceForEmployee,salaryCalculationIssues} from '../src/lib/payroll-attendance-match.js';
const person={id:1,name:'Test Employee'};
test('legacy attendance matches trimmed collapsed case-insensitive names while explicit IDs win',()=>{
  const records=[{employee_id:null,employee_name:' TEST   employee '},{employee_id:1,employee_name:'Old name'},
    {employee_id:2,employee_name:'Test Employee'},{employee_id:null,employee_name:'Other'}];
  assert.equal(attendanceForEmployee(person,records,[person]).length,2);
  assert.equal(attendanceForEmployee(person,records,[person,{id:2,name:' test employee '}]).length,1);
});
test('salary issues distinguish missing days, missing daily rate and deductions',()=>{
  assert.deepEqual(salaryCalculationIssues({days_present:2,daily_rate:1600},{basic:3200,netPay:3000}),[]);
  assert.match(salaryCalculationIssues({days_present:0,daily_rate:1600},{basic:0,netPay:0})[0],/No worked attendance/);
  assert.match(salaryCalculationIssues({days_present:2,daily_rate:0},{basic:0,netPay:0})[0],/Daily salary rate/);
  assert.match(salaryCalculationIssues({days_present:2,daily_rate:1600},{basic:3200,netPay:0})[0],/Deductions/);
});
