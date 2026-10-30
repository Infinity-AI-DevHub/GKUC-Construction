const cents = value => Math.round(Number(value || 0) * 100);
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };

/** Apply a reduced cheque to the oldest selected invoices, in exact cents. */
export function allocateCheque(invoices, amount, reason) {
  const ordered=[...invoices].sort((a,b)=>String(a.invoiceDate||'').localeCompare(String(b.invoiceDate||''))||Number(a.id)-Number(b.id));
  const total=ordered.reduce((sum,row)=>sum+cents(row.availableAmount),0), requested=cents(amount);
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(requested)||requested<=0)fail('Enter a valid positive cheque amount.');
  if(ordered.some(row=>cents(row.availableAmount)<=0))fail('A selected invoice is already paid or covered by another pending cheque. Refresh the invoice selection.',409);
  if(requested>total)fail('Cheque amount exceeds the available balance of the selected invoices.',409);
  const overridden=requested!==total;
  if(overridden&&String(reason||'').trim().length<3)fail('Enter a reason for changing the calculated invoice total.');
  let remaining=requested;
  const allocations=ordered.map(row=>{
    const allocated=Math.min(remaining,cents(row.availableAmount));remaining-=allocated;
    return {invoiceId:Number(row.id),invoiceNo:row.invoiceNo,balance:Number((cents(row.availableAmount)/100).toFixed(2)),amount:allocated/100};
  });
  return {invoiceTotal:total/100,overridden,allocations};
}
