import './BiometricCorrection.css';
import {useEffect,useState,useRef} from 'react';
import {api,post,shortDate} from '../api.js';
import {Field,FormModal,SelectField,TextArea} from '../ui.jsx';
import {notice} from '../notices.js';

const parse=value=>typeof value==='string'?JSON.parse(value):value||{};
export default function BiometricCorrection({data,reload,onDone}){
 const [mappings,setMappings]=useState(null),[history,setHistory]=useState([]),[error,setError]=useState(''),[code,setCode]=useState(''),[source,setSource]=useState(''),[mode,setMode]=useState('Existing profile'),[review,setReview]=useState(null),[input,setInput]=useState(null),[choices,setChoices]=useState({});
 useEffect(()=>{Promise.all([api('/biometric/correction-mappings'),api('/biometric/corrections/history')]).then(([m,h])=>{setMappings(m);setHistory(h);}).catch(e=>setError(e.message));},[]);
 const previewSubmit=useRef(false),committed=useRef(false);
 const people=data.employees||[];
 const selectCode=value=>{setCode(value);setSource(String(mappings.find(m=>m.code===value)?.employeeId||''));};
 const close=()=>onDone(committed.current);
 if(!mappings)return <FormModal title="Correct fingerprint identity" close={close} label="Close" onSubmit={async()=>{}}><p className="wide">{error||'Loading saved scanner identities…'}</p></FormModal>;
 if(review)return <FormModal wide title="Review fingerprint attendance transfer" close={close} label="Transfer selected records and correct mapping" onSubmit={async values=>{
  const selections=review.rows.filter(r=>choices[r.id]&&choices[r.id]!=='Skip').map(r=>({id:Number(r.id),decision:choices[r.id]}));
  if(!selections.length)throw Error('Select at least one attendance day.');
  const saved=await post('/biometric/corrections/commit',{...input,digest:review.digest,selections,reason:values.reason,acknowledgeLegacy:values.legacy==='on',acknowledgePayroll:values.payroll==='on'});
  committed.current=true;
  notice({title:'Fingerprint identity corrected',message:`${saved.moved} day(s) moved; ${saved.kept} target day(s) kept. Regenerate affected Draft payrolls and review related HR inputs.`,severity:'Info'});
  try{await reload();}catch{notice({title:'Correction saved',message:'Refresh the page to see updated attendance.',severity:'Warning'});}
 }}>
  <div className="wide"><strong>Device #{input.code}: {review.source.name} → {review.target.name}</strong><p>{shortDate(input.from)} – {shortDate(input.to)}. Unselected days stay on the original profile. Future imports use the corrected mapping.</p>
   <button type="button" className="secondary" onClick={()=>setReview(null)}>Change selection</button>
   <button type="button" className="secondary" onClick={()=>setChoices(Object.fromEntries(review.rows.map(r=>[r.id,r.conflict?'Skip':'Move'])))}>Select all days without conflicts</button>
   <button type="button" className="secondary" onClick={()=>setChoices({})}>Leave all unchanged</button>
   <p>{review.rows.filter(r=>choices[r.id]&&choices[r.id]!=='Skip').length} of {review.rows.length} days selected</p>
   {review.target.newProfile&&<p>A new profile will be created when you transfer. Complete its salary and employment details afterward.</p>}
  </div>
  <div className="wide" style={{maxHeight:360,overflow:'auto'}}><table className="biometric-correction-table"><thead><tr><th>Date</th><th>Imported punches</th><th>Target record</th><th>Decision</th></tr></thead><tbody>
   {review.rows.map(row=><tr key={row.id}><td>{shortDate(row.workDate)}{row.legacy&&<small>Machine ID not saved — verify</small>}{row.corrected&&<small>Has an HR correction</small>}</td>
    <td>{row.checkIn||'—'} / {row.siteStop||'—'} / {row.checkOut||'—'}<small>{row.state} · {row.workLocation}</small></td>
    <td>{row.conflict?<>{row.conflict.check_in||'—'} / {row.conflict.site_stop||'—'} / {row.conflict.check_out||'—'}<small>{row.conflict.state}</small></>:'No existing day'}</td>
    <td><select aria-label={`Transfer decision ${row.workDate}`} value={choices[row.id]||'Skip'} onChange={e=>setChoices(c=>({...c,[row.id]:e.target.value}))}>
     <option value="Skip">Leave unchanged</option>{row.conflict?<><option value="Keep target">Keep target (archive imported)</option><option value="Use imported">Use imported (archive target)</option></>:<option value="Move">Move to correct profile</option>}
    </select></td></tr>)}
  </tbody></table>{!review.rows.length&&<p>No matching attendance in this range. Change the range or source profile.</p>}</div>
  <p className="form-note wide">Times, site stop, location and existing HR corrections are preserved. Archived alternatives remain in audit history. Transfers do not move leave, reviewed OT, payroll claims or site cost records; review those separately.</p>
  {review.rows.some(r=>r.legacy)&&<label className="wide"><input type="checkbox" name="legacy"/> I verified that the selected legacy days belong to this scanner person.</label>}
  {review.payroll.length>0&&<div className="wide"><strong>Affected payroll</strong><ul>{review.payroll.map(r=><li key={r.payslipId}>{r.reference} — {r.status}</li>)}</ul><p>Draft approvals will be blocked until you explicitly regenerate them. Approved/Paid snapshots and payments stay unchanged.</p></div>}
  {review.payroll.some(r=>r.status!=='Draft')&&<label className="wide"><input type="checkbox" name="payroll" required/> I understand this does not correct or repay Approved/Paid payroll. Historical payment corrections need separate HR/Finance review.</label>}
  {review.related.length>0&&<p className="form-note wide">{review.related.length} reviewed OT / payroll claim record(s) remain with their existing employees and need HR review.</p>}
  <TextArea name="reason" label="Reason for identity correction" wide/>
 </FormModal>;
 return <FormModal wide title="Correct fingerprint mapping & transfer attendance" close={()=>{if(previewSubmit.current)previewSubmit.current=false;else close();}} label="Preview attendance" onSubmit={async values=>{
  const body={code,sourceEmployeeId:Number(source),from:values.from,to:values.to,...(mode==='New profile'?{newProfile:{code:values.newCode,name:values.newName,joinDate:values.joinDate,companyId:Number(values.companyId),workerType:values.workerType}}:{targetEmployeeId:Number(values.targetEmployeeId)})};
  const result=await post('/biometric/corrections/preview',body);previewSubmit.current=true;setInput(body);setReview(result);setChoices(Object.fromEntries(result.rows.map(row=>[row.id,!row.legacy&&!row.conflict?'Move':'Skip'])));
 }}>
  <label className="wide">Fingerprint machine ID<select required value={code} onChange={e=>selectCode(e.target.value)}><option value="">Choose saved machine ID</option>{mappings.map(m=><option key={m.code} value={m.code}>{m.code} — {m.scannerName||m.employee} (currently {m.employee})</option>)}</select></label>
  <label>Wrong profile holding attendance<select required value={source} onChange={e=>setSource(e.target.value)}><option value="">Choose employee</option>{people.map(p=><option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></label>
  <label>Correct profile<select value={mode} onChange={e=>setMode(e.target.value)}><option>Existing profile</option><option>New profile</option></select></label>
  {mode==='Existing profile'?<SelectField name="targetEmployeeId" label="Move to employee" options={[["",'Choose correct employee'],...people.filter(p=>Number(p.id)!==Number(source)).map(p=>[p.id,`${p.code} — ${p.name}`])]} wide/>:<>
   <Field name="newName" label="Correct employee name"/><Field name="newCode" label="New employee code"/><Field name="joinDate" label="Employment start date" type="date"/>
   <SelectField name="companyId" label="Payroll company" options={[["",'Choose company'],...(data.companies||[]).map(c=>[c.id,c.name])]}/><SelectField name="workerType" label="Work type" options={['Site','Office']}/>
  </>}
  <Field name="from" label="Attendance from" type="date"/><Field name="to" label="Attendance to" type="date"/>
  <p className="form-note wide">Preview makes no changes. Only selected attendance days move. Leave, OT approvals, claims, salary settings and site cost records require separate review.</p>
  {!!history.length&&<div className="wide"><strong>Recent identity corrections</strong>{history.slice(0,5).map(entry=>{const d=parse(entry.detail);return <div key={entry.id}>{shortDate(entry.createdAt)} · {entry.correctedBy} · #{d.code}: {d.sourceEmployee} → {d.targetEmployee} · {d.moved} moved / {d.kept} kept<br/>{d.reason}{d.records?.length>0&&<details><summary>Attendance decisions</summary>{d.records.map(r=><div key={r.id}>{shortDate(r.workDate)} · {r.checkIn||'—'} / {r.siteStop||'—'} / {r.checkOut||'—'} · {r.decision}{r.conflict&&<small>Alternative target: {r.conflict.check_in||'—'} / {r.conflict.site_stop||'—'} / {r.conflict.check_out||'—'}</small>}</div>)}</details>}</div>;})}</div>}
 </FormModal>;
}
