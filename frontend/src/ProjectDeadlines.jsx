import React,{useEffect,useState} from 'react';
import {api,patch,post,openDocument,shortDate,todayInput} from './api.js';
import {Badge,Field,FormModal,TextArea} from './ui.jsx';
export const projectDeliveryStatus=p=>p.stage==='Completed'||p.health==='Completed'||p.site_status==='Completed'?'Completed':Number(p.extension_count)>0?'Extended':'Current';
export default function ProjectDeadlines({project,can,refresh}){
 const [history,setHistory]=useState([]),[action,setAction]=useState(''),[error,setError]=useState(''),[client,setClient]=useState(null);
 const load=()=>api(`/projects/${project.id}/extensions`).then(setHistory).catch(e=>setError(e.message));
 useEffect(()=>{load();if(project.clientId)api(`/clients/${project.clientId}`).then(setClient).catch(()=>{});},[project.id,project.end_date]);
 const status=projectDeliveryStatus(project),end=String(project.end_date||'').slice(0,10);
 return <section className="workspace-surface" style={{padding:20}}>
  <div className="workspace-section-heading"><div><h2>Completion date & extensions</h2><p>End date: <strong>{end?shortDate(end):'Not set'}</strong> · <Badge tone={status==='Completed'?'completed':status==='Extended'?'watch':'on-track'}>{status}</Badge></p></div>
   {can.projects&&status!=='Completed'&&<button className="secondary" onClick={()=>setAction(end?'extend':'date')}>{end?'Extend project':'Add end date'}</button>}
  </div>
  <p className="form-note">End date is optional. All active system users receive a daily in-app reminder from one calendar month before this date, including overdue days, until completion or a revised date moves it outside that window. Extensions update the internal programme; client approval is requested separately by letter.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {history.length>0&&<div className="import-review-scroll"><table className="import-review-table"><thead><tr><th>Reference / requested</th><th>Previous end</th><th>Revised end</th><th>Reason / conditions</th><th></th></tr></thead><tbody>{history.map(row=><tr key={row.id}><td>{row.reference}<br/>{shortDate(row.requestDate)}</td><td>{shortDate(row.previousEndDate)}</td><td>{shortDate(row.newEndDate)}</td><td style={{whiteSpace:'pre-wrap'}}>{row.reason}</td><td><button className="secondary" onClick={()=>openDocument(`/projects/${project.id}/extensions/${row.id}/letter`)}>Print request letter</button></td></tr>)}</tbody></table></div>}
  {action==='date'&&<FormModal title="Add project end date" label="Save end date" close={()=>setAction('')} onSubmit={async v=>{await patch(`/projects/${project.id}`,{endDate:v.endDate||null});await refresh();}}><Field name="endDate" label="End date (optional)" required={false} type="date" min={String(project.start_date||'').slice(0,10)}/></FormModal>}
  {action==='extend'&&<FormModal title="Extend project & prepare request letter" label="Save extension" close={()=>setAction('')} wide onSubmit={async v=>{
   const result=await post(`/projects/${project.id}/extensions`,{previousEndDate:end,newEndDate:v.newEndDate,reason:v.reason,requestDate:v.requestDate,recipientName:v.recipientName,recipientAddress:v.recipientAddress||'',signatoryName:v.signatoryName,signatoryTitle:v.signatoryTitle});
   await refresh();await load();
   openDocument(`/projects/${project.id}/extensions/${result.id}/letter`).catch(failure=>setError(`Extension saved. Use Print request letter below. ${failure.message}`));
  }}><label>Current end date<input value={end} readOnly/></label><Field name="newEndDate" label="Revised end date" type="date" min={end}/><Field name="requestDate" label="Letter date" type="date" defaultValue={todayInput()}/><TextArea name="reason" label="Reasons / conditions requiring extension"/><Field name="recipientName" label="Client / recipient" defaultValue={client?.name||project.client}/><TextArea name="recipientAddress" label="Client address (optional)" required={false} defaultValue={client?.billingAddress||''}/><Field name="signatoryName" label="Signatory name" defaultValue={project.manager}/><Field name="signatoryTitle" label="Signatory title" defaultValue="Project Manager"/><p className="form-note wide">The internal end date changes when saved. The printed letter requests client approval; it does not confirm that approval has been granted. Every extension and its letter remain in history.</p></FormModal>}
 </section>;
}
