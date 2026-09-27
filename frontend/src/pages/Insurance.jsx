import React,{useEffect,useState} from 'react';
import {api,post,patch,shortDate,rupees} from '../api.js';
import {Table,Row,Badge,FormModal,Field,SelectField,TextArea,useLiveList} from '../ui.jsx';
export default function Insurance(){
  const [records,setRecords]=useState([]),[options,setOptions]=useState({projects:[],employees:[],vehicles:[]}),[editing,setEditing]=useState(null),[kind,setKind]=useState('Work site'),[reminders,setReminders]=useState([]),[error,setError]=useState('');
  const load=()=>api('/insurance').then(rows=>{setRecords(rows);setError('');}).catch(e=>setError(e.message));
  useLiveList(load);
  useEffect(()=>{api('/insurance/options').then(setOptions).catch(e=>setError(e.message));},[]);
  const open=record=>{setEditing(record);setKind(record.kind||'Work site');setReminders(record.reminders||[]);};
  return <>
    <div className="panel-title"><h2>Insurance register</h2><button className="primary" onClick={()=>open({})}>Add insurance policy</button></div>
    <p className="form-note">Site cover, employee life insurance and vehicle policies. Vehicle insurance uses Fleet's current document and renewal history; add coverage details and reminders here. Custom reminders are sent to users with HR insurance access.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="attendance-summary">{['Work site','Employee life','Vehicle'].map(type=><div className="summary" key={type}><div><strong>{records.filter(r=>r.kind===type&&r.status==='Active').length}</strong><span>{type} · active policies</span></div></div>)}</div>
    <Table title="Policies & renewals" columns={['Policy','Cover','Period / expiry','Premium','Status','']} template="minmax(190px,1fr) minmax(160px,1fr) 210px 120px 100px 80px" empty="No insurance policies recorded.">
      {records.map(record=><Row key={record.id} template="minmax(190px,1fr) minmax(160px,1fr) 210px 120px 100px 80px"><strong>{record.name}<small>{record.isFleetOnly?'Fleet record · complete HR details':`${record.insurer} · ${record.policy_number}`}</small></strong><span>{record.kind}<small>{record.project||record.employee||record.vehicle}{record.vehicle_id&&<a href={`/fleet?record=${record.vehicle_id}`}>View in Fleet</a>}</small></span><span>{record.start_date?shortDate(record.start_date):'Start date not recorded'} – {shortDate(record.end_date)}<small>Expires {shortDate(record.expiry_date)} · {record.reminders.length} reminder(s)</small></span><span>{rupees(record.premium)}</span><Badge>{record.status}</Badge><button className="secondary" onClick={()=>open(record)}>{record.isFleetOnly?'Complete':'Edit'}</button></Row>)}
    </Table>
    {editing&&<FormModal title={editing.id&&!editing.isFleetOnly?'Edit insurance policy':editing.isFleetOnly?'Complete Fleet insurance policy':'Add insurance policy'} label="Save policy" close={()=>setEditing(null)} wide onSubmit={async values=>{
      const body={name:values.name,kind,projectId:kind==='Work site'?Number(values.projectId):null,employeeId:kind==='Employee life'?Number(values.employeeId):null,vehicleId:kind==='Vehicle'?Number(values.vehicleId):null,insurer:values.insurer,policyNumber:values.policyNumber,startDate:values.startDate,endDate:values.endDate,expiryDate:values.expiryDate,premium:Number(values.premium||0),contact:values.contact,coverage:values.coverage,notes:values.notes,status:values.status,reminders};
      if(editing.id&&!editing.isFleetOnly)await patch(`/insurance/${editing.id}`,body);else await post('/insurance',body);await load();
    }}>
      <Field name="name" label="Insurance name" defaultValue={editing.name}/>
      <label>Insurance type<select value={kind} onChange={e=>setKind(e.target.value)}><option>Work site</option><option>Employee life</option><option>Vehicle</option></select></label>
      {kind==='Work site'&&<SelectField name="projectId" label="Project / work site" defaultValue={editing.project_id||''} options={[["","Choose a project…"],...options.projects.map(p=>[p.id,p.name])]}/>}
      {kind==='Employee life'&&<SelectField name="employeeId" label="Employee" defaultValue={editing.employee_id||''} options={[["","Choose an employee…"],...options.employees.map(p=>[p.id,`${p.name} (${p.code})`])]}/>}
      {kind==='Vehicle'&&<SelectField name="vehicleId" label="Vehicle" defaultValue={editing.vehicle_id||''} options={[["","Choose a vehicle…"],...options.vehicles.map(p=>[p.id,p.name])]}/>}
      <Field name="insurer" label="Insurer / provider" required={false} defaultValue={editing.insurer}/>
      <Field name="policyNumber" label="Policy number" required={false} defaultValue={editing.policy_number}/>
      <Field name="contact" label="Agent / contact details" required={false} defaultValue={editing.contact}/>
      <Field name="startDate" label="Coverage starts" type="date" defaultValue={editing.start_date}/>
      <Field name="endDate" label="Coverage ends" type="date" defaultValue={editing.end_date}/>
      <Field name="expiryDate" label="Renewal / expiry date" type="date" defaultValue={editing.expiry_date}/>
      <Field name="premium" label="Premium (LKR) — record only" type="number" min="0" required={false} defaultValue={editing.premium||0}/>
      <SelectField name="status" label="Policy status" options={['Active','Archived']} defaultValue={editing.status||'Active'}/>
      <TextArea name="coverage" label="Coverage / beneficiaries / exclusions" required={false} defaultValue={editing.coverage}/>
      <TextArea name="notes" label="Insurance notes" required={false} defaultValue={editing.notes}/>
      <div className="wide"><h3>Custom reminders</h3><p className="form-note">Add any number of reminder points (up to 30): days, weeks or calendar months before expiry, or a specific date. Zero days means expiry day. Saving a premium here does not post a financial expense.</p>
        {reminders.map((reminder,index)=><div className="row-actions" key={index} style={{marginBottom:10}}>
          <select aria-label={`Reminder ${index+1} unit`} value={reminder.unit} onChange={e=>setReminders(reminders.map((r,i)=>i===index?(e.target.value==='Date'?{unit:'Date',date:''}:{unit:e.target.value,value:1}):r))}>{['Days','Weeks','Months','Date'].map(unit=><option key={unit}>{unit}</option>)}</select>
          {reminder.unit==='Date'?<input aria-label={`Reminder ${index+1} date`} required type="date" value={reminder.date} onChange={e=>setReminders(reminders.map((r,i)=>i===index?{...r,date:e.target.value}:r))}/>:<input aria-label={`Reminder ${index+1} amount`} required type="number" min="0" max={reminder.unit==='Months'?120:3650} value={reminder.value} onChange={e=>setReminders(reminders.map((r,i)=>i===index?{...r,value:Number(e.target.value)}:r))}/>}
          <button className="secondary" type="button" onClick={()=>setReminders(reminders.filter((_,i)=>i!==index))}>Remove</button>
        </div>)}
        <button className="secondary" type="button" disabled={reminders.length>=30} onClick={()=>setReminders([...reminders,{unit:'Days',value:7}])}>Add reminder</button>
      </div>
      {kind==='Vehicle'&&<p className="form-note wide">Active vehicle insurance updates the same insurance expiry, reference and premium shown in Fleet. Existing fleet insurance is not duplicated.</p>}
    </FormModal>}
  </>;
}
