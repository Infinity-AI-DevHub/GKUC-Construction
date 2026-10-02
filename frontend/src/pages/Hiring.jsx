import React,{useEffect,useState} from 'react';
import {api,post,patch,upload} from '../api.js';
import {Table,Row,Badge,FormModal,Field,TextArea,SelectField,Modal} from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import WorkflowChecklist from '../WorkflowChecklist.jsx';

export default function Hiring({companies,companyId,reload}){
  const [rows,setRows]=useState([]),[candidate,setCandidate]=useState(null),[form,setForm]=useState(null),[roles,setRoles]=useState([]),[access,setAccess]=useState(false),[error,setError]=useState('');
  const [positionFilter,setPositionFilter]=useState(''),[compareIds,setCompareIds]=useState([]);
  const score=row=>{const value=typeof row.screening_scores==='string'?JSON.parse(row.screening_scores):row.screening_scores;return value||null;};
  const applicants=rows.filter(row=>['Applicant','Screening','Shortlisted','Dropped'].includes(row.status)&&(!positionFilter||row.position===positionFilter));
  const compared=rows.filter(row=>compareIds.includes(row.id));
  const load=()=>api('/hiring').then(setRows).catch(e=>setError(e.message));
  const open=async id=>{try{setCandidate(await api(`/hiring/${id}`));setError('');}catch(e){setError(e.message);}};
  useEffect(()=>{load();api('/hiring/roles').then(setRoles).catch(()=>setRoles([]));},[]);
  useEffect(()=>{const id=Number(new URLSearchParams(window.location.search).get('record'));if(id&&rows.some(row=>Number(row.id)===id)&&Number(candidate?.id)!==id)open(id);},[rows]);
  const refresh=async()=>{await load();if(candidate)await open(candidate.id);};
  return <>
    <div className="panel-title"><h2>Hiring pipeline</h2><div className="row-actions"><button className="secondary" onClick={()=>setForm({type:'candidate'})}>Add previously shortlisted</button><button className="primary" onClick={()=>setForm({type:'applicants'})}>Add applicants / CVs</button></div></div>
    <p className="form-note">Applicant pool → CV screening and score → Shortlist → Interview → Select or drop → Employee. Job advertising still happens outside the system.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="attendance-summary">{['Applicant','Screening','Shortlisted','Interviewing','Selected','Dropped','Hired'].map(status=><div className="summary" key={status}><div><strong>{rows.filter(r=>r.status===status).length}</strong><span>{status}</span></div></div>)}</div>
    <section className="panel hiring-pool"><div className="panel-title"><h2>Applicant CV review</h2><label>Position <select value={positionFilter} onChange={e=>setPositionFilter(e.target.value)}><option value="">All positions</option>{[...new Set(rows.map(r=>r.position).filter(Boolean))].sort().map(value=><option key={value}>{value}</option>)}</select></label></div>
      <p className="form-note">Add applicants and their CVs together, then open a profile to review and score experience, qualifications and role fit from 0–5. Select up to four applicants to compare.</p>
      <Table columns={['Compare','Applicant','Position','Screening score','Stage','Action']} template="70px minmax(150px,1.2fr) minmax(130px,1fr) 125px 115px 85px" empty="No applicants for this position yet.">
        {applicants.map(row=><Row key={row.id} template="70px minmax(150px,1.2fr) minmax(130px,1fr) 125px 115px 85px"><input type="checkbox" aria-label={`Compare ${row.name}`} checked={compareIds.includes(row.id)} onChange={e=>setCompareIds(ids=>e.target.checked?[...ids,row.id].slice(-4):ids.filter(id=>id!==row.id))}/><strong>{row.name}</strong><span>{row.position||'Not specified'}</span><strong>{score(row)?`${score(row).total} / 15`:'Not scored'}</strong><Badge>{row.status}</Badge><button className="secondary" onClick={()=>open(row.id)}>Review</button></Row>)}
      </Table>
      {compared.length>0&&<div className="hiring-comparison">{compared.map(row=><article key={row.id}><h3>{row.name}</h3><p>{row.position||'Position not specified'} · {row.status}</p><strong>{score(row)?`${score(row).total} / 15`:'Not scored'}</strong><span>Experience {score(row)?.experience??'—'} · Qualifications {score(row)?.qualifications??'—'} · Role fit {score(row)?.roleFit??'—'}</span><button className="secondary" onClick={()=>open(row.id)}>Open CV & review</button></article>)}</div>}
    </section>
    <Table title="Candidates" columns={['Candidate','Position','Contact','Status','']} template="minmax(160px,1fr) 160px minmax(150px,1fr) 110px 80px" empty="Add candidates after HR has shortlisted them.">
      {rows.map(row=><Row key={row.id} template="minmax(160px,1fr) 160px minmax(150px,1fr) 110px 80px"><strong>{row.name}</strong><span>{row.position||'—'}</span><span>{row.phone}<small>{row.email}</small></span><Badge>{row.status}</Badge><button className="secondary" onClick={()=>open(row.id)}>Open</button></Row>)}
    </Table>
    {candidate&&<section className="panel">
      <div className="panel-title"><h2>{candidate.name}</h2><button className="secondary" onClick={()=>setCandidate(null)}>Close profile</button></div>
      <WorkflowChecklist title="Applicant to employee" steps={[
        {label:'Applicant recorded',owner:'HR',done:true,detail:'Candidate profile is in the applicant pool'},
        {label:'CV reviewed and scored',owner:'HR',done:Boolean(candidate.screening_scores),detail:candidate.screening_scores?'Screening evidence recorded':'Upload CV and record screening scores'},
        {label:'Shortlisted',owner:'HR',done:['Shortlisted','Interviewing','Selected','Hired'].includes(candidate.status),detail:'Confirm this candidate proceeds to interview'},
        {label:'Interview completed',owner:'HR',done:candidate.interviews?.some(row=>row.status==='Completed'),detail:'Record the interview outcome'},
        {label:'Selection decision',owner:'HR',done:['Selected','Dropped','Hired'].includes(candidate.status),detail:candidate.status==='Dropped'?'Candidate dropped':'Select or drop after review'},
        {label:'Employee created',owner:'HR',done:candidate.status==='Hired',detail:candidate.status==='Hired'?`Employee profile #${candidate.employee_id}`:'Convert selected candidate; system access is optional'}
      ]}/>
      <div className="report-form"><p>{candidate.phone}<br/>{candidate.email}<br/>{candidate.address}</p><div><Badge>{candidate.status}</Badge><p>{candidate.decision_notes}</p></div>
      {candidate.status!=='Hired'&&<div className="wide row-actions"><button className="secondary" onClick={()=>setForm({type:'candidate',...candidate})}>Edit details</button>{['Applicant','Screening','Shortlisted','Dropped'].includes(candidate.status)&&<button className="secondary" onClick={()=>setForm({type:'screening'})}>Screen CV / shortlist</button>}{!['Applicant','Screening'].includes(candidate.status)&&<button className="secondary" onClick={()=>setForm({type:'decision'})}>Record selection decision</button>}{['Shortlisted','Interviewing'].includes(candidate.status)&&<button className="secondary" onClick={()=>setForm({type:'interview'})}>Schedule interview</button>}{candidate.status==='Selected'&&<button className="primary" onClick={()=>{setAccess(false);setForm({type:'hire'});}}>Convert to employee</button>}</div>}
      {candidate.screening_scores&&<p className="form-note wide">CV screening: {score(candidate)?.total} / 15 · {candidate.screening_notes}</p>}
      {candidate.status==='Hired'&&<p className="form-note wide">Employee profile #{candidate.employee_id} created. CV files are now available on that employee profile. HR can complete their pay settings in People.</p>}</div>
      {candidate.status!=='Hired'&&<Attachments ownerType="candidate" ownerId={candidate.id} title="CV & candidate documents" canUpload canDelete={false} />}
      <Table title="Interview history" columns={['Date / time','Interviewer','Location','Status','Notes','']} template="170px 140px 140px 100px minmax(180px,1fr) 70px" empty="No interviews recorded.">{candidate.interviews.map(i=><Row key={i.id} template="170px 140px 140px 100px minmax(180px,1fr) 70px"><span>{String(i.scheduled_at).replace('T',' ').slice(0,16)}</span><span>{i.interviewer}</span><span>{i.location}</span><Badge>{i.status}</Badge><span>{i.notes}</span>{candidate.status!=='Hired'&&<button className="secondary" onClick={()=>setForm({type:'interview',...i})}>Edit</button>}</Row>)}</Table>
    </section>}
    {form?.type==='applicants'&&<ApplicantBatchModal close={()=>setForm(null)} onSaved={load} />}
    {form?.type==='candidate'&&<FormModal title={form.id?'Edit candidate':'Add previously shortlisted candidate'} close={()=>setForm(null)} label="Save" onSubmit={async(v,data)=>{const values={name:v.name,phone:v.phone,email:v.email,position:v.position,address:v.address};const result=form.id?await patch(`/hiring/${form.id}`,values):await post('/hiring',values);setForm(previous=>({...previous,id:result.id}));const cv=data.get('cv');if(cv?.size)await upload('candidate',result.id,cv,{title:'CV'});await load();await open(result.id);}}><Field name="name" label="Name" defaultValue={form.name}/><Field name="phone" label="Phone" type="tel" required={false} defaultValue={form.phone}/><Field name="email" label="Email" type="email" required={false} defaultValue={form.email}/><Field name="position" label="Position applied for" required={false} defaultValue={form.position}/><TextArea name="address" label="Address" required={false} defaultValue={form.address}/><label className="wide">CV (optional)<input name="cv" type="file" accept=".pdf,.doc,.docx" /></label></FormModal>}
    {form?.type==='screening'&&<FormModal title={`CV screening · ${candidate.name}`} close={()=>setForm(null)} label="Save screening" onSubmit={async v=>{await patch(`/hiring/${candidate.id}/screening`,{experience:Number(v.experience),qualifications:Number(v.qualifications),roleFit:Number(v.roleFit),notes:v.notes,decision:v.decision});await refresh();}}><Field name="experience" label="Relevant experience (0–5)" type="number" min="0" max="5" defaultValue={score(candidate)?.experience??0}/><Field name="qualifications" label="Qualifications (0–5)" type="number" min="0" max="5" defaultValue={score(candidate)?.qualifications??0}/><Field name="roleFit" label="Role fit (0–5)" type="number" min="0" max="5" defaultValue={score(candidate)?.roleFit??0}/><SelectField name="decision" label="Screening decision" options={['Screening','Shortlisted','Dropped']} defaultValue={candidate.status==='Applicant'?'Screening':candidate.status}/><TextArea name="notes" label="CV evidence and review notes" defaultValue={candidate.screening_notes||''}/><p className="form-note wide">Read the uploaded CV before scoring. A shortlist decision enables interview scheduling.</p></FormModal>}
    {form?.type==='decision'&&<FormModal title="Record hiring decision" close={()=>setForm(null)} label="Save decision" onSubmit={async v=>{await patch(`/hiring/${candidate.id}`,v);await refresh();}}><SelectField name="status" label="Decision" options={['Shortlisted','Interviewing','Selected','Dropped']} defaultValue={candidate.status}/><TextArea name="decisionNotes" label="Decision notes" required={false} defaultValue={candidate.decision_notes}/></FormModal>}
    {form?.type==='interview'&&<FormModal title={form.id?'Update interview':'Schedule interview'} close={()=>setForm(null)} label="Save interview" onSubmit={async v=>{if(form.id)await patch(`/hiring/${candidate.id}/interviews/${form.id}`,v);else await post(`/hiring/${candidate.id}/interviews`,v);await refresh();}}><Field name="scheduledAt" label="Interview date and time (Sri Lanka)" type="datetime-local" defaultValue={form.scheduled_at?.slice(0,16)}/><Field name="interviewer" label="Interviewer" defaultValue={form.interviewer}/><Field name="location" label="Location / meeting link" required={false} defaultValue={form.location}/><SelectField name="status" label="Interview status" options={['Scheduled','Completed','Cancelled','No show']} defaultValue={form.status||'Scheduled'}/><TextArea name="notes" label="Interview notes and outcome" required={false} defaultValue={form.notes}/></FormModal>}
    {form?.type==='hire'&&<FormModal title={`Hire ${candidate.name}`} close={()=>setForm(null)} label="Create employee" onSubmit={async v=>{await post(`/hiring/${candidate.id}/hire`,{code:v.code,startDate:v.startDate,workerType:v.workerType,companyId:Number(v.companyId),createAccess:access,...(access?{roleId:Number(v.roleId),password:v.password}:{})});await refresh();await reload();}}><Field name="code" label="Employee ID"/><Field name="startDate" label="Actual employment start date" type="date"/><SelectField name="workerType" label="Employee type" options={['Office','Site']}/><SelectField name="companyId" label="Payroll company" options={companies.map(c=>[c.id,c.name])} defaultValue={companyId}/><label className="wide"><input type="checkbox" checked={access} onChange={e=>setAccess(e.target.checked)}/>Also create system access</label>{access&&<><p className="form-note wide">A candidate email is required. You can assign only roles within your own authority. The MD can assign additional access later.</p><SelectField name="roleId" label="Access role" options={roles.map(r=>[r.id,r.name])}/><Field name="password" label="Temporary password (12+ characters)" type="password"/></>}<p className="form-note wide">Creates one employee profile and preserves the CV there. Pay rates start at zero and EPF/ETF eligibility remains off until HR configures them.</p></FormModal>}
  </>;
}

const blankApplicant=()=>({key:crypto.randomUUID(),name:'',phone:'',email:'',position:'',address:'',cv:null,savedId:null,uploaded:false,error:''});
function ApplicantBatchModal({close,onSaved}){
  const [items,setItems]=useState([blankApplicant()]);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const change=(key,patch)=>setItems(rows=>rows.map(row=>row.key===key?{...row,...patch,error:''}:row));
  const save=async event=>{
    event.preventDefault();setBusy(true);setNotice('');
    let next=[...items];let saved=0;
    for(let index=0;index<next.length;index++){
      const row=next[index];
      if(row.savedId&&(!row.cv||row.uploaded))continue;
      try{
        let savedId=row.savedId;
        if(!savedId){
          const created=await post('/hiring/applicants',{name:row.name.trim(),phone:row.phone,email:row.email,position:row.position,address:row.address});
          savedId=created.id;
          next[index]={...row,savedId,error:''};setItems([...next]);
        }
        if(row.cv&&!row.uploaded)await upload('candidate',savedId,row.cv,{title:'CV'});
        next[index]={...next[index],savedId,uploaded:!!row.cv,error:''};
        saved++;
      }catch(failure){next[index]={...next[index],error:failure.message};}
      setItems([...next]);
    }
    if(saved)await onSaved();
    const failures=next.filter(row=>row.error).length;
    if(failures)setNotice(`${next.length-failures} applicant${next.length-failures===1?'':'s'} saved. Correct or retry the ${failures} remaining row${failures===1?'':'s'}; saved applicants will not be created twice.`);
    else close();
    setBusy(false);
  };
  return <Modal title="Add applicants and CVs" close={close} wide>
    <form className="applicant-batch" onSubmit={save}>
      <p className="form-note">Add each applicant here and choose their CV before saving. CVs are attached to the matching applicant automatically.</p>
      {notice&&<p className="form-note" role="status">{notice}</p>}
      <div className="applicant-batch-list">{items.map((row,index)=><section className="applicant-batch-card" key={row.key}>
        <header><h3>Applicant {index+1}{row.savedId?' · saved':''}</h3>{items.length>1&&!row.savedId&&<button type="button" className="secondary" onClick={()=>setItems(rows=>rows.filter(item=>item.key!==row.key))}>Remove</button>}</header>
        <div className="applicant-batch-fields">
          <label>Name *<input required minLength={2} value={row.name} disabled={!!row.savedId} onChange={event=>change(row.key,{name:event.target.value})}/></label>
          <label>Phone<input type="tel" value={row.phone} disabled={!!row.savedId} onChange={event=>change(row.key,{phone:event.target.value})}/></label>
          <label>Email<input type="email" value={row.email} disabled={!!row.savedId} onChange={event=>change(row.key,{email:event.target.value})}/></label>
          <label>Position applied for<input value={row.position} disabled={!!row.savedId} onChange={event=>change(row.key,{position:event.target.value})}/></label>
          <label className="wide">Address<textarea rows={2} value={row.address} disabled={!!row.savedId} onChange={event=>change(row.key,{address:event.target.value})}/></label>
          <label className="wide">CV (optional)<input type="file" accept=".pdf,.doc,.docx" disabled={row.uploaded} onChange={event=>change(row.key,{cv:event.target.files?.[0]||null})}/></label>
        </div>
        {row.error&&<p className="form-error" role="alert">{row.error}</p>}
      </section>)}</div>
      <div className="applicant-batch-actions"><button type="button" className="secondary" onClick={()=>setItems(rows=>[...rows,blankApplicant()])} disabled={busy}>Add another applicant</button><div><button type="button" className="secondary" onClick={close} disabled={busy}>Close</button><button type="submit" className="primary" disabled={busy||items.every(row=>row.savedId&&(!row.cv||row.uploaded))}>{busy?'Saving…':`Save ${items.length} applicant${items.length===1?'':'s'}`}</button></div></div>
    </form>
  </Modal>;
}
