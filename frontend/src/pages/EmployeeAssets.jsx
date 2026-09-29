import React,{useEffect,useState} from 'react';
import {api,post,patch,shortDate,todayInput} from '../api.js';
import {FormModal,Field,TextArea,Table,Row} from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import WorkflowChecklist from '../WorkflowChecklist.jsx';
export default function EmployeeAssets({employeeId,employeeName,employeeStatus,canEdit,canInitiate,canPayroll,canAccess}){
  const [rows,setRows]=useState([]),[checklist,setChecklist]=useState(null),[form,setForm]=useState(null),[evidence,setEvidence]=useState(null),[error,setError]=useState('');
  const load=async()=>{try{const [assets,check]=await Promise.all([canEdit?api(`/employees/${employeeId}/assets`):Promise.resolve([]),api(`/employees/${employeeId}/offboarding`)]);setRows(assets);setChecklist(check);setError('');}catch(e){setError(e.message);}};
  useEffect(()=>{load();},[employeeId]);
  return <section className="employee-panel employee-wide-panel">
    <div className="employee-section-title"><div><span>Company property & clearance</span><h2>Assets & offboarding</h2></div><div className="row-actions">
      {canInitiate&&!checklist?.offboarding&&employeeStatus!=='Left'&&<button className="secondary" onClick={()=>setForm({kind:'start'})}>Start offboarding</button>}
      {canEdit&&<button className="secondary" onClick={()=>setForm({})}>Hand over asset</button>}</div></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {checklist&&<><p className="form-note">{checklist.clear?'Clearance checklist is clear.':'Offboarding is blocked until the following obligations are resolved.'} <button className="secondary" onClick={load}>Refresh checklist</button></p>
      {checklist.offboarding&&<WorkflowChecklist title={`Offboarding · ${employeeName}`} steps={[
        {label:'Resignation or departure recorded',owner:'HR',done:true,detail:`Requested ${shortDate(checklist.offboarding.requestedOn)} · ${checklist.offboarding.reason}`},
        {label:'Return HR assets',owner:'HR',done:checklist.assets.length===0,detail:`${checklist.assets.length} open handovers`},
        {label:'Return store tools',owner:'Store',done:checklist.store.length===0,detail:`${checklist.store.length} open loans`,href:'/stock-locations'},
        {label:'Release vehicle',owner:'Fleet',done:checklist.vehicles.length===0,detail:`${checklist.vehicles.length} assignments`,href:'/fleet'},
        {label:'Reassign unfinished tasks',owner:'Projects',done:checklist.tasks.length===0,detail:`${checklist.tasks.length} open tasks`,href:'/tasks'},
        {label:'Remove system access',owner:'Administration',done:Boolean(checklist.offboarding.accessClearedAt),detail:'Confirm the account is deactivated or no access exists',href:'/administration/users'},
        {label:'Clear final payroll',owner:'HR payroll',done:Boolean(checklist.offboarding.payrollClearedAt),detail:'Confirm final pay, advances and deductions',href:'/people/payroll'},
        {label:'Mark employment ended',owner:'HR',done:employeeStatus==='Left',detail:'Allowed only after every clearance is complete'}
      ]}/>}
      {checklist.offboarding&&<div className="row-actions wide">
        {canAccess&&!checklist.offboarding.accessClearedAt&&<button className="secondary" onClick={()=>setForm({kind:'clearance',area:'access'})}>Confirm access clearance</button>}
        {canPayroll&&!checklist.offboarding.payrollClearedAt&&<button className="secondary" onClick={()=>setForm({kind:'clearance',area:'payroll'})}>Confirm payroll clearance</button>}
      </div>}
      {['assets','store','vehicles','tasks'].map(key=>checklist[key].length>0&&<div key={key}><h3>{{assets:'HR assets to return',store:'Store loans to return',vehicles:'Vehicle assignments to release',tasks:'Tasks to complete or reassign'}[key]}</h3><ul>{checklist[key].map(row=><li key={row.id}>{row.name} {row.code?`(${row.code})`:''} {row.project?`— ${row.project}`:''}</li>)}</ul></div>)}
      <p className="form-note">Use Store / Stock locations to return store loans, Fleet to release vehicles, and Tasks to complete or reassign work. HR records asset returns below.</p></>}
    <Table title="HR asset handover history" columns={['Asset','Handed over','Condition before','Return','']} template="minmax(180px,1fr) 120px minmax(200px,1fr) 160px 150px" empty="No HR asset handovers recorded.">{rows.map(row=><Row key={row.id} template="minmax(180px,1fr) 120px minmax(200px,1fr) 160px 150px"><strong>{row.asset_name}<small>{row.asset_code} · {row.category}</small></strong><span>{shortDate(row.handed_on)}</span><span>{row.condition_before}<small>{row.notes}</small></span><span>{row.returned_on?shortDate(row.returned_on):'With employee'}<small>{row.condition_returned}</small></span><div><button className="secondary" onClick={()=>setEvidence(row)}>Evidence</button>{canEdit&&!row.returned_on&&<button className="secondary" onClick={()=>setForm(row)}>Record return</button>}</div></Row>)}</Table>
    {evidence&&<div><h3>{evidence.asset_name} — evidence</h3><button className="secondary" onClick={()=>setEvidence(null)}>Close evidence</button><Attachments ownerType="handover" ownerId={evidence.id} title="Condition photos & handover files" canUpload={canEdit} canDelete={false}/></div>}
    {form&&<FormModal title={form.kind==='start'?'Start employee offboarding':form.kind==='clearance'?`Confirm ${form.area} clearance`:form.id?'Record asset return':'Hand over company asset'} label={form.kind==='start'?'Create clearance checklist':form.kind==='clearance'?'Confirm clearance':form.id?'Confirm return':'Record handover'} close={()=>setForm(null)} onSubmit={async v=>{
      if(form.kind==='start')await post(`/employees/${employeeId}/offboarding/start`,{requestedOn:v.requestedOn,reason:v.reason});
      else if(form.kind==='clearance')await patch(`/employees/${employeeId}/offboarding/clearance`,{area:form.area,note:v.note});
      else if(form.id)await patch(`/employees/${employeeId}/assets/${form.id}/return`,v);
      else{const created=await post(`/employees/${employeeId}/assets`,v);setEvidence({id:created.id,asset_name:v.assetName});}await load();}}>
      {form.kind==='start'?<><Field name="requestedOn" label="Departure request date" type="date" defaultValue={todayInput()}/><TextArea name="reason" label="Reason / resignation reference"/><p className="form-note wide">Starting this checklist creates responsibilities for HR, Store, Fleet, Administration and Payroll. The employee cannot be marked as left until every clearance is complete.</p></>
        :form.kind==='clearance'?<><TextArea name="note" label="What was checked?"/><p className="form-note wide">This confirmation is recorded in the audit trail. Check the authoritative access or payroll record first.</p></>
        :form.id?<><Field name="returnedOn" label="Return date" type="date" defaultValue={todayInput()}/><TextArea name="conditionReturned" label="Condition on return / clearance notes"/></>:<><Field name="assetName" label="Asset name"/><Field name="assetCode" label="Unique asset ID / serial / SIM number"/><Field name="category" label="Category (phone, SIM, laptop, etc.)"/><Field name="handedOn" label="Handover date" type="date" defaultValue={todayInput()}/><TextArea name="conditionBefore" label="Condition before handing over"/><TextArea name="notes" label="Accessories / handover notes" required={false}/><p className="form-note wide">After saving, upload photos or documents in Evidence. Store loans and fleet vehicle assignments remain in their existing registers and also appear in the clearance checklist.</p></>}
    </FormModal>}
  </section>;
}
