import React, { useEffect, useMemo, useState } from 'react';
import { api, rupees } from '../api.js';

const monthNow = () => { const at=new Date();return `${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}`; };
const cash = amount => amount === null || amount === undefined ? 'Not set' : rupees(amount);
const delta = amount => amount === null || amount === undefined ? 'Budget not set' : `${amount>=0?'+':'−'}${rupees(Math.abs(amount))}`;
const numberOrNull = value => value === '' ? null : Number(value);
const fields = [
  ['budgetReceipts','Cash-in budget'],['budgetPayments','Cash-out budget'],
  ['openingBalance','Verified opening balance'],['verifiedClosingBalance','Verified closing balance'],
  ['reconciliationAdjustment','Reconciliation adjustment']
];

export default function CashComparison({companyId,company,can}){
  const [period,setPeriod]=useState(monthNow()),[data,setData]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const load=()=>api(`/finance/cash-comparison?companyId=${companyId}&period=${period}`).then(setData);
  useEffect(()=>{setData(null);setError('');load().catch(failure=>setError(failure.message));},[companyId,period]);
  const chart=useMemo(()=>data?.months||[],[data]);
  const max=Math.max(1,...chart.map(row=>Math.max(row.receipts,row.payments)));
  const save=async event=>{
    event.preventDefault();setSaving(true);setError('');const form=new FormData(event.currentTarget);
    const values=Object.fromEntries(fields.map(([key])=>[key,numberOrNull(String(form.get(key)||''))]));
    values.reconciliationAdjustment ??= 0;
    try{await api('/finance/cash-comparison/period',{method:'PUT',body:JSON.stringify({companyId,period,...values,
      adjustmentReason:String(form.get('adjustmentReason')||''),balanceSource:String(form.get('balanceSource')||'')})});await load();}
    catch(failure){setError(failure.message);}finally{setSaving(false);}
  };
  const current=data?.current,compare=data?.comparison;
  return <div className="cash-comparison">
    <header className="daily-expenses-header"><div><span>CASH CONTROL · {company?.name}</span><h2>Cash comparison</h2><p>Compare recorded cash month to month, against the same month last year and against Finance’s budget.</p></div>
      <label>Report month<input type="month" value={period} onChange={event=>setPeriod(event.target.value)}/></label></header>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!data?<p className="empty-state">Loading cash comparison…</p>:<>
      <div className="daily-expenses-summary"><article><span>Recorded cash in</span><strong>{rupees(current.receipts)}</strong></article><article><span>Recorded cash out</span><strong>{rupees(current.payments)}</strong></article><article><span>Net movement</span><strong>{rupees(current.movement)}</strong></article><article><span>Closing balance</span><strong>{cash(current.verifiedClosingBalance)}</strong><small>{current.reconciliationStatus}</small></article></div>
      <section className="cash-comparison-grid"><article><h3>Prior month · {data.previous.period}</h3><dl><div><dt>Cash in change</dt><dd>{delta(compare.receiptsVsPrevious)}</dd></div><div><dt>Cash out change</dt><dd>{delta(compare.paymentsVsPrevious)}</dd></div><div><dt>Net movement change</dt><dd>{delta(compare.movementVsPrevious)}</dd></div></dl></article>
        <article><h3>Same month last year · {data.priorYear.period}</h3><dl><div><dt>Cash in change</dt><dd>{delta(compare.receiptsVsPriorYear)}</dd></div><div><dt>Cash out change</dt><dd>{delta(compare.paymentsVsPriorYear)}</dd></div><div><dt>Net movement change</dt><dd>{delta(compare.movementVsPriorYear)}</dd></div></dl></article>
        <article><h3>Budget versus actual</h3><dl><div><dt>Cash in · budget</dt><dd>{cash(current.budgetReceipts)}</dd></div><div><dt>Cash in variance</dt><dd>{delta(compare.receiptsVsBudget)}</dd></div><div><dt>Cash out · budget</dt><dd>{cash(current.budgetPayments)}</dd></div><div><dt>Cash out variance</dt><dd>{delta(compare.paymentsVsBudget)}</dd></div></dl></article></section>
      <section className="daily-expenses-chart"><h3>Last 12 months · recorded cash in and out</h3>{chart.map(row=><div key={row.period}><span>{row.period}</span><i className="cash-comparison-bars"><b style={{width:`${Math.max(1,row.receipts/max*100)}%`}}/><b style={{width:`${Math.max(1,row.payments/max*100)}%`}}/></i><strong>{rupees(row.movement)}</strong></div>)}<p>Blue: cash in · Red: cash out · Amount at right: net movement.</p></section>
      <section className="daily-expenses-register"><div><h3>Monthly reconciliation</h3><strong className={current.reconciliationStatus==='Difference'?'overdue':''}>{current.reconciliationStatus}</strong></div>
        <div className="report-table-scroll"><table><thead><tr>{['Month','Opening','Cash in','Cash out','Adjustment','Calculated close','Verified close','Difference','Status'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{chart.map(row=><tr key={row.period}><td>{row.period}</td><td>{cash(row.openingBalance)}</td><td>{rupees(row.receipts)}</td><td>{rupees(row.payments)}</td><td>{rupees(row.reconciliationAdjustment)}</td><td>{cash(row.calculatedClosing)}</td><td>{cash(row.verifiedClosingBalance)}</td><td>{cash(row.difference)}</td><td>{row.reconciliationStatus}</td></tr>)}</tbody></table></div></section>
      <section className="cash-comparison-bottom"><article><h3>{period} cash-out sources</h3><dl>{Object.entries(current.components).map(([key,amount])=><div key={key}><dt>{key.replace(/([A-Z])/g,' $1')}</dt><dd>{rupees(amount)}</dd></div>)}</dl></article>
        <article><h3>Balance check</h3><p>Opening {cash(current.openingBalance)} + cash in {rupees(current.receipts)} − cash out {rupees(current.payments)} + adjustment {rupees(current.reconciliationAdjustment)} = calculated close {cash(current.calculatedClosing)}.</p><p>Verified close: {cash(current.verifiedClosingBalance)}. Difference: {cash(current.difference)}.</p>{current.balanceSource&&<p>Evidence: {current.balanceSource}</p>}{current.adjustmentReason&&<p>Adjustment: {current.adjustmentReason}</p>}</article></section>
      {can.finance&&<form className="cash-comparison-form" onSubmit={save} key={`${companyId}-${period}-${data.current.openingBalance}-${data.current.verifiedClosingBalance}`}><h3>Finance month settings and balance verification</h3><p>Enter budgets and balances from your bank statements and cash count. An adjustment needs an explanation; a verified close needs an evidence reference.</p><div>{fields.map(([key,label])=><label key={key}>{label}<input name={key} type="number" step="0.01" min={key.startsWith('budget')?'0':undefined} defaultValue={current[key]??''} /></label>)}<label>Adjustment reason<input name="adjustmentReason" defaultValue={current.adjustmentReason||''} maxLength="500"/></label><label>Statement or cash-count reference<input name="balanceSource" defaultValue={current.balanceSource||''} maxLength="300"/></label></div><button type="submit" disabled={saving}>{saving?'Saving…':'Save month settings'}</button></form>}
      <p className="daily-expenses-note">{data.note} An opening balance is not inferred from last month’s closing balance; Finance must confirm it. See Finance → Daily expenses for individual payment records.</p>
    </>}
  </div>;
}
