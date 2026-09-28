import React, { useEffect, useMemo, useState } from 'react';
import { api, post, rupees, todayInput } from '../api.js';
import { Field, FormModal, SelectField } from '../ui.jsx';

export default function DailyExpenses({ companyId, company, can }) {
  const [date, setDate] = useState(todayInput());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [location, setLocation] = useState('all');
  const [method, setMethod] = useState('all');
  const [search, setSearch] = useState('');
  const [addingOffice,setAddingOffice]=useState(false);
  const load=()=>api(`/finance/daily-expenses?companyId=${companyId}&date=${date}`).then(setData);
  useEffect(() => {
    setData(null); setError('');
    load().catch(failure => setError(failure.message));
  }, [companyId,date]);
  const entries = useMemo(() => (data?.entries || []).filter(row =>
    (location === 'all' || String(row.projectId || 'office') === location) &&
    (method === 'all' || row.paymentMethod === method) &&
    `${row.payee} ${row.category} ${row.description} ${row.reference}`.toLowerCase().includes(search.toLowerCase())
  ), [data,location,method,search]);
  const groups = useMemo(() => Object.values(entries.reduce((result,row) => {
    const name=row.location;
    result[name] ||= {name,amount:0,count:0};
    result[name].amount += Number(row.amount); result[name].count += 1;
    return result;
  },{})).sort((a,b)=>b.amount-a.amount),[entries]);
  const max = Math.max(1,...groups.map(row=>row.amount));
  return <div className="daily-expenses">
    <header className="daily-expenses-header"><div><span>DAILY PAYMENT REGISTER · {company?.name}</span><h2>Site and office expenses</h2><p>One payment row from petty cash, supplier invoices, operating bills or a direct expense.</p></div><div className="daily-expenses-actions"><label>Day<input type="date" value={date} onChange={event=>setDate(event.target.value)} /></label>{can.finance && <button type="button" onClick={()=>setAddingOffice(true)}>Record direct office payment</button>}</div></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data ? <p className="empty-state">Loading this day's recorded payments…</p> : <>
      <div className="daily-expenses-summary"><article><span>Company</span><strong>{data.company.name}</strong></article><article><span>Payments recorded</span><strong>{data.entries.length}</strong></article><article><span>Amount paid</span><strong>{rupees(data.total)}</strong></article><article><span>Site / office locations</span><strong>{new Set(data.entries.map(row=>row.location)).size}</strong></article></div>
      <section className="daily-expenses-filters"><label>Location<select value={location} onChange={event=>setLocation(event.target.value)}><option value="all">All sites and office</option><option value="office">Head office</option>{[...new Map(data.entries.filter(row=>row.projectId).map(row=>[String(row.projectId),row.location])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>Payment method<select value={method} onChange={event=>setMethod(event.target.value)}><option value="all">All methods</option>{[...new Set(data.entries.map(row=>row.paymentMethod))].map(value=><option key={value}>{value}</option>)}</select></label><label>Find payee, category or reference<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search this day" /></label></section>
      <section className="daily-expenses-chart"><h3>Where payments went</h3>{groups.map(row=><div key={row.name}><span>{row.name} <small>({row.count})</small></span><i><b style={{width:`${Math.max(3,row.amount/max*100)}%`}} /></i><strong>{rupees(row.amount)}</strong></div>)}{!groups.length && <p>No recorded payments match these filters.</p>}</section>
      <section className="daily-expenses-register"><div><h3>Payment register</h3><strong>{rupees(entries.reduce((sum,row)=>sum+Number(row.amount),0))} in current view</strong></div><div className="report-table-scroll"><table><thead><tr>{['Company','Location','Category','Payee','Payment method','Source','Reference / description','Amount'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{entries.map(row=><tr key={row.key}><td>{data.company.name}</td><td>{row.locationType === 'Project site' ? row.location : 'Head office'}</td><td>{row.category}</td><td>{row.payee}</td><td>{row.paymentMethod}<small>{row.paymentSource}</small></td><td>{row.source}</td><td><a href={row.sourceUrl}>{row.reference}</a><small>{row.description}</small></td><td>{rupees(row.amount)}</td></tr>)}{!entries.length && <tr><td colSpan="8">No payment records match this day and these filters.</td></tr>}</tbody></table></div></section>
      <p className="daily-expenses-note">{data.note}</p>{data.unverifiedManualExpenses > 0 && <p className="daily-expenses-warning">{data.unverifiedManualExpenses} manually entered expense{data.unverifiedManualExpenses===1?' has':'s have'} no payment method recorded for this date. They are not included as paid transactions. Review them in Finance → Expenses.</p>}
    </>}
    {addingOffice && <FormModal title="Record direct office payment" label="Record payment" close={()=>setAddingOffice(false)} onSubmit={async values=>{await post('/finance/office-expense-payments',{companyId,paymentDate:values.paymentDate,category:values.category,payee:values.payee,paymentMethod:values.paymentMethod,description:values.description,reference:values.reference,amount:Number(values.amount)});await load();}}><p>Use this only for a direct office payment. Bills, supplier invoices and petty cash appear automatically when paid; do not enter them again here.</p><Field name="paymentDate" label="Date paid" type="date" defaultValue={date} /><Field name="category" label="Expense category" /><Field name="payee" label="Paid to" /><SelectField name="paymentMethod" label="Payment method" options={['Bank transfer','Card','Cash','Cheque']} /><Field name="reference" label="Unique payment reference" /><Field name="amount" label="Amount (LKR)" type="number" min="0.01" step="0.01" /><Field name="description" label="What was this payment for?" wide /></FormModal>}
  </div>;
}
