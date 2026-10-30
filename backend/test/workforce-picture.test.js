import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workforcePicture } from '../src/lib/workforce-picture.js';
const person = id => ({ id, name: `Worker ${id}`, workerType: 'Site', employmentStatus: 'Active' });

test('today’s attendance and dated plans take precedence over permanent team assignments', () => {
  const input = { employees: [person(1),person(2),person(3)], leave: [],
    assignments: [1,2,3].map(employeeId => ({employeeId,projectId:1,project:'Site A'})),
    locations: [{employeeId:1,workLocation:'Site',projectId:2,project:'Site B'}, {employeeId:2,workLocation:'Site',projectId:2,project:'Site B'}],
    attendance: [{employeeId:2,state:'On site',workLocation:'Site',projectId:3,project:'Site C'}] };
  const picture = workforcePicture(input,'2026-10-30');
  assert.deepEqual(picture.people.map(row=>row.projectId),[2,3,1]);
  assert.deepEqual(picture.people.map(row=>row.source),['Dated work plan','Attendance','Project team']);
  assert.equal(picture.summary.site,3);
  assert.equal(picture.people.filter(row=>row.attendanceRecorded).length,1);
});

test('leave, absence, suspension, office attendance and business trips do not inflate site crews', () => {
  const employees = Array.from({length:6},(_,i)=>person(i+1));
  employees[2].employmentStatus='Suspended';
  const picture = workforcePicture({employees, assignments: employees.map(row=>({employeeId:row.id,projectId:1,project:'Site A'})), locations:[],
    leave:[{employeeId:1,leaveType:'Annual'}], attendance:[{employeeId:2,state:'Absent',workLocation:'Site',projectId:1},
      {employeeId:4,state:'On site',workLocation:'Office'}, {employeeId:5,state:'Business trip',workLocation:'Site',projectId:1},
      {employeeId:6,state:'Checked out',workLocation:'Site',projectId:1,project:'Site A'}]},'2026-10-30');
  assert.equal(picture.summary.site,1);
  assert.equal(picture.people.find(row=>row.group==='site').id,6);
  assert.equal(picture.people.find(row=>row.id===6).attendanceState,'Checked out');
});

test('legacy name-only attendance cannot attach to two same-name employees', () => {
  const picture = workforcePicture({employees:[{...person(1),name:'Same Name'},{...person(2),name:'Same Name'}],assignments:[],locations:[],leave:[],
    attendance:[{employeeName:'Same Name',state:'On site',workLocation:'Site',projectId:1}]},'2026-10-30');
  assert.equal(picture.summary.site,0);
});
