export function payrollSteps(run) {
  const approved = ['Approved', 'Paid'].includes(run.status);
  return [
    {label:'Attendance and claims reviewed',owner:'HR',done:true,detail:'Payroll draft uses confirmed inputs',href:'/people/payroll-inputs'},
    {label:'Payroll draft prepared',owner:'HR payroll',done:true,detail:`${run.payslips?.length || 0} employees in this run`},
    {label:'Salary sheet approved',owner:'HR approver',done:approved,detail:approved?'Approved snapshot retained':'Review each payslip before approval',href:'/people/payroll'},
    {label:'Salary paid',owner:'HR payroll',done:run.status==='Paid',detail:run.status==='Paid'?'Payment recorded':'Mark paid only after bank transfer or cash disbursement',href:'/people/payroll'}
  ];
}

export function tenderSteps(tender) {
  const later=['Submitted','Opened','Won','Lost'];
  const submitted=later.includes(tender.status);
  const documents=tender.checklist || [];
  const ready=documents.length>0 && documents.filter(item=>item.mandatory).every(item=>Boolean(item.done));
  return [
    {label:'Tender identified',owner:'QS',done:true,detail:tender.reference},
    {label:'Bid documents obtained',owner:'QS',done:Boolean(tender.purchasedDate)||['Document purchased','Preparing',...later].includes(tender.status),detail:tender.purchasedDate?'Purchase recorded':'Record document purchase'},
    {label:'Mandatory documents checked',owner:'QS',done:ready,detail:`${documents.filter(item=>item.mandatory&&!item.done).length} required document(s) outstanding`},
    {label:'Price and review bid',owner:'QS',done:submitted,detail:submitted?'Bid submitted':'Check bid value and security before submission'},
    {label:'Submit before closing',owner:'QS',done:submitted,detail:tender.closingDate?`Closes ${String(tender.closingDate).slice(0,10)}`:'Closing date not set'},
    {label:'Record award decision',owner:'QS / Projects',done:['Won','Lost'].includes(tender.status),detail:['Won','Lost'].includes(tender.status)?tender.status:'Awaiting employer response'}
  ];
}

export function vehicleRenewalSteps(vehicle) {
  const documents=vehicle.documents || [];
  const insurance=documents.find(item=>item.docType==='Insurance');
  const valid=insurance && !String(insurance.due||'').toLowerCase().includes('overdue');
  return [
    {label:'Insurance record linked',owner:'Fleet / HR',done:Boolean(insurance),detail:insurance?`Policy ${insurance.reference||'recorded'}`:'Add an insurance document'},
    {label:'Expiry checked',owner:'HR',done:Boolean(valid),detail:insurance?`${insurance.due} · expires ${String(insurance.expiryDate).slice(0,10)}`:'Expiry date unavailable'},
    {label:'Renew policy',owner:'HR / Fleet',done:Boolean(valid),detail:valid?'Current policy in force':'Record the renewed policy and new expiry',href:'/people/insurance'}
  ];
}

export function clientCollectionSteps(invoice, receipts=[]) {
  const issued=invoice.status!=='Draft';
  const settled=invoice.status==='Paid'||Number(invoice.outstanding)<=0&&issued;
  return [
    {label:'Invoice prepared',owner:'Finance',done:true,detail:invoice.reference},
    {label:'Invoice issued to client',owner:'Finance',done:issued,detail:issued?'Client invoice issued':'Review and issue before collection'},
    {label:'Payment recorded',owner:'Finance',done:receipts.length>0,detail:`${receipts.length} payment${receipts.length===1?'':'s'} recorded`},
    {label:'Receipt issued',owner:'Finance',done:receipts.length>0,detail:receipts.length?'Receipts are available below':'Issue receipt after recording payment'},
    {label:'Balance collected',owner:'Finance',done:settled,detail:settled?'Invoice settled':'Follow up the outstanding balance'}
  ];
}
