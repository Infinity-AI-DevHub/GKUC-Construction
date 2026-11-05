import React,{useState} from 'react';
import {api,post,fetchDownload} from './api.js';
import {Modal} from './ui.jsx';

export default function BondImport({companyId,data,close,reload}){
 const [preview,setPreview]=useState(null),[rows,setRows]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const change=(index,update)=>setRows(current=>current.map((row,i)=>i===index?{...row,...update,verified:false}:row));
 const run=async action=>{setBusy(true);setError('');try{await action();}catch(failure){setError(failure.message);}finally{setBusy(false);}};
 return <Modal title="Import / update bonds from Excel" close={()=>{if(!busy)close();}} wide>
  <div className="report-form">
   <p className="form-note wide">Download the workbook containing this company’s existing bonds. Keep System reference to update a record; leave it blank for a new bond. You can also upload a workbook with the same headings. Dates must be Excel dates or YYYY-MM-DD. Up to 300 rows.</p>
   <div className="wide row-actions"><button className="secondary" disabled={busy} onClick={()=>run(async()=>{
    const url=await fetchDownload(`/receivables/bonds/import/template?companyId=${companyId}`);const a=document.createElement('a');a.href=url;a.download='bond-import.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
   })}>Download Excel template / current bonds</button>
   <label>Upload Excel (.xlsx)<input disabled={busy} type="file" accept=".xlsx" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)run(async()=>{
    const form=new FormData();form.append('companyId',companyId);form.append('file',file);
    const result=await api('/receivables/bonds/import/preview',{method:'POST',body:form});setPreview(result);setRows(result.rows.map(row=>({...row,verified:false})));
   });}}/></label></div>
   {error&&<p className="form-error wide" role="alert">{error}</p>}
   {preview&&<>
    <p className="wide">Nothing has been saved to the bond register. Review every field, choose whether each row creates or updates a bond, and mark each row verified. Editing a row clears its verification. Blank Excel cells preserve existing values on matched bonds.</p>
    <strong className="wide">{rows.filter(row=>row.verified).length} / {rows.length} rows verified</strong>
    {rows.map((row,index)=><details className="workspace-surface wide" key={index} open={rows.length===1||undefined}>
     <summary>Row {row.row} · {row.sheet} · {row.data.bondNumber||row.data.beneficiary||'Bond'} · {row.targetId?'Update':'New'} · {row.verified?'Verified':'Review required'}</summary>
     <div className="report-form">
      {row.needsMatch&&<p className="form-note wide">The source reference/number could not be matched uniquely. Select the correct record or explicitly choose Create new bond.</p>}
      <label className="wide">Save this row as<select disabled={busy} value={row.needsMatch?'__choose':row.targetId||''} onChange={event=>{
       if(event.target.value==='__choose')return;
       const id=Number(event.target.value)||null;
       change(index,{targetId:id,needsMatch:false});
      }}><option value="__choose" disabled>Choose an existing bond or create new</option><option value="">Create new bond</option>{preview.existing.map(b=><option key={b.id} value={b.id}>{b.reference} · {b.bondNumber||'No bond number'} · {b.bank}</option>)}</select></label>
      {row.targetId&&<details className="wide"><summary>Compare with current saved details</summary><dl>{preview.columns.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{String(preview.existing.find(b=>Number(b.id)===Number(row.targetId))?.data[key]??'—')}</dd></div>)}</dl></details>}
      {preview.columns.filter(([key])=>key!=='reference').map(([key,label,type,options])=><label key={key}>{label}
       {key==='projectId'?<select disabled={busy} value={row.data[key]??''} onChange={event=>change(index,{data:{...row.data,[key]:event.target.value?Number(event.target.value):null}})}><option value="">Not project specific</option>{data.projects.filter(p=>Number(p.companyId)===Number(companyId)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
       :type==='select'?<select disabled={busy} value={row.data[key]??''} onChange={event=>change(index,{data:{...row.data,[key]:event.target.value}})}><option value="">Choose…</option>{options.map(option=><option key={option}>{option}</option>)}</select>
       :<input disabled={busy} type={type} step={type==='number'?'any':undefined} value={row.data[key]??''} onChange={event=>change(index,{data:{...row.data,[key]:type==='number'?(event.target.value===''?'':Number(event.target.value)):type==='date'?(event.target.value||null):event.target.value}})}/>}
      </label>)}
      {row.errors?.length>0&&<p className="form-note wide">Issues found on upload (correct above before submitting): {row.errors.join('; ')}</p>}
      <label className="wide"><input type="checkbox" disabled={busy||row.needsMatch} checked={row.verified} onChange={event=>setRows(current=>current.map((r,i)=>i===index?{...r,verified:event.target.checked}:r))}/> I checked all fields and the selected target for this row.</label>
     </div>
    </details>)}
    <div className="form-actions wide"><button className="secondary" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy||rows.some(row=>!row.verified||row.needsMatch)} onClick={()=>run(async()=>{
     await post(`/receivables/bonds/import/${preview.id}/submit`,{rows:rows.map(({targetId,verified,data})=>({targetId,verified,data}))});await reload();close();
    })}>{busy?'Saving…':'Submit verified bonds'}</button></div>
   </>}
  </div>
 </Modal>;
}
