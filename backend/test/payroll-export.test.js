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
 assert.equal(book.SheetNames[0],'Salary details','open the employee summary, not the run metadata');
 const rows=XLSX.utils.sheet_to_json(book.Sheets['Salary details']);
 assert.equal(rows[0]['Take-home pay'],3212.5);assert.equal(rows[0]['Worked days'],2);
 const ot=XLSX.utils.sheet_to_json(book.Sheets['OT details']);assert.equal(ot[0].Hours,0.5);assert.equal(ot[0]['Pay (LKR)'],112.5);
 assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Warnings)[0].Warning,'Missing checkout');
});

test('every employee gets all calendar days, saved punches, OT, deductions and period totals',()=>{
 const person={...slip,basic:2000,overtimePay:225,lateDeduction:50,netPay:875,
   calculationDetail:{employee:{name:'Saved employee name',designation:'Saved role'},salary:{dailyRate:1600},
     sourceAttendance:[{workDate:'2026-10-01',state:'Checked out',checkIn:'07:30',checkOut:'09:30'}],
     attendance:[{workDate:'2026-10-01',dailyRate:1600,lateMinutes:45,deductibleMinutes:15,lateDeduction:50,shortDay:{amount:1200}}],
     overtime:[{workDate:'2026-10-01',type:'Office',hours:1,rate:225,amount:225,source:'Reviewed OT'}],
     leave:{days:[{workDate:'2026-10-02',paymentType:'Paid'}]}},
   components:[{kind:'Deduction',name:'Reviewed daily charge',amount:100,calculationDetail:JSON.stringify({date:'2026-10-01',reason:'Reviewed charge'})},
     {kind:'Allowance',name:'Period transport',amount:300}],epfEmployeeDeduction:800,salaryAdvanceDeduction:700};
 const source={...run,periodEnd:'2026-10-03',payslips:[person,{...person,employeeCode:'EMP-SECOND'}]};
 const before=JSON.stringify(source);
 const book=XLSX.read(writeWorkbook(payrollSheets(source)),{type:'buffer'});
 for(const code of ['EMP-TEST','EMP-SECOND']){
   const name=book.SheetNames.find(name=>name.startsWith(code));assert.ok(name);
   const grid=XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:null});
   assert.equal(grid[2][1],'Saved employee name');
   assert.deepEqual(grid.slice(8,11).map(row=>row[0]),['2026-10-01','2026-10-02','2026-10-03']);
   assert.equal(grid[8][2],'07:30');assert.equal(grid[8][3],'09:30');
   assert.equal(grid[8][5],400);assert.equal(grid[8][6],1);assert.equal(grid[8][7],225);
   assert.equal(grid[8][10],50);assert.equal(grid[8][13],100);assert.equal(grid[8][14],475);
   assert.equal(grid[8][15],1200);assert.match(grid[8][16],/Office OT: 1 h x 225/);
   assert.equal(grid[9][5],1600);assert.equal(grid[10][5],0);
   assert.equal(grid.find(row=>row[0]==='TAKE-HOME PAY')[1],875);
   assert.equal(grid.find(row=>row[0]==='Employee EPF')[1],800);
   assert.ok(grid.some(row=>row[0]==='Period-wide / date not saved'&&row[2]==='Period transport'&&row[3]===300));
 }
 assert.equal(JSON.stringify(source),before,'export must not mutate or recalculate the payroll');
});

test('employee sheet names are valid and unique and older payroll does not invent daily earnings',()=>{
 const person={...slip,employeeCode:'EMP[]:*?/\\',employee:"Same / name"};
 const book=XLSX.read(writeWorkbook(payrollSheets({...run,payslips:[person,{...person,employee:'same / name'}]})),{type:'buffer'});
 assert.equal(new Set(book.SheetNames.map(name=>name.toLowerCase())).size,book.SheetNames.length);
 assert.ok(book.SheetNames.every(name=>name.length<=31&&!/[\[\]:*?/\\]/.test(name)));
 const grid=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[1]],{header:1,defval:null});
 assert.match(grid[4][0],/complete attendance was not saved/);
 assert.equal(grid[8][5],null);assert.equal(grid[9][5],null);
 assert.equal(grid.find(row=>row[0]==='TAKE-HOME PAY')[1],3212.5);
 assert.ok(grid.some(row=>row[0]==='Earned salary'&&row[1]===3200));
});
test('payslip escapes names, identifies drafts and separates employer contributions',()=>{
 const html=payslipDocument(run,slip);assert.match(html,/Test &lt;Employee&gt;/);assert.match(html,/provisional, not approved/);
 assert.match(html,/3,212\.50/);assert.match(html,/not employee deductions/);
 assert.doesNotMatch(payslipDocument({...run,status:'Paid'},slip),/provisional/);
});
