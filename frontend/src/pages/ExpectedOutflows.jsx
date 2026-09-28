import React, { useEffect, useMemo, useState } from 'react';
import { api, patch, post, rupees, shortDate, todayInput } from '../api.js';

const monthName = value => new Date(`${value}-01T12:00:00`).toLocaleDateString(undefined,{month:'short',year:'numeric'});

export default function ExpectedOutflows({companyId,company,can,projects=[]}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[type,setType]=useState('All'),[confidence,setConfidence]=useState('All');
  const [status,setStatus]=useState('All'),[from,setFrom]=useState(''),[to,setTo]=useState(''),[editing,setEditing]=useState(null);
  const load=()=>api(`/finance/expected-outflows?companyId=${companyId}`).then(setData);
  useEffect(()=>{setData(null);setError('');load().catch(failure=>setError(failure.message));},[companyId]);
  const entries=useMemo(()=>(data?.entries||[]).filter(row=>(type==='All'||row.sourceType===type)&&
    (confidence==='All'||row.confidence===confidence)&&(status==='All'||row.status===status)&&
    (!from||row.expectedDate&&row.expectedDate>=from)&&(!to||row.expectedDate&&row.expectedDate<=to)),[data,type,confidence,status,from,to]);
  const groups=useMemo(()=>Object.values(entries.filter(row=>row.expectedDate).reduce((acc,row)=>{
    const key=row.expectedDate.slice(0,7);acc[key]||={key,total:0,count:0};acc[key].total+=row.amount;acc[key].count++;return acc;
  },{})).sort((a,b)=>a.key.localeCompare(b.key)),[entries]);
  const max=Math.max(1,...groups.map(row=>row.total));
  const datedTotal=entries.reduce((sum,row)=>sum+(row.expectedDate?row.amount:0),0);
  const unscheduled=entries.reduce((sum,row)=>sum+(!row.expectedDate?row.amount:0),0);
  const save=async event=>{
    event.preventDefault();setError('');const form=new FormData(event.currentTarget);
    const body={companyId,expectedDate:String(form.get('expectedDate')),confidence:String(form.get('confidence')),
      notes:String(form.get('notes')||'')};
    if(editing?.sourceType&&editing.sourceType!=='Planned payment'){body.sourceType=editing.sourceType;body.sourceId=editing.sourceId;}
    else {body.payee=String(form.get('payee'));body.description=String(form.get('description'));
      body.amount=Number(form.get('amount'));body.projectId=Number(form.get('projectId'))||null;}
    try{if(editing?.sourceType==='Planned payment')await patch(`/finance/expected-outflows/plans/${editing.scheduleId}/details`,body);
      else await post('/finance/expected-outflows/plans',body);setEditing(null);await load();}
    catch(failure){setError(failure.message);}
  };
  const updateStatus=async(row,next)=>{
    if(next==='Paid'&&!window.confirm('Confirm this standalone planned payment has been paid? This does not create a bank or expense transaction.'))return;
    try{await patch(`/finance/expected-outflows/plans/${row.scheduleId}`,{companyId,status:next});await load();}
    catch(failure){setError(failure.message);}
  };
  return <div className="expected-outflows">
    <header className="daily-expenses-header"><div><span>CASH PLANNING · {company?.name}</span><h2>Expected cash outflows</h2><p>Upcoming obligations from Finance, purchasing and approved payroll, shown once per source.</p></div>
      {can.finance&&<button type="button" onClick={()=>setEditing({})}>Plan another payment</button>}</header>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!data?<p className="empty-state">Loading expected payments…</p>:<>
      <div className="daily-expenses-summary"><article><span>Dated forecast</span><strong>{rupees(data.total)}</strong></article><article><span>Needs payment date</span><strong>{rupees(data.unscheduled)}</strong></article><article><span>Open obligations</span><strong>{data.entries.length}</strong></article><article><span>Company</span><strong>{data.company.name}</strong></article></div>
      <section className="daily-expenses-filters"><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
        <label>Source<select value={type} onChange={e=>setType(e.target.value)}><option>All</option>{[...new Set(data.entries.map(row=>row.sourceType))].map(value=><option key={value}>{value}</option>)}</select></label>
        <label>Confidence<select value={confidence} onChange={e=>setConfidence(e.target.value)}>{['All','High','Medium','Low'].map(value=><option key={value}>{value}</option>)}</select></label>
        <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option>All</option>{[...new Set(data.entries.map(row=>row.status))].map(value=><option key={value}>{value}</option>)}</select></label></section>
      <section className="daily-expenses-chart"><h3>Expected by month</h3>{groups.map(row=><div key={row.key}><span>{monthName(row.key)} <small>({row.count})</small></span><i><b style={{width:`${Math.max(3,row.total/max*100)}%`}}/></i><strong>{rupees(row.total)}</strong></div>)}{!groups.length&&<p>No dated payments match these filters.</p>}</section>
      <section className="daily-expenses-register"><div><h3>Payment forecast</h3><strong>{rupees(datedTotal)} dated · {rupees(unscheduled)} needs a date</strong></div>
        <div className="report-table-scroll"><table><thead><tr>{['Expected payment','Source / reference','Payee & purpose','Site / office','Amount','Confidence','Status','Next action'].map(label=><th key={label}>{label}</th>)}</tr></thead>
          <tbody>{entries.map(row=><tr key={row.key}><td>{row.expectedDate?shortDate(row.expectedDate):<strong>Needs date</strong>}</td>
            <td>{row.sourceUrl?<a href={row.sourceUrl}>{row.sourceType}</a>:row.sourceType}<small>{row.reference}</small></td>
            <td>{row.payee}<small>{row.description}</small></td><td>{row.project||'Company / office'}</td><td><strong>{rupees(row.amount)}</strong></td>
            <td>{row.confidence}</td><td>{row.status}</td><td>{can.finance?<>
              {row.sourceType!=='Planned payment'&&<button type="button" className="status-button" onClick={()=>setEditing(row)}>{row.expectedDate?'Reschedule':'Set date'}</button>}
              {row.sourceType==='Planned payment'&&row.scheduleId&&<><button type="button" className="status-button" onClick={()=>setEditing(row)}>Edit</button><select aria-label={`Status for ${row.payee}`} value={row.status} onChange={e=>updateStatus(row,e.target.value)}><option>Planned</option><option>Committed</option><option>Paid</option><option>Cancelled</option></select></>}
            </>:row.sourceUrl?<a href={row.sourceUrl}>Open</a>:'—'}</td></tr>)}{!entries.length&&<tr><td colSpan="8">No open payments match these filters. Record a bill, supplier invoice, purchase order, card statement, approved payroll run or planned payment to build this forecast.</td></tr>}</tbody></table></div></section>
      <p className="daily-expenses-note">{data.note} A planned payment marked paid is removed from the forecast; record the actual payment in its proper register.</p>
    </>}
    {editing!==null&&<div className="outflow-overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null)}}><form className="outflow-form" onSubmit={save} role="dialog" aria-modal="true" aria-label={editing.sourceType?'Schedule payment':'Plan payment'}>
      <header><h3>{editing.sourceType?`Schedule ${editing.sourceType.toLowerCase()}`:'Plan a payment'}</h3><button type="button" onClick={()=>setEditing(null)} aria-label="Close">×</button></header>
      <p>{editing.sourceType&&editing.sourceType!=='Planned payment'?`${editing.payee} · ${rupees(editing.amount)}. The amount and payment state remain controlled by the original record.`:'Use this only when no bill, PO, cheque, card statement or payroll record already represents the payment.'}</p>
      {(!editing.sourceType||editing.sourceType==='Planned payment')&&<><label>Payee<input name="payee" required maxLength="180" defaultValue={editing.payee||''}/></label><label>Purpose<input name="description" required maxLength="400" defaultValue={editing.description||''}/></label><label>Amount (LKR)<input name="amount" type="number" min="0.01" step="0.01" required defaultValue={editing.amount||''}/></label><label>Project or office<select name="projectId" defaultValue={editing.projectId||''}><option value="">Company / office</option>{projects.filter(p=>Number(p.companyId)===Number(companyId)).map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label></>}
      <label>Expected payment date<input name="expectedDate" type="date" required defaultValue={editing.expectedDate||todayInput()}/></label>
      <label>Confidence<select name="confidence" defaultValue={editing.confidence||'Medium'}><option>High</option><option>Medium</option><option>Low</option></select></label>
      <label>Planning notes<input name="notes" maxLength="600" defaultValue={editing.scheduleNotes||''}/></label>
      <footer><button type="button" onClick={()=>setEditing(null)}>Cancel</button><button type="submit">Save forecast date</button></footer>
    </form></div>}
  </div>;
}
