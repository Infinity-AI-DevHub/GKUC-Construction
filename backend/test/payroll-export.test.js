import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {payrollSheets,payslipDocument} from '../src/lib/payroll-export.js';
import {writeWorkbook} from '../src/lib/xlsx-write.js';
const slip={id:1,employeeCode:'EMP-TEST',employee:'Test <Employee>',designation:'Worker',daysPresent:2,basic:3200,netPay:3212.5,grossEarnings:3312.5,deductions:100,
 officeOtHours:0.5,officeOtPay:112.5,components:[{kind:'Deduction',name:'Test adjustment',amount:100}],
 calculationDetail:JSON.stringify({overtime:[{workDate:'2026-10-01',hours:0.5,rate:225,amount:112.5,type:'Office',source:'Attendance'}],warnings:[{workDate:'2026-10-02',message:'Missing checkout'}]})};
const run={company:'GKUC Construction',reference:'PAY-TEST',periodStart:'2026-10-01',periodEnd:'2026-10-02',payFrequency:'Monthly',status:'Draft',payslips:[slip]};
test('salary workbook preserves numeric saved values and detailed OT',()=>{
 const book=XLSX.read(writeWorkbook(payrollSheets(run)),{type:'buffer'});
 const rows=XLSX.utils.sheet_to_json(book.Sheets['Salary details']);
 assert.equal(rows[0]['Take-home pay'],3212.5);assert.equal(rows[0]['Worked days'],2);
 const ot=XLSX.utils.sheet_to_json(book.Sheets['OT details']);assert.equal(ot[0].Hours,0.5);assert.equal(ot[0]['Pay (LKR)'],112.5);
 assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Warnings)[0].Warning,'Missing checkout');
});
test('payslip escapes names, identifies drafts and separates employer contributions',()=>{
 const html=payslipDocument(run,slip);assert.match(html,/Test &lt;Employee&gt;/);assert.match(html,/provisional, not approved/);
 assert.match(html,/3,212\.50/);assert.match(html,/not employee deductions/);
 assert.doesNotMatch(payslipDocument({...run,status:'Paid'},slip),/provisional/);
});
