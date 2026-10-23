export function leavePaymentEligibility(start,policies,fromDate) {
  const policy=[...policies].filter(row=>String(row.effective_from).slice(0,10)<=fromDate)
    .sort((a,b)=>String(b.effective_from).localeCompare(String(a.effective_from))||Number(b.id)-Number(a.id))[0];
  if(!policy||!start)return {policy,eligibleFrom:'',paidAllowed:false,unpaidAllowed:false,options:[]};
  const [year,month,day]=start.split('-').map(Number);
  const target=new Date(Date.UTC(year,month-1+Number(policy.waiting_months),1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,last));
  const eligibleFrom=target.toISOString().slice(0,10);
  const paidAllowed=fromDate>=eligibleFrom;
  const unpaidAllowed=paidAllowed||Boolean(Number(policy.allow_unpaid_during_wait));
  return {policy,eligibleFrom,paidAllowed,unpaidAllowed,options:[...(paidAllowed?['Paid']:[]),...(unpaidAllowed?['Unpaid']:[])]};
}
