import test from 'node:test';
import assert from 'node:assert/strict';
import {payslipDetail} from '../src/lib/payslip-detail.js';
import {payslipDocument} from '../src/lib/payroll-export.js';
const run={company:'GKUC',reference:'PAY-TEST',periodStart:'2026-10-01',periodEnd:'2026-10-03',status:'Draft',payFrequency:'Monthly'};
const slip={employee:'Example <Employee>',employeeCode:'EMP-1',basic:2000,overtimePay:225,lateDeduction:50,netPay:875,epfEmployeeDeduction:800,
  calculationDetail:{salary:{dailyRate:1600},sourceAttendance:[{workDate:'2026-10-01',state:'Checked out',checkIn:'07:30',checkOut:'09:30'}],
    attendance:[{workDate:'2026-10-01',dailyRate:1600,paidHoursPerDay:8,checkIn:'07:30',checkOut:'09:30',lateDeduction:50,lateMinutes:30,deductibleMinutes:15,shortDay:{amount:1200,workedMinutes:120,paidHoursPerDay:8}}],
    overtime:[{workDate:'2026-10-01',type:'Office',rate:225,hours:1,amount:225}],leave:{dailyRate:1600,days:[{workDate:'2026-10-02',paymentType:'Paid'}]}},
  components:[{name:'Dated deduction',kind:'Deduction',amount:100,calculationDetail:JSON.stringify({date:'2026-10-01',reason:'Reviewed charge'})},
    {name:'Period allowance',kind:'Allowance',amount:300}]};
test('daily breakdown keeps every calendar date, saved punches, short hours, paid leave and dated deductions',()=>{
  const view=payslipDetail(run,slip);
  assert.equal(view.days.length,3);assert.equal(view.days[0].source[0].checkOut,'09:30');
  assert.equal(view.days[0].basic,400);assert.equal(view.days[0].shortReduction,1200);
  assert.equal(view.days[0].subtotal,475);assert.equal(view.days[0].minus,100);
  assert.equal(view.days[1].basic,1600);assert.equal(view.days[1].state,'Paid leave');
  assert.equal(view.days[2].basic,0);assert.equal(view.days[2].state,'No recorded work');
  assert.equal(view.periodComponents.length,1);assert.deepEqual(view.reconciliation,{basic:0,ot:0,late:0});
  assert.equal(view.days.reduce((sum,row)=>sum+row.subtotal,0)+300-800-700,875,'period allowance, EPF and advance applied once');
});
test('older payroll never invents missing attendance or dates for recurring components',()=>{
  const old={...slip,calculationDetail:{attendance:slip.calculationDetail.attendance},components:[{name:'Undated charge',kind:'Deduction',amount:100}]};
  const view=payslipDetail(run,old);
  assert.equal(view.complete,false);assert.equal(view.days[1].basic,null);assert.equal(view.days[1].state,'No saved entry');
  assert.equal(view.days[0].adjustments.length,0);assert.equal(view.periodComponents.length,1);
  const html=payslipDocument(run,old);assert.match(html,/complete attendance snapshot was not captured/);
  assert.match(html,/Example &lt;Employee&gt;/);assert.doesNotMatch(html,/Example <Employee>/);
  assert.match(html,/Daily salary breakdown/);assert.match(html,/Undated charge/);
});
test('Sunday work stays payable and out-of-period component dates are kept as period items',()=>{
  const sundayRun={...run,periodStart:'2026-10-04',periodEnd:'2026-10-04'};
  const person={...slip,basic:1600,overtimePay:0,lateDeduction:0,calculationDetail:{salary:{dailyRate:1600},sourceAttendance:[{workDate:'2026-10-04',state:'Checked out',checkIn:'07:30',checkOut:'16:30'}]},
    components:[{name:'Unallocated item',kind:'Allowance',amount:50,calculationDetail:JSON.stringify({date:'2026-10-03'})}]};
  const view=payslipDetail(sundayRun,person);
  assert.equal(view.days[0].basic,1600);assert.equal(view.days[0].subtotal,1600);
  assert.equal(view.periodComponents.length,1);assert.equal(view.days[0].adjustments.length,0);
});
