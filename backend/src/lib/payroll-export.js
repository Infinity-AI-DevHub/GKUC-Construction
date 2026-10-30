const fields=[['Employee code','employeeCode'],['Employee','employee'],['Worked days','daysPresent'],['Absent days','daysAbsent'],['Paid leave days','paidLeaveDays'],['Unpaid leave days','unpaidLeaveDays'],['Payable days','payableDays'],['Earned salary','basic'],['Paid leave pay (included in salary)','paidLeavePay'],['Office OT hours','officeOtHours'],['Office OT pay','officeOtPay'],['Site OT hours','siteOtHours'],['Site OT pay','siteOtPay'],['Travel OT hours','travelOtHours'],['Travel OT pay','travelOtPay'],['Allowances','allowanceTotal'],['Reimbursements','reimbursementTotal'],['Gross earnings','grossEarnings'],['Late minutes','lateMinutes'],['Late deduction','lateDeduction'],['Employee EPF','epfEmployeeDeduction'],['Other deductions','otherDeduction'],['Salary advance recovery','salaryAdvanceDeduction'],['Total deductions','deductions'],['Take-home pay','netPay'],['EPF/ETF salary basis','contributionBase'],['Employer EPF','epfEmployerContribution'],['Employer ETF','etfEmployerContribution'],['Employer cost','employerCost']];
const parse=value=>typeof value==='string'?JSON.parse(value):value||{};
const sheet=(name,headers,rows)=>({name,columns:headers.map((_,i)=>i<2?28:20),freeze:1,rows:[headers.map(value=>({value,style:1})),...rows]});
export function payrollSheets(run){
  const ot=[],attendance=[],leave=[],components=[],warnings=[],advances=[];
  for(const slip of run.payslips){
    const d=parse(slip.calculationDetail),who=[slip.employeeCode,slip.employee];
    for(const row of d.overtime||[])ot.push([...who,row.workDate,row.type,row.source,Number(row.hours),Number(row.rate),Number(row.amount),row.policyId]);
    for(const row of d.attendance||[])attendance.push([...who,row.workDate,row.checkIn,row.checkOut,row.normalStart,row.normalEnd,Number(row.dailyRate),Number(row.lateMinutes),Number(row.deductibleMinutes||0),Number(row.lateDeduction),row.policyId,row.shortDay?.workedMinutes == null ? null : row.shortDay.workedMinutes/60,row.shortDay?.paidHoursPerDay ?? null,Number(row.shortDay?.amount||0)]);
    for(const row of d.leave?.days||[])leave.push([...who,row.workDate,row.paymentType,row.leaveType,(row.requestIds||[]).join(', ')]);
    for(const row of slip.components||[])components.push([...who,row.kind,row.name,Number(row.amount),row.calculationDetail]);
    for(const row of slip.advanceRecoveries||[])advances.push([...who,row.advanceDate,row.description,Number(row.amount)]);
    for(const row of d.warnings||[])warnings.push([...who,row.workDate,row.message]);
  }
  return [sheet('Run',['Company','Reference','From','To','Frequency','Status','Currency'],[[run.company,run.reference,run.periodStart,run.periodEnd,run.payFrequency,run.status,'LKR']]),
    sheet('Salary details',fields.map(([label])=>label),run.payslips.map(s=>fields.map(([,key],i)=>i<2?s[key]:Number(s[key]||0)))),
    sheet('OT details',['Code','Employee','Date','Type','Source','Hours','Rate (LKR)','Pay (LKR)','Policy'],ot),
    sheet('Attendance and lateness',['Code','Employee','Date','In','Out','Normal start','Normal end','Daily rate','Late minutes','Deductible minutes','Deduction','Policy','Normal hours worked','Paid hours per day','Short-day reduction (already excluded from earned salary)'],attendance),
    sheet('Leave',['Code','Employee','Date','Payment','Type','Requests'],leave),
    sheet('Pay components',['Code','Employee','Type','Name','Amount (LKR)','Calculation'],components),
    sheet('Advance recoveries',['Code','Employee','Advance date','Description','Recovered (LKR)'],advances),
    sheet('Warnings',['Code','Employee','Date','Warning'],warnings)];
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>Number(value||0).toLocaleString('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2});
export function payslipDocument(run,slip){
  const shortDayReduction=(parse(slip.calculationDetail).attendance||[]).reduce((sum,row)=>sum+Number(row.shortDay?.amount||0),0);
  const rows=list=>list.map(([label,value])=>`<tr><td>${esc(label)}</td><td class="amount">${money(value)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payslip ${esc(slip.employeeCode)}</title><style>
  @page{size:A4;margin:18mm}*{box-sizing:border-box}body{font:12px Arial,sans-serif;color:#20342d;margin:0}header{border-bottom:3px solid #ba1238;padding-bottom:18px}h1{font-size:24px;margin:8px 0}h2{font-size:14px;margin-top:24px}p{line-height:1.6}table{width:100%;border-collapse:collapse}td{padding:9px 6px;border-bottom:1px solid #dee5e1}.amount{text-align:right;font-variant-numeric:tabular-nums}.net{background:#eaf3ed;padding:16px;margin-top:20px;font-size:18px;display:flex;justify-content:space-between}.status{font-weight:bold;color:#ba1238}footer{margin-top:30px;font-size:10px;color:#54675e}tr{break-inside:avoid}</style></head><body>
  <header><strong>${esc(run.company)}</strong><h1>Salary payslip</h1><span>${esc(run.reference)} | ${esc(run.payFrequency)} | ${esc(run.periodStart)} to ${esc(run.periodEnd)}</span><p class="status">${esc(run.status)}${run.status==='Draft'?' - provisional, not approved':''}</p></header>
  <h2>${esc(slip.employee)}</h2><p>${esc(slip.employeeCode)} | ${esc(slip.designation)}<br>Worked: ${esc(slip.daysPresent)} days | Paid leave: ${esc(slip.paidLeaveDays||0)} | Unpaid leave: ${esc(slip.unpaidLeaveDays||0)}</p>
  <h2>Earnings (LKR)</h2><table>${rows([['Earned salary (includes paid leave)',slip.basic],['Office OT',slip.officeOtPay],['Site OT',slip.siteOtPay],['Travel OT',slip.travelOtPay],['Allowances',slip.allowanceTotal],['Gross earnings',slip.grossEarnings],['Reimbursements (outside gross)',slip.reimbursementTotal]])}</table>
  ${shortDayReduction>0?`<p>Earned salary above is already reduced by LKR ${money(shortDayReduction)} for missing normal work hours. This is not deducted again below.</p>`:''}
  <h2>Deductions (LKR)</h2><table>${rows([['Employee EPF',slip.epfEmployeeDeduction],['Late deduction',slip.lateDeduction],['Other deductions',slip.otherDeduction],['Salary advance recovery',slip.salaryAdvanceDeduction],['Total deductions',slip.deductions]])}</table>
  <div class="net"><span>Take-home pay</span><strong>LKR ${money(slip.netPay)}</strong></div>
  ${(slip.components||[]).length?`<h2>Component breakdown (already included above)</h2><table>${rows(slip.components.map(c=>[`${c.kind}: ${c.name}`,c.amount]))}</table>`:''}
  <footer>Employer EPF: LKR ${money(slip.epfEmployerContribution)} | Employer ETF: LKR ${money(slip.etfEmployerContribution)}. Employer contributions are not employee deductions.<br>Saved payroll snapshot. Currency: LKR.</footer></body></html>`;
}
