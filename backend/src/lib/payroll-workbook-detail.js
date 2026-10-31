import {payslipDetail} from './payslip-detail.js';

const header = values => values.map(value => ({value,style:1}));
const number = value => value == null ? null : Number(value);
const cash = value => Math.round((Number(value || 0)+Number.EPSILON)*100)/100;
const amount = value => value == null ? null : ({value:cash(value),style:3});
const sum = (rows,key) => cash(rows.reduce((total,row)=>total+Number(row[key]||0),0));
const time = rows => [...new Set(rows.filter(Boolean).map(value=>String(value).slice(0,8)))].join(' / ') || null;

export function employeePayrollSheets(run,reserved=[]) {
  const names=new Set(reserved.map(name=>name.toLowerCase()));
  return run.payslips.map(slip=>{
    const view=payslipDetail(run,slip),identity=view.detail.employee||{};
    const base=String(`${slip.employeeCode || 'Employee'} ${identity.name || slip.employee || ''}`)
      .replace(/[\[\]:*?/\\\x00-\x1f]/g,' ').replace(/\s+/g,' ').replace(/^'+|'+$/g,'').trim() || 'Employee';
    let name=base.slice(0,31),suffix=2;
    while(names.has(name.toLowerCase())) {const tail=` (${suffix++})`;name=base.slice(0,31-tail.length)+tail;}
    names.add(name.toLowerCase());
    const dailyHeaders=['Date','Attendance / leave','Check-in','Check-out','Daily rate (LKR)',
      'Earned salary (LKR)','OT hours','OT pay (LKR)','Late minutes','Charged late minutes',
      'Late deduction (LKR)','Dated allowances (LKR)','Dated reimbursements (LKR)',
      'Dated other deductions (LKR)','Daily subtotal (LKR)','Short-day reduction (already excluded)','Details'];
    const datedKind=(day,kind)=>cash(day.adjustments.filter(row=>row.kind===kind).reduce((total,row)=>total+row.amount,0));
    const rows=[header([run.company || 'Company','SALARY DETAILS']),
      ['Payroll',run.reference,'Period',run.periodStart,'To',run.periodEnd,'Frequency',run.payFrequency,'Status',run.status],
      ['Employee',identity.name || slip.employee,'Code',identity.code || slip.employeeCode],
      ['Designation',identity.designation || slip.designation || 'Not saved','Department',identity.department || slip.department || 'Not saved'],
      [{value:view.complete?'Daily detail uses the attendance and calculation saved in this payroll.':'Older payroll: complete attendance was not saved. Missing dates and amounts are not reconstructed from current records.',style:4}],
      [{value:'Daily subtotal excludes period-wide EPF, recurring components and advance recovery. Short-day reduction is already removed from earned salary; do not deduct it twice.',style:4}],
      [],header(dailyHeaders)];
    for(const day of view.days) {
      const punches=day.source.length?day.source:day.attendance;
      const notes=[...day.overtime.map(ot=>`${ot.type} OT: ${ot.hours} h x ${ot.rate} = ${ot.amount} (${ot.source || 'Saved'})`),
        ...day.adjustments.map(row=>`${row.kind}: ${row.name} (${row.amount})`),...day.warnings.map(row=>row.message)];
      rows.push([day.date,day.state,time(punches.map(row=>row.checkIn||row.check_in)),time(punches.map(row=>row.checkOut||row.check_out)),
        amount(day.dailyRate),amount(day.basic),sum(day.overtime,'hours'),amount(day.ot),number(day.lateMinutes),number(day.chargedLateMinutes),
        amount(day.late),amount(datedKind(day,'Allowance')),amount(datedKind(day,'Reimbursement')),amount(day.minus),amount(day.subtotal),amount(day.shortReduction),notes.join(' · ') || null]);
    }
    rows.push(header(['Daily totals (available saved detail)']),
      ['Earned salary',amount(sum(view.days,'basic')),'OT pay',amount(sum(view.days,'ot')),'Late deduction',amount(sum(view.days,'late'))],
      [],header(['Saved payroll summary','Amount (LKR)','Explanation']));
    const summaries=[
      ['Earned salary',slip.basic,'Includes paid leave; short-day reduction already excluded'],
      ['Office OT',slip.officeOtPay,`${slip.officeOtHours || 0} hours`],
      ['Site OT',slip.siteOtPay,`${slip.siteOtHours || 0} hours`],
      ['Travel OT',slip.travelOtPay,`${slip.travelOtHours || 0} hours`],
      ['Allowances',slip.allowanceTotal,'Includes dated and period-wide allowances; itemised below'],
      ['Gross earnings',slip.grossEarnings,'Saved payroll total'],
      ['Reimbursements',slip.reimbursementTotal,'Outside gross earnings'],
      ['Employee EPF',slip.epfEmployeeDeduction,`Salary basis ${slip.contributionBase || 0}; ${view.detail.contributions?.employeeEpfRate ?? 'rate not saved'}%`],
      ['Late deduction',slip.lateDeduction,'Saved deduction'],
      ['Other deductions',slip.otherDeduction,'Itemised below'],
      ['Unpaid leave deduction',slip.unpaidLeaveDeduction,'Saved value; unpaid leave normally earns no basic salary'],
      ['Salary advance recovery',slip.salaryAdvanceDeduction,'Period recovery, applied once'],
      ['Total deductions',slip.deductions,'Saved payroll total'],
      ['TAKE-HOME PAY',slip.netPay,'Authoritative saved net pay'],
      ['Employer EPF',slip.epfEmployerContribution,'Company cost; not deducted from employee pay'],
      ['Employer ETF',slip.etfEmployerContribution,'Company cost; not deducted from employee pay'],
      ['Employer cost',slip.employerCost,'Saved company cost']
    ];
    rows.push(...summaries.map(([label,value,note])=>[label,amount(value),note]),[],
      header(['Daily detail reconciliation','Saved total minus daily detail (LKR)','Explanation']),
      ['Earned salary',amount(view.reconciliation.basic),'Nonzero means older/incomplete saved detail does not explain the whole total. No amount was invented.'],
      ['OT pay',amount(view.reconciliation.ot),'Saved total minus dated OT rows'],
      ['Late deduction',amount(view.reconciliation.late),'Saved total minus dated late deductions'],[],
      header(['OT date','Type','Hours','Rate (LKR)','Amount (LKR)','Source','Policy']));
    for(const ot of view.detail.overtime || []) rows.push([ot.workDate,ot.type,number(ot.hours),amount(ot.rate),amount(ot.amount),ot.source,ot.policyId]);
    rows.push([],header(['Component date','Kind','Description','Amount (LKR)','Calculation / reason']));
    for(const component of view.components) rows.push([component.date || 'Period-wide / date not saved',component.kind,component.name,amount(component.amount),component.calculationDetail || component.description || null]);
    rows.push([],header(['Advance issued date','Description','Recovered this payroll (LKR)']));
    for(const advance of slip.advanceRecoveries || []) rows.push([advance.advanceDate,advance.description,amount(advance.amount)]);
    rows.push([],header(['Date','Calculation warning']));
    for(const warning of view.detail.warnings || []) rows.push([warning.workDate,warning.message]);
    return {name,freeze:8,columns:[16,25,14,14,19,20,14,20,15,20,20,22,24,25,22,27,75],rows};
  });
}
