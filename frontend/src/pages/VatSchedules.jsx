import React, { useEffect, useState } from 'react';
import { CircleDollarSign, TrendingUp, Wallet } from 'lucide-react';
import { api, fetchDownload, post, rupees, shortDate, slug } from '../api.js';
import { Badge, Field, FormModal, Row, SelectField, Summary, Table } from '../ui.jsx';

const pad = value => String(value).padStart(2, '0');
function currentQuarter() {
  const now = new Date(), first = Math.floor(now.getMonth() / 3) * 3;
  const next = new Date(now.getFullYear(), first + 3, 1);
  return {
    start: `${now.getFullYear()}-${pad(first + 1)}-01`,
    end: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-01`
  };
}
function priorDay(value) { const date=new Date(`${value}T00:00:00`);date.setDate(date.getDate()-1);return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }

export default function VatSchedules({ companyId, company, can }) {
  const quarter=currentQuarter();
  const [start,setStart]=useState(quarter.start),[end,setEnd]=useState(priorDay(quarter.end));
  const [data,setData]=useState(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[svatOpen,setSvatOpen]=useState(false);
  const [form,setForm]=useState({status:'Draft',outputAdjustment:0,inputAdjustment:0,adjustmentNote:'',filingReference:''});
  const load=async()=>{setError('');try{const result=await api(`/finance/vat?companyId=${companyId}&start=${start}&end=${end}`);setData(result);setForm({
    status:result.period.status,outputAdjustment:Number(result.period.outputAdjustment||0),inputAdjustment:Number(result.period.inputAdjustment||0),
    adjustmentNote:result.period.adjustmentNote||'',filingReference:result.period.filingReference||''});}catch(failure){setError(failure.message);setData(null);}};
  useEffect(()=>{load();},[companyId,start,end]);
  const save=async()=>{setSaving(true);setError('');try{const result=await api('/finance/vat/period',{method:'PUT',body:JSON.stringify({
    companyId,start,end,...form,outputAdjustment:Number(form.outputAdjustment||0),inputAdjustment:Number(form.inputAdjustment||0)})});setData(result);}catch(failure){setError(failure.message);}finally{setSaving(false);}};
  const download=async()=>{const url=await fetchDownload(`/finance/vat/export?companyId=${companyId}&start=${start}&end=${end}`);const link=document.createElement('a');link.href=url;link.download=`VAT-${start}-to-${end}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const template='115px 155px minmax(180px,1.3fr) 145px 125px 125px 125px 110px';
  return <>
    <section className="finance-period-panel">
      <div><p className="eyebrow">Company tax period</p><h3>{company?.name || 'Selected company'} VAT schedules</h3><p>Invoice-date basis. Issued sales invoices feed Output Schedule 01; supplier invoices and operating bills feed Input Schedule 02.</p></div>
      <div className="finance-period-controls"><label>From<input type="date" value={start} onChange={event=>setStart(event.target.value)}/></label><label>To<input type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label></div>
    </section>
    {error&&<p className="form-error">{error}</p>}
    {data&&<>
      <div className="attendance-summary"><Summary label="Adjusted output VAT" value={rupees(data.totals.adjustedOutputVat)} icon={TrendingUp}/><Summary label="Adjusted input VAT" value={rupees(data.totals.adjustedInputVat)} icon={CircleDollarSign}/><Summary label="VAT payable / (credit)" value={rupees(data.totals.netVatPayable)} icon={Wallet}/></div>
      <section className="vat-reconciliation">
        <div className="vat-reconciliation-heading"><div><p className="eyebrow">Reconciliation</p><h3>{shortDate(start)} – {shortDate(end)}</h3><p>Adjustments require an explanation. A filed period is locked against reopening.</p></div><Badge tone={slug(form.status)}>{form.status}</Badge></div>
        <div className="vat-form-grid"><label>Status<select value={form.status} disabled={!can.finance||data.period.status==='Filed'} onChange={event=>setForm({...form,status:event.target.value})}><option>Draft</option><option>Reconciled</option><option>Filed</option></select></label><label>Output VAT adjustment<input type="number" step="0.01" value={form.outputAdjustment} disabled={!can.finance||data.period.status==='Filed'} onChange={event=>setForm({...form,outputAdjustment:event.target.value})}/></label><label>Input VAT adjustment<input type="number" step="0.01" value={form.inputAdjustment} disabled={!can.finance||data.period.status==='Filed'} onChange={event=>setForm({...form,inputAdjustment:event.target.value})}/></label><label>Filing reference<input value={form.filingReference} disabled={!can.finance||data.period.status==='Filed'} onChange={event=>setForm({...form,filingReference:event.target.value})}/></label><label className="wide">Adjustment explanation<textarea value={form.adjustmentNote} disabled={!can.finance||data.period.status==='Filed'} onChange={event=>setForm({...form,adjustmentNote:event.target.value})}/></label></div>
        <div className="row-actions">{can.finance&&data.period.status!=='Filed'&&<button className="primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save reconciliation'}</button>}<button className="secondary" onClick={download}>Download Excel schedules</button></div>
      </section>
      <Table columns={['Date','Invoice','Customer','VAT number','Taxable value','Output VAT','Total','Status']} template={template} title={`Output Schedule 01 · ${data.output.length} document${data.output.length===1?'':'s'}`} empty="No issued standard-VAT client invoices fall inside this period.">{data.output.map(row=><Row template={template} key={row.id}><span>{shortDate(row.documentDate)}</span><strong>{row.documentNumber}</strong><span>{row.counterparty}</span><span>{row.counterpartyVatNumber||'Not recorded'}</span><span>{rupees(row.taxableAmount)}</span><strong>{rupees(row.vatAmount)}</strong><span>{rupees(row.totalAmount)}</span><Badge tone={slug(row.status)}>{row.status}</Badge></Row>)}</Table>
      <div style={{height:16}}/><Table columns={['Date','Invoice / bill','Supplier','VAT number','Taxable value','Input VAT','Total','Status']} template={template} title={`Input Schedule 02 · ${data.input.length} document${data.input.length===1?'':'s'}`} empty="No standard-VAT supplier invoices or operating bills fall inside this period.">{data.input.map(row=><Row template={template} key={`${row.source}-${row.id}`}><span>{shortDate(row.documentDate)}</span><div><strong>{row.documentNumber}</strong><small>{row.source}</small></div><span>{row.counterparty}</span><span>{row.counterpartyVatNumber||'Not recorded'}</span><span>{rupees(row.taxableAmount)}</span><strong>{rupees(row.vatAmount)}</strong><span>{rupees(row.totalAmount)}</span><Badge tone={slug(row.status)}>{row.status}</Badge></Row>)}</Table>
      <section className="svat-history"><div><p className="eyebrow">Historical records only</p><h3>SVAT schedules</h3><p>SVAT ended on 30 September 2025. Current periods cannot create SVAT entries; earlier records remain available and export with the period.</p></div>{can.finance&&data.svatAllowed&&<button className="secondary" onClick={()=>setSvatOpen(true)}>Add historical SVAT entry</button>}</section>
      {data.historicalSvat.length>0&&<Table columns={['Date','Direction','Schedule','Document','Counterparty','Taxable value','Suspended VAT']} template="115px 100px 120px 155px minmax(190px,1fr) 140px 140px" title="Historical SVAT records">{data.historicalSvat.map(row=><Row template="115px 100px 120px 155px minmax(190px,1fr) 140px 140px" key={row.id}><span>{shortDate(row.documentDate)}</span><Badge tone={row.direction==='Output'?'active':'pending'}>{row.direction}</Badge><span>{row.scheduleType}</span><strong>{row.documentNumber}</strong><span>{row.counterparty}</span><span>{rupees(row.taxableAmount)}</span><strong>{rupees(row.suspendedVat)}</strong></Row>)}</Table>}
    </>}
    {svatOpen&&<SvatForm companyId={companyId} start={start} end={end} close={()=>setSvatOpen(false)} reload={load}/>} 
  </>;
}

function SvatForm({companyId,start,end,close,reload}) { return <FormModal title="Add a historical SVAT schedule entry" close={close} label="Save historical entry" onSubmit={async values=>{await post('/finance/vat/svat-entries',{companyId,periodStart:start,periodEnd:end,direction:values.direction,scheduleType:values.scheduleType,documentDate:values.documentDate,documentNumber:values.documentNumber,counterparty:values.counterparty,counterpartyVatNumber:values.counterpartyVatNumber||undefined,counterpartySvatNumber:values.counterpartySvatNumber||undefined,taxableAmount:Number(values.taxableAmount),suspendedVat:Number(values.suspendedVat),creditVoucherNumber:values.creditVoucherNumber||undefined,notes:values.notes||undefined});await reload();}}>
  <SelectField name="direction" label="Schedule direction" options={['Output','Input']}/><SelectField name="scheduleType" label="IRD schedule" options={['SVAT 05','SVAT 05a','SVAT 05b','SVAT 06','SVAT 07']}/><Field name="documentDate" label="Document date" type="date"/><Field name="documentNumber" label="Invoice / document number"/><Field name="counterparty" label="Customer or supplier"/><Field name="counterpartyVatNumber" label="VAT registration number" required={false}/><Field name="counterpartySvatNumber" label="SVAT registration number" required={false}/><Field name="taxableAmount" label="Taxable value (LKR)" type="number" min="0" step="0.01"/><Field name="suspendedVat" label="Suspended VAT (LKR)" type="number" min="0" step="0.01"/><Field name="creditVoucherNumber" label="Credit voucher number" required={false}/><Field name="notes" label="Historical notes" wide required={false}/></FormModal>; }
