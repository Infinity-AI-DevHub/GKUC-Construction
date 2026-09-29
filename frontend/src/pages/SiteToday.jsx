import React,{useEffect,useMemo,useState} from 'react';
import {Camera,CloudOff,Mic,RefreshCw,Save,Users} from 'lucide-react';
import {api,post,todayInput,upload} from '../api.js';
import {completeness,draftKey,readDraft,removeDraft,saveDraft} from '../site-today-store.js';

const empty=(projectId,date)=>({projectId,date,workforce:'',work:'',issue:'',materials:[],photos:[],attendance:[],attendanceSent:false,reportId:null,uploaded:[],counted:[],consumed:[],status:'Draft'});
const yesterday=date=>{const day=new Date(`${date}T12:00:00`);day.setDate(day.getDate()-1);return day.toISOString().slice(0,10);};

export default function SiteToday({data,user,reload}){
  const [projectId,setProjectId]=useState(Number(new URLSearchParams(location.search).get('project'))||Number(data.projects[0]?.id)||0);
  const [date,setDate]=useState(todayInput());
  const [draft,setDraft]=useState(()=>empty(projectId,date));
  const [previous,setPrevious]=useState(null);
  const [ready,setReady]=useState(false);
  const [online,setOnline]=useState(navigator.onLine);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const key=useMemo(()=>draftKey(user.id,projectId,date),[user.id,projectId,date]);
  useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false);window.addEventListener('online',on);window.addEventListener('offline',off);return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);};},[]);
  useEffect(()=>{let live=true;setReady(false);setMessage('');
    Promise.all([readDraft(key).catch(()=>null),navigator.onLine?api(`/reports/site-today/${projectId}`).catch(()=>null):Promise.resolve(null)])
      .then(([saved,context])=>{if(!live)return;setPrevious(context);
        setDraft(saved?{...saved,status:saved.status==='Syncing'?'Queued':saved.status}:{...empty(projectId,date),workforce:context?.previous?.workforce??'',materials:(context?.materials||[]).map(row=>({...row,quantity:Number(row.quantity)})),attendance:(context?.previousAttendance||[]).map(row=>({employeeId:row.employeeId,state:'On site'})),reportId:context?.todayReportId||null,status:context?.todayReportId?'Synced':'Draft'});
        setReady(true);}).catch(error=>{if(live){setReady(true);setMessage(error.message);}});
    return()=>{live=false;};},[key]);
  useEffect(()=>{if(!ready||draft.status==='Synced')return;const timer=setTimeout(()=>saveDraft(key,draft).catch(()=>setMessage('Draft could not be saved on this device.')),300);return()=>clearTimeout(timer);},[key,draft,ready]);
  const update=(field,value)=>setDraft(current=>({...current,[field]:value,status:'Draft'}));
  const addPhoto=event=>{const files=[...event.target.files||[]].filter(file=>file.type.startsWith('image/'));setDraft(current=>({...current,photos:[...current.photos,...files],status:'Draft'}));event.target.value='';};
  const toggleAttendance=id=>update('attendance',draft.attendance.some(row=>Number(row.employeeId)===Number(id))
    ?draft.attendance.filter(row=>Number(row.employeeId)!==Number(id)):[...draft.attendance,{employeeId:Number(id),state:'On site'}]);
  const speak=()=>{const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){setMessage('Voice notes are unavailable in this browser. Use the text box instead.');return;}const recognition=new Recognition();recognition.lang='en-LK';recognition.onresult=event=>update('work',`${draft.work} ${event.results[0][0].transcript}`.trim());recognition.onerror=()=>setMessage('Voice capture stopped. Your typed notes remain saved.');recognition.start();};
  const sync=async()=>{if(!online){const queued={...draft,status:'Queued'};await saveDraft(key,queued);setDraft(queued);setMessage('Saved on this device. It will sync when you reconnect.');return;}setBusy(true);setMessage('');
    try{
      for(const row of draft.materials)if(Number(row.quantity)>0&&!(draft.consumed||[]).includes(Number(row.materialId))){
        const position=await api(`/materials/site-position?projectId=${projectId}&materialId=${row.materialId}`);
        if(Number(row.quantity)>Number(position.balance)+0.0001)throw new Error(`${row.name||'Material'}: ${row.quantity} entered, but only ${position.balance} remains at this site. Correct the quantity or ask Store to issue stock.`);
      }
      if(draft.attendance.length&&!draft.attendanceSent){
        await post('/attendance/site-submissions',{projectId,date,entries:draft.attendance});
        setDraft(current=>({...current,attendanceSent:true,status:'Syncing'}));
        await saveDraft(key,{...draft,attendanceSent:true,status:'Syncing'});
      }
      let reportId=draft.reportId;
      if(!reportId){
        const report=await post('/reports',{projectId,reportDate:date,workforce:Number(draft.workforce),work:draft.work.trim(),issue:draft.issue||undefined,
          materials:draft.materials.filter(row=>Number(row.quantity)>0).map(row=>({materialId:Number(row.materialId),quantity:Number(row.quantity)}))});
        reportId=report.id;
        setDraft(current=>({...current,reportId,status:'Syncing'}));
        await saveDraft(key,{...draft,attendanceSent:true,reportId,status:'Syncing'});
      }
      const uploaded=[...draft.uploaded];
      for(let index=0;index<draft.photos.length;index++)if(!uploaded.includes(index)){
        await upload('report',reportId,draft.photos[index],{kind:'Site photo',title:`Site progress ${date}`});
        uploaded.push(index);setDraft(current=>({...current,uploaded:[...uploaded],reportId,status:'Syncing'}));
        await saveDraft(key,{...draft,attendanceSent:true,reportId,uploaded,status:'Syncing'});
      }
      const counted=[...(draft.counted||[])];
      const consumed=[...(draft.consumed||[])];
      for(const row of draft.materials)if(Number(row.quantity)>0&&!consumed.includes(Number(row.materialId))){
        await post('/materials/site-consumption',{projectId,materialId:Number(row.materialId),quantity:Number(row.quantity),consumedOn:date,
          clientRef:`site-today-use-${projectId}-${date}-${row.materialId}`});
        consumed.push(Number(row.materialId));setDraft(current=>({...current,consumed:[...consumed],reportId,status:'Syncing'}));
        await saveDraft(key,{...draft,attendanceSent:true,reportId,uploaded,counted,consumed,status:'Syncing'});
      }
      for(const row of draft.materials)if(row.remaining!==''&&row.remaining!==undefined&&!counted.includes(Number(row.materialId))){
        await post('/materials/site-counts',{projectId,materialId:Number(row.materialId),countedQuantity:Number(row.remaining),
          clientRef:`site-today-${projectId}-${date}-${row.materialId}`});
        counted.push(Number(row.materialId));setDraft(current=>({...current,counted:[...counted],reportId,status:'Syncing'}));
        await saveDraft(key,{...draft,attendanceSent:true,reportId,uploaded,counted,consumed,status:'Syncing'});
      }
      await removeDraft(key);setDraft({...draft,attendanceSent:true,reportId,uploaded,counted,consumed,status:'Synced'});
      setMessage('Site report sent. Attendance is pending HR review.');await reload();
    }catch(error){setMessage(`Still saved on this device. ${error.message}`);}finally{setBusy(false);}
  };
  useEffect(()=>{if(ready&&online&&draft.status==='Queued'&&!busy&&completeness(draft)>=4)sync();},[ready,online,draft.status,busy]);
  const count=completeness(draft);
  if(!data.projects.length)return <section className="site-today"><h1>Site Today</h1><p>No active project is available to report.</p></section>;
  return <section className="site-today">
    <header className="site-today-head"><div><small>FIELD WORKSPACE</small><h1>Site Today</h1><p>{online?'Online · drafts recover automatically':'Offline · saved on this device'}</p></div><strong>{count} of 5 complete</strong></header>
    {!online&&<p className="site-today-offline"><CloudOff size={19}/>You can keep recording. Sync when connected.</p>}
    {draft.status==='Synced'&&<p className="site-today-message">A site report already exists for this day. Open Daily reports to review it; this form will not create a duplicate.</p>}
    <div className="site-today-fields"><label>Project<select value={projectId} onChange={event=>setProjectId(Number(event.target.value))}>{data.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Work date<input type="date" value={date} onChange={event=>setDate(event.target.value)}/></label></div>
    {previous?.previous&&<p className="site-today-hint">Starting from {previous.previous.reportDate||yesterday(date)}: workforce and material quantities are editable.</p>}
    <div className="site-today-card"><h2><Users size={22}/>Workforce & attendance</h2><p>Tap people who attended. HR will review before this affects payroll.</p><div className="site-today-stepper"><button type="button" onClick={()=>update('workforce',Math.max(0,Number(draft.workforce||0)-1))}>−</button><input aria-label="Workforce count" type="number" min="0" value={draft.workforce} onChange={event=>update('workforce',event.target.value)}/><button type="button" onClick={()=>update('workforce',Number(draft.workforce||0)+1)}>+</button></div><div className="site-today-roster">{data.employees.filter(person=>person.status==='Active'||person.status==='On leave').map(person=><button type="button" key={person.id} className={draft.attendance.some(row=>Number(row.employeeId)===Number(person.id))?'selected':''} onClick={()=>toggleAttendance(person.id)}>{person.name}</button>)}</div><small>{draft.attendance.length} selected for HR review</small></div>
    <div className="site-today-card"><h2>Materials used</h2><p>Yesterday’s quantities are suggestions. Confirm usage and enter remaining site stock when counted.</p>{draft.materials.map((row,index)=><div className="site-today-material" key={`${row.materialId}-${index}`}><span>{row.name||data.materials.find(item=>Number(item.id)===Number(row.materialId))?.name||'Material'}</span><label>Used<input aria-label={`${row.name||'Material'} quantity used`} type="number" min="0" step="any" value={row.quantity} onChange={event=>update('materials',draft.materials.map((item,position)=>position===index?{...item,quantity:event.target.value}:item))}/></label><label>Remaining<input aria-label={`${row.name||'Material'} remaining stock`} type="number" min="0" step="any" value={row.remaining??''} onChange={event=>update('materials',draft.materials.map((item,position)=>position===index?{...item,remaining:event.target.value}:item))}/></label><small>{row.unit}</small><button type="button" onClick={()=>update('materials',draft.materials.filter((_,position)=>position!==index))}>Remove</button></div>)}<select aria-label="Add material" value="" onChange={event=>{const material=data.materials.find(item=>Number(item.id)===Number(event.target.value));if(material&&!draft.materials.some(row=>Number(row.materialId)===material.id))update('materials',[...draft.materials,{materialId:material.id,name:material.name,unit:material.unit,quantity:0,remaining:''}]);}}><option value="">+ Add material</option>{data.materials.map(material=><option key={material.id} value={material.id}>{material.name}</option>)}</select></div>
    <div className="site-today-card"><h2>Progress and issues</h2><textarea value={draft.work} onChange={event=>update('work',event.target.value)} placeholder="What was completed today?"/><button type="button" className="site-today-secondary" onClick={speak}><Mic size={19}/>Dictate note</button><textarea value={draft.issue} onChange={event=>update('issue',event.target.value)} placeholder="Delays or issues (optional)"/></div>
    <div className="site-today-card"><h2>Progress photos</h2><label className="site-today-photo"><Camera size={22}/>Take or choose photos<input type="file" accept="image/*" capture="environment" multiple onChange={addPhoto}/></label><p>{draft.photos.length} photo{draft.photos.length===1?'':'s'} saved for this report</p></div>
    {message&&<p className="site-today-message" role="status">{message}</p>}
    <footer className="site-today-actions"><button type="button" onClick={()=>saveDraft(key,draft).then(()=>setMessage('Draft saved on this device.'))}><Save size={19}/>Save draft</button><button type="button" disabled={busy||count<4||Boolean(draft.reportId&&draft.status==='Synced')} onClick={sync}><RefreshCw size={19}/>{busy?'Syncing…':online?'Submit and sync':'Save for later sync'}</button></footer>
  </section>;
}
