import React, { useEffect, useMemo, useState } from 'react';
import { api, post, rupees, todayInput, onDataChanged } from '../api.js';
import { Field, FormModal, SelectField } from '../ui.jsx';
import {useRegisterScroll,useRegisterView} from '../register-view.js';

export default function DailyExpenses({ companyId, company, can, userId }) {
  const link = new URLSearchParams(window.location.search);
  const linkedDate = link.get('date'), linkedEntry = link.get('entry');
  const [view,updateView]=useRegisterView('gkuc:daily-expenses:'+userId+':'+companyId,{
    date:todayInput(),location:'all',method:'all',search:''
  });
  const [selectedDate,setSelectedDate]=useState(()=>/^\d{4}-\d{2}-\d{2}$/.test(linkedDate||'')?linkedDate:null);
  const date=selectedDate||view.date;
  const setDate=value=>{setSelectedDate(null);updateView('date',value);};
  const {location,method,search}=linkedEntry&&selectedDate?{location:'all',method:'all',search:''}:view;
  const setFilter=(field,value)=>{
    if (selectedDate) {updateView('date',selectedDate);setSelectedDate(null);}
    updateView(field,value);
  };
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useRegisterScroll('gkuc:daily-expenses-scroll:'+userId+':'+companyId,Boolean(data),Boolean(linkedEntry||link.get('new')));
  const [addingOffice,setAddingOffice]=useState(()=>can.finance&&link.get('new')==='1');
  const [mdPersonal,setMdPersonal]=useState(false);
  const [categories,setCategories]=useState([]);
  const load=()=>api(`/finance/daily-expenses?companyId=${companyId}&date=${date}`).then(setData);
  useEffect(() => {
    setData(null); setError('');
    load().catch(failure => setError(failure.message));
  }, [companyId,date]);
  useEffect(() => onDataChanged(() => load().catch(failure => setError(failure.message))), [companyId,date]);
  useEffect(() => { api('/finance/categories').then(setCategories).catch(() => setCategories([])); }, [addingOffice]);
  const fundingEntries = (data?.fundingEntries || []).filter(row =>
    (location === 'all' || String(row.projectId || 'office') === location) &&
    (method === 'all' || method === 'Internal transfer') &&
    `${row.account} ${row.payee} ${row.category} ${row.description} ${row.reference}`.toLowerCase().includes(search.toLowerCase()));
  const entries = useMemo(() => (data?.entries || []).filter(row =>
    (location === 'all' || String(row.projectId || 'office') === location) &&
    (method === 'all' || row.paymentMethod === method) &&
    `${row.payee} ${row.category} ${row.description} ${row.reference}`.toLowerCase().includes(search.toLowerCase())
  ), [data,location,method,search]);
  useEffect(()=>{
    if (linkedEntry && date===linkedDate) document.getElementById('payment-'+linkedEntry)?.scrollIntoView({block:'center'});
  },[entries,linkedEntry,linkedDate,date]);
  const groups = useMemo(() => Object.values(entries.reduce((result,row) => {
    const name=row.location;
    result[name] ||= {name,amount:0,count:0};
    result[name].amount += Number(row.amount); result[name].count += 1;
    return result;
  },{})).sort((a,b)=>b.amount-a.amount),[entries]);
  const max = Math.max(1,...groups.map(row=>row.amount));
  return <div className="daily-expenses">
    <header className="daily-expenses-header"><div><span>DAILY PAYMENT REGISTER · {company?.name}</span><h2>Site and office expenses</h2><p>One payment row from petty cash, supplier invoices, operating bills or a direct expense.</p></div><div className="daily-expenses-actions"><label>Day<input type="date" value={date} onChange={event=>setDate(event.target.value)} /></label>{can.finance && <button type="button" className="primary" onClick={()=>setAddingOffice(true)}>Record direct office payment</button>}</div></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data ? <p className="empty-state">Loading this day's recorded payments…</p> : <>
      <div className="daily-expenses-summary"><article><span>Company</span><strong>{data.company.name}</strong></article><article><span>Payments recorded</span><strong>{data.entries.length}</strong></article><article><span>Amount paid</span><strong>{rupees(data.total)}</strong></article><article><span>Site / office locations</span><strong>{new Set(data.entries.map(row=>row.location)).size}</strong></article></div>
      <section className="daily-expenses-filters"><label>Location<select value={location} onChange={event=>setFilter('location',event.target.value)}><option value="all">All sites and office</option><option value="office">Head office</option>{[...new Map([...data.entries,...(data.fundingEntries||[])].filter(row=>row.projectId).map(row=>[String(row.projectId),row.location])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>Payment method<select value={method} onChange={event=>setFilter('method',event.target.value)}><option value="all">All methods</option>{[...new Set([...data.entries,...(data.fundingEntries||[])].map(row=>row.paymentMethod))].map(value=><option key={value}>{value}</option>)}</select></label><label>Find payee, category or reference<input value={search} onChange={event=>setFilter('search',event.target.value)} placeholder="Search this day" /></label></section>
      <section className="daily-expenses-chart"><h3>Where payments went</h3>{groups.map(row=><div key={row.name}><span>{row.name} <small>({row.count})</small></span><i><b style={{width:`${Math.max(3,row.amount/max*100)}%`}} /></i><strong>{rupees(row.amount)}</strong></div>)}{!groups.length && <p>No recorded payments match these filters.</p>}</section>
      <section className="daily-expenses-register"><div><h3>Payment register</h3><strong>{rupees(entries.reduce((sum,row)=>sum+Number(row.amount),0))} in current view</strong></div><div className="report-table-scroll"><table><thead><tr>{['Company','Location','Category','Payee','Payment method','Source','Reference / description','Amount'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{entries.map(row=><tr key={row.key} id={'payment-'+row.key} className={date===linkedDate&&linkedEntry===row.key?'linked-record':''}><td>{data.company.name}</td><td>{row.location}</td><td>{row.category}</td><td>{row.payee}</td><td>{row.paymentMethod}<small>{row.paymentSource}</small></td><td>{row.source}</td><td><a href={row.sourceUrl}>{row.reference}</a><small>{row.description}</small></td><td>{rupees(row.amount)}</td></tr>)}{!entries.length && <tr><td colSpan="8">No payment records match this day and these filters.</td></tr>}</tbody></table></div></section>
      <section className="daily-expenses-register petty-funding-register"><div><h3>Petty cash funding</h3><strong>{rupees(fundingEntries.reduce((sum,row)=>sum+Number(row.amount),0))} added in current view</strong></div>
        <p className="daily-expenses-note">Add money / Top up entries appear automatically from the account ledger. These are internal transfers, shown here for visibility and excluded from the expense totals above. Spending is counted once when it happens.</p>
        <div className="report-table-scroll"><table><thead><tr>{['Company','Location','Account','Account type','Reference / description','Amount added'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{fundingEntries.map(row=><tr key={row.key}><td>{data.company.name}</td><td>{row.location}</td><td>{row.account}</td><td>{row.accountType}</td><td><a href={row.sourceUrl}>{row.reference}</a><small>{row.description}</small></td><td>{rupees(row.amount)}</td></tr>)}{!fundingEntries.length&&<tr><td colSpan="6">No petty cash top-ups match this day and these filters.</td></tr>}</tbody></table></div>
      </section>
      <p className="daily-expenses-note">{data.note}</p>{data.unverifiedManualExpenses > 0 && <p className="daily-expenses-warning">{data.unverifiedManualExpenses} manually entered expense{data.unverifiedManualExpenses===1?' has':'s have'} no payment method recorded for this date. They are not included as paid transactions. Review their payment details in the project expense ledger.</p>}
    </>}
    {addingOffice && <FormModal title="Record direct office payment" label="Record payment" close={()=>setAddingOffice(false)} onSubmit={async values=>{await post('/finance/office-expense-payments',{companyId,paymentDate:values.paymentDate,category:values.category,mdPersonal,personalCategory:mdPersonal?values.category:undefined,payee:values.payee,paymentMethod:values.paymentMethod,description:values.description,reference:values.reference,amount:Number(values.amount)});await load();}}><p>Use this only for a direct office payment. Bills, supplier invoices and petty cash appear automatically when paid; do not enter them again here.</p><Field name="paymentDate" label="Date paid" type="date" defaultValue={date} />{can.has?.('finance.manage')&&<label>Expense purpose<select value={mdPersonal?'MD Personal':'Company expense'} onChange={e=>setMdPersonal(e.target.value==='MD Personal')}><option>Company expense</option><option>MD Personal</option></select></label>}{mdPersonal?<Field name="category" label="Personal expense category"/>:<SelectField name="category" label="Expense category" options={[['','Choose an expense category…'],...categories.map(category=>[category.name,category.name])]} />}<Field name="payee" label="Paid to" /><SelectField name="paymentMethod" label="Payment method" options={['Bank transfer','Card','Cash','Cheque']} /><Field name="reference" label="Unique payment reference" /><Field name="amount" label="Amount (LKR)" type="number" min="0.01" step="0.01" /><Field name="description" label="What was this payment for?" wide /></FormModal>}
  </div>;
}
