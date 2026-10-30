const key=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const count=(from,to,start,end)=>{
  const a=[key(from),start].sort().at(-1),b=[key(to),end].sort()[0];
  return a>b?0:Math.round((Date.parse(b)-Date.parse(a))/86400000)+1;
};
/** Advisory balances only. Rejected requests never reserve an allowance. */
export function leaveLimitWarnings(employee,policy,request,existing) {
  const warnings=[];
  const casual=request.leaveType==='Casual';
  const allowance=Number(casual?employee.casual:employee.annual);
  const from=key(request.fromDate),to=key(request.toDate);
  const rows=existing.filter(row=>row.status!=='Rejected');
  for(let year=Number(from.slice(0,4));year<=Number(to.slice(0,4));year++) {
    const start=`${year}-01-01`,end=`${year}-12-31`;
    const added=count(from,to,start,end);
    const used=rows.filter(row=>(row.leave_type==='Casual')===casual).reduce((sum,row)=>sum+count(row.from_date,row.to_date,start,end),0);
    if(used+added>allowance)warnings.push(`${year} ${casual?'casual':'annual/other'} allowance exceeded by ${used+added-allowance} day(s): ${used+added} requested/approved against ${allowance} allowed. Leave saved; remaining balance ${allowance-used-added} day(s).`);
  }
  const date=new Date(`${from.slice(0,7)}-01T00:00:00Z`);
  while(date.toISOString().slice(0,7)<=to.slice(0,7)) {
    const start=date.toISOString().slice(0,10),month=start.slice(0,7);
    date.setUTCMonth(date.getUTCMonth()+1);
    const end=new Date(date.getTime()-86400000).toISOString().slice(0,10);
    const used=rows.reduce((sum,row)=>sum+count(row.from_date,row.to_date,start,end),0),added=count(from,to,start,end);
    if(used+added>Number(policy.monthly_limit))warnings.push(`${month} advisory monthly allowance exceeded: ${used+added} day(s) against ${policy.monthly_limit}. Leave saved.`);
  }
  return warnings;
}
