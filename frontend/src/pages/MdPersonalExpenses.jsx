import './MdPersonalExpenses.css';
import React,{useEffect,useState} from 'react';
import {api,post,openDocument,rupeesExact as rupees,shortDate,todayInput,fetchDownload} from '../api.js';
import {Field,FormModal,SelectField,TextArea,Table,Row,Modal} from '../ui.jsx';
import Attachments from '../Attachments.jsx';

export default function MdPersonalExpenses({data}){
 const today=todayInput();
 const [from,setFrom]=useState(today.slice(0,7)+'-01'),[to,setTo]=useState(today),[company,setCompany]=useState('0'),[source,setSource]=useState(''),[category,setCategory]=useState(''),[pack,setPack]=useState(null),[error,setError]=useState(''),[form,setForm]=useState(null),[detail,setDetail]=useState(null);
 const params=new URLSearchParams({from,to,companyId:company,source,category}).toString();
 const load=()=>api(`/finance/md-personal-expenses?${params}`).then(setPack);
 useEffect(()=>{let live=true;setError('');setPack(null);api(`/finance/md-personal-expenses?${params}`).then(value=>{if(live)setPack(value);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[params]);
 const template='110px minmax(140px,1fr) minmax(200px,1.6fr) 150px 130px 120px';
 return <section className="panel md-personal-register"><div className="md-personal-header"><div><h2>MD Personal Expenses — Mr. Gihan</h2><p>Personal spending funded by either company. Payments are linked once; no repayments or outstanding balance.</p></div><div className="row-actions"><button className="primary" onClick={()=>setForm('new')}>Record personal payment</button><button className="secondary" onClick={()=>setForm('link')}>Link existing payment</button></div></div>
  <div className="toolbar"><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><label>Funded by<select value={company} onChange={e=>setCompany(e.target.value)}><option value="0">Both companies</option>{data.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Payment source<select value={source} onChange={e=>setSource(e.target.value)}><option value="">All sources</option><option>Petty cash</option><option>Direct payment</option></select></label><label>Category<input placeholder="All categories" value={category} onChange={e=>setCategory(e.target.value)}/></label>
   <button className="secondary" onClick={()=>{setFrom(today.slice(0,4)+'-01-01');setTo(today);}}>This year</button>
   <button className="secondary" onClick={()=>openDocument(`/finance/md-personal-expenses/document?${params}&download=pdf`).catch(e=>setError(e.message))}>Export PDF</button>
   <button className="secondary" onClick={()=>fetchDownload(`/finance/md-personal-expenses/export.xlsx?${params}`).then(url=>{const a=document.createElement('a');a.href=url;a.download='MD-Personal-Expenses.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}).catch(e=>setError(e.message))}>Export Excel</button>
  </div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {!pack&&!error&&<p>Loading personal expenses…</p>}
  {pack&&<><div className="petty-account-summary">{[['Personal spending',pack.total],['From petty cash',pack.pettyCash],['Direct payments',pack.direct]].map(([label,value])=><article className="petty-account" key={label}><span>{label}</span><strong>{rupees(value)}</strong></article>)}</div>
   <p>{pack.byCompany.map(g=>`${g.name}: ${rupees(g.amount)}`).join(' · ')}</p><p>{pack.byCategory.map(g=>`${g.name}: ${rupees(g.amount)}`).join(' · ')}</p>
   <Table columns={['Date','Company / category','Payee / description','Payment source','Amount','']} template={template}>{pack.rows.map(row=><Row key={row.id} template={template}><span>{shortDate(row.date)}</span><span>{row.company}<small>{row.category}</small></span><div><strong>{row.payee||'Not recorded'}</strong><small>{row.description}</small><small>{row.notes}</small>{row.paidBy&&<small>Paid by {row.paidBy}</small>}</div><span>{row.source}<small>{row.floatName||row.paymentMethod}</small><small>{row.reference}</small></span><strong>{rupees(row.amount)}</strong><button className="secondary" onClick={()=>setDetail(row)}>Details / receipt</button></Row>)}</Table></>}
  {form==='new'&&<PersonalPayment data={data} close={()=>setForm(null)} reload={load}/>}
  {form==='link'&&<LinkPayment companies={data.companies} params={params} close={()=>setForm(null)} reload={load}/>}
  {detail&&<Modal title="Personal expense details / receipt" close={()=>setDetail(null)} wide><p>{detail.company} · {shortDate(detail.date)} · {rupees(detail.amount)}</p><p>{detail.description}<br/>Paid by {detail.paidBy||"Not recorded"}<br/>Paid to {detail.payee||'Not recorded'} · recorded by {detail.recordedBy}<br/>{detail.reference}</p><button className="secondary" onClick={()=>setForm('edit')}>Edit category / notes</button><Attachments ownerType="md_personal_expense" ownerId={detail.id} title="Receipts" canUpload canDelete/>
   {form==='edit'&&<FormModal title="Edit personal expense details" label="Save details" close={()=>setForm(null)} onSubmit={async v=>{await api(`/finance/md-personal-expenses/${detail.id}`,{method:'PUT',body:JSON.stringify(v)});setDetail({...detail,...v});await load();}}><Field name="category" label="Personal category" defaultValue={detail.category}/><Field name="paidBy" label="Paid by (optional)" required={false} defaultValue={detail.paidBy||''}/><TextArea name="notes" label="Notes" required={false} defaultValue={detail.notes||''}/><p>Payment amount and source remain in the original ledger.</p></FormModal>}
  </Modal>}
 </section>;
}
function PersonalPayment({data,close,reload}){
 const [source,setSource]=useState('Petty cash'),[floats,setFloats]=useState([]),[error,setError]=useState('');const [clientRef]=useState(()=>crypto.randomUUID());
 useEffect(()=>{api('/receivables/petty-cash').then(rows=>setFloats(rows.filter(r=>r.accountType==='Office expenses'))).catch(e=>setError(e.message));},[]);
 return <FormModal title="Record Mr. Gihan’s personal payment" close={close} label="Record payment" onSubmit={async v=>{
  const common={companyId:Number(v.companyId),amount:Number(v.amount),description:v.description,payee:v.payee,category:'MD Personal',personalCategory:v.category,personalNotes:v.notes||undefined,personalPaidBy:v.paidBy||undefined,mdPersonal:true};
  if(source==='Petty cash')await post(`/receivables/petty-cash/${v.floatId}/entries`,{...common,kind:'Spend',entryDate:v.date,projectId:null,clientRef});
  else await post('/finance/office-expense-payments',{...common,paymentDate:v.date,paymentMethod:v.method,reference:v.reference});
  await reload();
 }}><label>Payment source<select value={source} onChange={e=>setSource(e.target.value)}><option>Petty cash</option><option>Direct payment</option></select></label><SelectField name="companyId" label="Company funding this payment" options={[["",'Choose company'],...data.companies.map(c=>[c.id,c.name])]}/>
  {source==='Petty cash'?<SelectField name="floatId" label="Shared petty cash float" options={[["",'Choose float'],...floats.map(f=>[f.id,`${f.name} · balance ${rupees(f.balance)}`])]}/>:<><SelectField name="method" label="Payment method" options={['Bank transfer','Cash','Card','Cheque']}/><Field name="reference" label="Unique payment reference"/></>}
  {error&&<p className="form-error">{error}</p>}<Field name="date" label="Date paid" type="date" defaultValue={todayInput()}/><Field name="category" label="Personal category" placeholder="Household, medical, vehicle, shopping…"/><Field name="payee" label="Paid to (shop / person)"/><Field name="amount" label="Amount (LKR)" type="number" min="0.01" step="0.01"/><Field name="description" label="What was this personal expense for?" wide/><Field name="paidBy" label="Paid by (optional)" required={false}/><TextArea name="notes" label="Notes" required={false}/><p className="form-note wide">This creates one payment in the selected source ledger and links it here. Attach a receipt afterward from Details / receipt.</p>
 </FormModal>;
}
function LinkPayment({companies,params,close,reload}){
 const [rows,setRows]=useState([]),[error,setError]=useState('');useEffect(()=>{api(`/finance/md-personal-expenses/payments?${params}`).then(setRows).catch(e=>setError(e.message));},[params]);
 return <FormModal title="Link an existing personal payment" close={close} label="Link payment" onSubmit={async v=>{const selected=rows.find(r=>`${r.source}:${r.id}`===v.payment);if(!selected)throw Error('Choose a payment.');await post('/finance/md-personal-expenses/link',{source:selected.source,paymentId:selected.id,category:v.category,notes:v.notes,paidBy:v.paidBy});await reload();}}>
  <p className="form-note wide">Uses the page’s company/date range. Linking creates no new payment. Project costs, fuel, salary advances, supplier settlements and already linked payments are excluded. Latest 500 payments per source are shown; narrow dates if needed.</p>{error&&<p className="form-error">{error}</p>}
  <SelectField name="payment" label="Existing payment" wide options={[["",'Choose the original payment'],...rows.map(r=>[`${r.source}:${r.id}`,`${r.date} · ${companies.find(c=>Number(c.id)===Number(r.companyId))?.name||"Company"} · ${r.source} #${r.id} · ${r.payee||r.description} · ${rupees(r.amount)}`])]}/><Field name="category" label="Personal category"/><Field name="paidBy" label="Paid by (optional)" required={false}/><TextArea name="notes" label="Reason / notes for linking" required={false}/>
 </FormModal>;
}
