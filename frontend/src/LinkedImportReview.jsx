import React,{useState} from 'react';

export default function LinkedImportReview({review,setReview,busy,onSave,onConfirm}){
 const [sheet,setSheet]=useState(review.sheets[0]),[from,setFrom]=useState(''),[to,setTo]=useState(''),[verified,setVerified]=useState(false);
 const update=change=>{setVerified(false);setReview(current=>({...current,...change,status:current.status}));};
 const edit=(index,field,value)=>update({rows:review.rows.map((r,i)=>i===index?{...r,data:{...r.data,[field]:value}}:r)});
 const employeeCodes=[...new Set(review.rows.flatMap(r=>[r.data.PROJECT_MANAGER_EMPLOYEE_CODE,r.data.EMPLOYEE_CODE]).filter(Boolean))];
 const locked=review.status==='Imported';
 const label=field=>field.replaceAll('_',' ');
 return <section className="table-panel linked-import-review" style={{padding:24,marginTop:20}}>
  <h2>Verify linked {review.kind} workbook</h2>
  <p>Import in order: Clients + Contacts → Projects + Project Team → BOQ Headers + BOQ Items. Source codes connect these files; they are not database IDs. Imported codes are skipped on repeat uploads. BOQs are created as Draft; source approval details remain in import history.</p>
  <p>{review.counts.create} to create · {review.counts.link||0} existing records to link · {review.counts.skip} already imported · {review.counts.blocked} rows need correction</p>
  {!locked&&<>
   <details><summary>Correct a source code across this workbook</summary><p>Replaces an exact code in every relationship field. Verify the relationship before applying.</p>
    <div className="toolbar"><label>Source code<input value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Correct code<input value={to} onChange={e=>setTo(e.target.value)}/></label><button disabled={busy||!from.trim()||!to.trim()} className="secondary" onClick={()=>update({rows:review.rows.map(row=>({...row,data:Object.fromEntries(Object.entries(row.data).map(([key,value])=>[key,key.endsWith('_CODE')&&String(value).trim()===from.trim()?to.trim():value]))}))})}>Replace exact code</button></div>
   </details>
   {employeeCodes.length>0&&<div className="form-grid"><h3 className="wide">Match source employee codes</h3>{employeeCodes.map(code=><label key={code}>{code}<select aria-label={code} value={review.employeeMap?.[code]||''} onChange={e=>{const employeeMap={...review.employeeMap};if(e.target.value)employeeMap[code]=Number(e.target.value);else delete employeeMap[code];update({employeeMap});}}><option value="">Use exact saved employee code</option>{review.context.employees.map(e=><option value={e.id} key={e.id}>{e.code} · {e.name}</option>)}</select></label>)}</div>}
  </>}
  <div className="toolbar">{review.sheets.map(name=><button className={sheet===name?'primary':'secondary'} key={name} onClick={()=>setSheet(name)}>{name} ({review.rows.filter(r=>r.sheet===name).length})</button>)}</div>
  <div className="import-review-scroll"><table className="import-review-table import-edit-table"><thead><tr><th>Source row / decision</th><th>Review issues / action</th>{(review.fields[review.rows.find(r=>r.sheet===sheet)?.type]||[]).map(field=><th key={field}>{label(field)}</th>)}</tr></thead><tbody>
   {review.rows.map((row,index)=>row.sheet!==sheet?null:<tr key={index}>
    <td>{row.row}<small>{row.code}</small><strong>{row.action}</strong>
     {['clients','projects'].includes(row.type)&&<select disabled={busy||locked||row.action==='skip'} aria-label={`Existing target row ${row.row}`} value={row.targetId||''} onChange={e=>update({rows:review.rows.map((r,i)=>i===index?{...r,targetId:Number(e.target.value)||null}:r)})}><option value="">Create new record</option>{review.context[row.type].map(target=><option key={target.id} value={target.id}>{target.name}</option>)}</select>}
    </td>
    <td>{row.errors.map((error,i)=><p className="form-error" key={i}>{error}</p>)}{row.warnings?.map((warning,i)=><p key={i}>{warning}</p>)}
     {!locked&&row.type==='contacts'&&!['Yes','No',''].includes(String(row.data.PRIMARY_CONTACT))&&<button className="secondary" onClick={()=>{const rows=review.rows.map((r,i)=>i===index?{...r,data:{...r.data,PHONE:String(r.data.PRIMARY_CONTACT),PRIMARY_CONTACT:'No'}}:r);update({rows});}}>Move value to phone</button>}
     {!locked&&row.type==='items'&&<button className="secondary" onClick={()=>edit(index,'AMOUNT_LKR',Math.round(Number(row.data.QUANTITY)*Number(row.data.RATE_LKR)*100)/100)}>Use quantity × rate</button>}
     {!locked&&row.type==='boqs'&&<button className="secondary" onClick={()=>edit(index,'DECLARED_TOTAL_LKR',Math.round(review.rows.filter(r=>r.type==='items'&&r.data.BOQ_CODE===row.data.BOQ_CODE).reduce((s,r)=>s+Number(r.data.AMOUNT_LKR||0),0)*100)/100)}>Use items total</button>}
    </td>
    {review.fields[row.type].map(field=><td key={field}><input disabled={busy||locked} aria-label={`${field} row ${row.row}`} style={{minWidth:field==='DESCRIPTION'||field==='PROJECT_NAME'||field==='TITLE'?340:160}} value={row.data[field]??''} onChange={e=>edit(index,field,e.target.value)}/></td>)}
   </tr>)}
  </tbody></table></div>
  {locked?<p>Imported. Source keys, reviewed values and relationships are retained in this report.</p>:<div className="report-form">
   <p className="form-note wide">Correct highlighted values, then Save review and recheck. Financial differences are never silently adjusted. Linking an existing record does not overwrite its details.</p>
   <label className="wide"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)} disabled={busy}/> I checked all sheets, relationship keys, employee matches and totals.</label>
   <div className="form-actions wide"><button className="secondary" onClick={onSave} disabled={busy}>Save review and recheck</button><button className="primary" onClick={onConfirm} disabled={busy||!verified}>Confirm and create linked records</button></div>
  </div>}
 </section>;
}
