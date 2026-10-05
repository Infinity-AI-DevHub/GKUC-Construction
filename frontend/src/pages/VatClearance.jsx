import React, { useEffect, useState } from 'react';
import { CalendarClock, FileCheck2 } from 'lucide-react';
import { api, post, shortDate, todayInput } from '../api.js';
import Attachments from '../Attachments.jsx';
import { Badge, Field, FormModal, Row, Summary, Table } from '../ui.jsx';

export default function VatClearance({companyId,company,can}){
  const [records,setRecords]=useState([]),[editing,setEditing]=useState(null),[selected,setSelected]=useState(null),[reminders,setReminders]=useState([]),[error,setError]=useState('');
  const load=()=>api(`/company-compliance?companyId=${companyId}`).then(rows=>{setRecords(rows);setError('');const id=Number(new URLSearchParams(location.search).get('record'));if(id)setSelected(id);}).catch(failure=>setError(failure.message));
  useEffect(()=>{setRecords([]);setSelected(null);load();},[companyId]);
  const active=records.find(record=>record.status==='Active');
  const open=record=>{setEditing(record||{});setReminders(record?.reminders?.length?record.reminders:[{unit:'Days',value:30},{unit:'Days',value:7},{unit:'Days',value:0}]);};
  const chosen=records.find(record=>Number(record.id)===Number(selected));
  const template='minmax(180px,1.2fr) 130px 130px 120px minmax(170px,1fr) 100px';
  return <>{error&&<p className="form-error">{error}</p>}
    <div className="toolbar"><div><strong>Company compliance</strong><p className="form-note">This register belongs only to {company?.name}. Certificates are stored privately and reminders become actionable cases.</p></div>{can.finance&&<button className="primary" onClick={()=>open(active)}>{active?'Renew clearance':'Add VAT clearance'}</button>}</div>
    <div className="attendance-summary"><Summary label="Current status" value={active?(active.daysUntil<0?'Expired':'Active'):'Not recorded'} icon={FileCheck2}/><Summary label="Days remaining" value={active?Math.max(0,Number(active.daysUntil)):'—'} icon={CalendarClock}/></div>
    <Table title="VAT clearance record" columns={['Reference','Issued','Expires','Status','Reminder schedule','']} template={template} empty={`No VAT clearance has been recorded for ${company?.name||'this company'}. Add the certificate, expiry and reminder schedule.`} emptyAction={can.finance?()=>open(null):undefined} emptyActionLabel="Add VAT clearance">
      {records.map(record=><Row template={template} key={record.id}><strong>{record.reference||'No reference'}<small>{record.company}</small></strong><span>{record.issueDate?shortDate(record.issueDate):'Not recorded'}</span><span>{shortDate(record.expiryDate)}</span><Badge tone={record.daysUntil<0?'at-risk':'on-track'}>{record.daysUntil<0?'Expired':'Active'}</Badge><span>{record.reminders.length} reminder{record.reminders.length===1?'':'s'}</span><button className="status-button" onClick={()=>setSelected(record.id)}>Open</button></Row>)}
    </Table>
    {chosen&&<section className="workspace-surface" style={{marginTop:16}}><div className="workspace-section-heading"><div><span className="section-kicker">{chosen.company}</span><h2>VAT clearance certificate</h2><p>{chosen.reference||'Reference not recorded'} · expires {shortDate(chosen.expiryDate)}</p></div>{can.finance&&<button className="secondary" onClick={()=>open(chosen)}>Record renewal</button>}</div>
      <Attachments ownerType="company_compliance" ownerId={chosen.id} title="Certificates and supporting evidence" canUpload={can.finance} canDelete={can.finance} withCategory withExpiry/>
      <Table title="Renewal history" columns={['Reference','Issued','Expiry','Recorded by','Recorded']} template="minmax(170px,1fr) 130px 130px minmax(160px,1fr) 150px" empty="No renewal history has been recorded.">{chosen.renewals.map(row=><Row key={row.id} template="minmax(170px,1fr) 130px 130px minmax(160px,1fr) 150px"><strong>{row.reference||'No reference'}</strong><span>{row.issueDate?shortDate(row.issueDate):'—'}</span><span>{shortDate(row.expiryDate)}</span><span>{row.recordedBy}</span><span>{shortDate(row.recordedAt)}</span></Row>)}</Table>
    </section>}
    {editing&&<FormModal title={editing.id?'Record renewed VAT clearance':'Add VAT clearance'} close={()=>setEditing(null)} label={editing.id?'Save renewal':'Save clearance'} onSubmit={async values=>{
      const body={reference:values.reference||undefined,issueDate:values.issueDate||null,expiryDate:values.expiryDate,notes:values.notes||undefined,reminders};
      if(editing.id)await api(`/company-compliance/${editing.id}/renew`,{method:'PUT',body:JSON.stringify(body)});else await post('/company-compliance',{...body,companyId});
      setEditing(null);await load();}}>
      <p className="form-note wide">This clearance applies to <strong>{company?.name}</strong>. After saving, open the record and upload the issued certificate.</p>
      <Field name="reference" label="Certificate / clearance reference" defaultValue={editing.reference||''} required={false}/><Field name="issueDate" label="Issued on" type="date" defaultValue={editing.issueDate||todayInput()} required={false}/><Field name="expiryDate" label="Expires on" type="date" defaultValue={editing.expiryDate||''}/><Field name="notes" label="Notes" defaultValue={editing.notes||''} required={false} wide/>
      <div className="wide"><h3>Reminder schedule</h3><p className="form-note">Add up to 30 reminders. Zero days means the expiry date.</p>{reminders.map((reminder,index)=><div className="row-actions" key={index} style={{marginBottom:10}}><select value={reminder.unit} aria-label={`Reminder ${index+1} unit`} onChange={event=>setReminders(reminders.map((item,i)=>i===index?(event.target.value==='Date'?{unit:'Date',date:''}:{unit:event.target.value,value:1}):item))}>{['Days','Weeks','Months','Date'].map(unit=><option key={unit}>{unit}</option>)}</select>{reminder.unit==='Date'?<input required type="date" value={reminder.date||''} onChange={event=>setReminders(reminders.map((item,i)=>i===index?{...item,date:event.target.value}:item))}/>:<input required type="number" min="0" max="3650" value={reminder.value} onChange={event=>setReminders(reminders.map((item,i)=>i===index?{...item,value:Number(event.target.value)}:item))}/>}<button type="button" className="secondary" onClick={()=>setReminders(reminders.filter((_,i)=>i!==index))}>Remove</button></div>)}<button type="button" className="secondary" disabled={reminders.length>=30} onClick={()=>setReminders([...reminders,{unit:'Days',value:30}])}>Add reminder</button></div>
    </FormModal>}
  </>;
}
