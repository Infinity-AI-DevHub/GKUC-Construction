import React,{useEffect,useRef,useState} from 'react';
import {Plus,Trash2,Download,PencilLine} from 'lucide-react';
import {api,post,patch,openDocument,rupees,todayInput} from '../api.js';
import {Field,SelectField,TextArea,FormModal,Modal,Table,Row,Badge,useLiveList} from '../ui.jsx';
import {ReceiptForm} from '../Receivables.jsx';

const blank=()=>({code:'1',description:'',unit:'item',quantity:1,rate:0});
export default function ProgressClaims({companyId,can}){
  const [data,setData]=useState({projects:[],schedules:[],claims:[]}),[projectId,setProjectId]=useState(''),[error,setError]=useState(''),[form,setForm]=useState(null);
  const request=useRef(0);
  const load=()=>{const current=++request.current;return api(`/progress-claims?companyId=${companyId}`).then(result=>{if(current===request.current){setData(result);setError('');}}).catch(failure=>{if(current===request.current)setError(failure.message);});};
  useEffect(()=>{setProjectId('');setForm(null);setData({projects:[],schedules:[],claims:[]});load();return()=>{request.current++;};},[companyId]);useLiveList(load);
  const allowed=key=>can.has(key);
  const schedules=data.schedules.filter(row=>Number(row.project_id)===Number(projectId));
  const latest=schedules[0];
  const claims=data.claims.filter(row=>Number(row.project_id)===Number(projectId));
  const previous=claims.find(row=>row.status==='Certified')?.certified_items||[];
  const project=data.projects.find(row=>Number(row.id)===Number(projectId));
  return <>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="progress-claim-toolbar">
      <label>Project<select aria-label="Progress claim project" value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">Choose project</option>{data.projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      {project&&<span>Billing route: {project.billingRoute}</span>}
      {projectId&&allowed('qs.boq')&&<button className="secondary" onClick={()=>setForm({type:'schedule',base:latest})}>{latest?'Revise valuation BOQ':'Create valuation BOQ'}</button>}
      {latest&&latest.status!=='Draft'&&allowed('qs.boq')&&<button className="primary" onClick={()=>setForm({type:'application'})}>New interim application</button>}
    </div>
    {projectId&&<>
      <Table title="Valuation BOQ versions" columns={['Version','Source','Contract','Approval','Reference','Actions']} template="90px 140px minmax(140px,1fr) 160px minmax(160px,1fr) 180px">
        {schedules.map(row=><Row key={row.id} template="90px 140px minmax(140px,1fr) 160px minmax(160px,1fr) 180px">
          <strong>v{row.version_no}</strong><span>{row.source}</span><span>{row.contract_reference||'Not supplied'}</span><Badge>{row.status}</Badge><span>{row.agreement_reference||row.internal_reference||'Not client agreed'}</span>
          <div className="progress-schedule-actions">{row.id===latest?.id&&allowed('qs.approve')&&row.status!=='Client agreed'&&<button className="secondary" onClick={()=>setForm({type:'approval',schedule:row})}>{row.status==='Draft'?'Approve internally':'Record client agreement'}</button>}
            {row.status==='Draft'&&allowed('qs.boq')&&<button className="icon-button" title="Edit draft valuation BOQ" aria-label="Edit draft valuation BOQ" onClick={()=>setForm({type:'schedule',base:row,editing:true})}><PencilLine size={16}/></button>}
            {row.id===latest?.id&&allowed('qs.boq')&&(row.status==='Draft'||allowed('qs.approve'))&&!claims.some(claim=>Number(claim.schedule_id)===Number(row.id))&&
              <button type="button" className="icon-button" title={`Delete valuation BOQ v${row.version_no}`} aria-label={`Delete valuation BOQ v${row.version_no}`} onClick={()=>setForm({type:'delete-schedule',schedule:row})}><Trash2 size={16}/></button>}
          </div>
        </Row>)}
      </Table>
      <Table title="Interim applications and certificates" columns={['Application / period','Claimed','Certified payable','Received','Outstanding','Status','']} template="minmax(210px,1fr) 135px 145px 135px 135px 110px 100px">
        {claims.map(row=><Row key={row.id} template="minmax(210px,1fr) 135px 145px 135px 135px 110px 100px">
          <span><strong>{row.reference}</strong><small>{row.period_from} to {row.period_to}</small></span><span>{rupees(row.submitted_amount)}</span>
          <span>{row.status==='Certified'?rupees(row.netPayable):'Not certified'}</span><span>{rupees(row.paidAmount||0)}</span><span>{rupees(Number(row.netPayable||0)-Number(row.paidAmount||0))}</span><Badge>{row.status}</Badge>
          <button className="secondary" onClick={()=>setForm({type:'detail',id:row.id})}>Open</button>
        </Row>)}
      </Table>
    </>}
    {form?.type==='schedule'&&<ScheduleForm projectId={Number(projectId)} base={form.base} editing={form.editing} companyId={companyId} close={()=>setForm(null)} reload={load}/>}
    {form?.type==='delete-schedule'&&<FormModal title={`Delete valuation BOQ v${form.schedule.version_no}?`} close={()=>setForm(null)} label="Delete valuation BOQ" onSubmit={async values=>{
      await api(`/progress-claims/schedules/${form.schedule.id}`,{method:'DELETE',body:JSON.stringify({reason:values.reason})});await load();
    }}><p className="wide">This removes the unused valuation BOQ. Its full details remain in the audit log. If it is the last version, this project returns to Quotation and invoice billing. No original BOQs, applications, invoices or payments will be deleted.</p>
      <TextArea name="reason" label="Deletion reason" minLength={3} maxLength={1000}/>
    </FormModal>}
    {form?.type==='approval'&&<FormModal title={form.schedule.status==='Draft'?'Internal BOQ approval':'Record client agreement'} close={()=>setForm(null)} label="Save approval" onSubmit={async values=>{
      await patch(`/progress-claims/schedules/${form.schedule.id}`,{status:form.schedule.status==='Draft'?'Internally approved':'Client agreed',reference:values.reference});await load();
    }}><TextArea name="reference" label="Approval / client agreement reference" minLength={3} maxLength={500}/></FormModal>}
    {form?.type==='application'&&latest&&<ApplicationForm schedule={latest} previous={previous} close={()=>setForm(null)} reload={load}/>}
    {form?.type==='detail'&&data.claims.find(row=>row.id===form.id)&&<ClaimDetail claim={data.claims.find(row=>row.id===form.id)} can={can} close={()=>setForm(null)} reload={load}/>}
  </>;
}

function ScheduleForm({projectId,base,editing,companyId,close,reload}){
  const [items,setItems]=useState(base?.items||[blank()]),[boqs,setBoqs]=useState([]),[error,setError]=useState('');
  useEffect(()=>{api(`/boq?companyId=${companyId}`).then(rows=>setBoqs(rows.filter(row=>Number(row.projectId)===projectId))).catch(failure=>setError(failure.message));},[companyId,projectId]);
  const change=(index,key,value)=>setItems(rows=>rows.map((row,i)=>i===index?{...row,[key]:value}:row));
  return <FormModal wide title={editing?'Edit draft valuation BOQ':base?'New valuation BOQ revision':'Create valuation BOQ'} label="Save valuation BOQ draft" close={close} onSubmit={async values=>{
    const body={projectId,source:values.source,contractReference:values.contractReference,revisionReason:values.revisionReason,
      items:items.map(row=>({...row,quantity:Number(row.quantity),rate:Number(row.rate)}))};
    if(editing)await api(`/progress-claims/schedules/${base.id}`,{method:'PUT',body:JSON.stringify(body)});
    else await post('/progress-claims/schedules',body);await reload();
  }}>
    {error&&<p className="form-error wide" role="alert">{error}</p>}
    <SelectField name="source" label="BOQ source" options={['QS prepared','Client supplied']} defaultValue={base?.source}/>
    <Field name="contractReference" label="Award / contract reference (optional)" required={false} maxLength={180} defaultValue={base?.contract_reference||''}/>
    <TextArea name="revisionReason" label="Preparation / revision reason" minLength={3} maxLength={1000} defaultValue={editing?base?.revision_reason:''}/>
    <label>Copy existing project BOQ<select defaultValue="" onChange={async event=>{if(!event.target.value)return;try{
      const boq=await api(`/boq/${event.target.value}`);setItems(boq.items.map((row,index)=>({code:String(index+1),description:row.description,unit:row.unit,quantity:row.quantity,rate:row.rate})));
    }catch(failure){setError(failure.message);}}}><option value="">Enter items manually</option>{boqs.map(row=><option value={row.id} key={row.id}>{row.reference} · {row.title}</option>)}</select></label>
    <div className="wide"><Table title="Valuation items" columns={['Code','Description','Unit','BOQ quantity','Rate (LKR)','']} template="90px minmax(220px,1fr) 90px 130px 130px 45px">
      {items.map((row,index)=><Row key={index} template="90px minmax(220px,1fr) 90px 130px 130px 45px">
        {['code','description','unit','quantity','rate'].map(key=><input key={key} aria-label={`${key} item ${index+1}`} required type={['quantity','rate'].includes(key)?'number':'text'}
          min={key==='quantity'?'0.001':'0'} step={key==='quantity'?'0.001':'0.01'} value={row[key]} onChange={event=>change(index,key,event.target.value)}/>)}
        <button type="button" className="icon-button" title="Remove item" aria-label={`Remove item ${index+1}`} disabled={items.length===1} onClick={()=>setItems(rows=>rows.filter((_,i)=>i!==index))}><Trash2 size={16}/></button>
      </Row>)}
    </Table><button type="button" className="secondary" onClick={()=>setItems(rows=>[...rows,{...blank(),code:String(rows.length+1)}])}><Plus size={16}/>Add item</button></div>
  </FormModal>;
}

function Quantities({items,defaults={},prefix='qty'}){
  return <div className="wide"><Table title="Cumulative completed quantities" columns={['Code / description','Unit','Rate','BOQ quantity','Cumulative quantity']} template="minmax(240px,1fr) 85px 120px 120px 160px">
    {items.map(row=><Row key={row.code} template="minmax(240px,1fr) 85px 120px 120px 160px"><span>{row.code} · {row.description}</span><span>{row.unit}</span><span>{rupees(row.rate)}</span><span>{row.boqQuantity??row.quantity}</span>
      <input aria-label={`Cumulative quantity ${row.code}`} name={`${prefix}:${row.code}`} type="number" min="0" max={row.boqQuantity??row.quantity} step="0.001" required defaultValue={defaults[row.code]??0}/>
    </Row>)}
  </Table></div>;
}
const entered=(items,values)=>Object.fromEntries(items.map(row=>[row.code,Number(values[`qty:${row.code}`])]));
function ApplicationForm({schedule,previous=[],claim=null,close,reload}){
  return <FormModal wide title={claim?'Edit application draft':'New interim payment application'} label={claim?'Save application changes':'Save application draft'} close={close} onSubmit={async values=>{
    const body={scheduleId:schedule.id,applicationDate:values.applicationDate,periodFrom:values.periodFrom,periodTo:values.periodTo,quantities:entered(schedule.items,values),notes:values.notes};
    if(claim)await api(`/progress-claims/${claim.id}`,{method:'PUT',body:JSON.stringify(body)});else await post('/progress-claims',body);await reload();
  }}>
    <Field name="applicationDate" label="Application date" type="date" defaultValue={claim?.application_date||todayInput()}/><Field name="periodFrom" label="Period from" type="date" defaultValue={claim?.period_from}/>
    <Field name="periodTo" label="Period to" type="date" defaultValue={claim?.period_to}/>
    <Quantities items={schedule.items} defaults={Object.fromEntries((claim?.submitted_items||previous).map(row=>[row.code,row.quantity]))}/>
    <TextArea name="notes" label="Application notes" required={false} maxLength={1000} defaultValue={claim?.notes||''}/>
  </FormModal>;
}

function ClaimDetail({claim,can,close,reload}){
  const [form,setForm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const permitted=key=>can.has(key);
  const action=async task=>{setBusy(true);setError('');try{await task();await reload();}catch(failure){setError(failure.message);}finally{setBusy(false);}};
  const doc=type=>openDocument(`/progress-claims/${claim.id}/document?type=${type}`);
  return <Modal wide title={`${claim.reference} · ${claim.status}`} close={close}>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <div className="progress-claim-toolbar">
      <button className="secondary" onClick={()=>doc('application')}><Download size={16}/>Application PDF</button>
      <button className="secondary" onClick={()=>doc('letter')}><Download size={16}/>Covering letter</button>
      {claim.status==='Draft'&&permitted('qs.boq')&&<button className="primary" onClick={()=>setForm('Submitted')}>Submit application</button>}
      {claim.status==='Draft'&&permitted('qs.boq')&&<button className="secondary" onClick={()=>setForm('edit')}>Edit draft</button>}
      {['Draft','Submitted'].includes(claim.status)&&permitted('qs.boq')&&<button className="secondary" onClick={()=>setForm('Withdrawn')}>Withdraw</button>}
      {claim.status==='Submitted'&&permitted('finance.invoice')&&<button className="primary" onClick={()=>setForm('certify')}>Record client certificate</button>}
      {claim.status==='Certified'&&<button className="secondary" onClick={()=>doc('certificate')}>Certificate PDF</button>}
      {claim.status==='Certified'&&!claim.invoice_reference&&permitted('finance.invoice')&&<button disabled={busy} className="secondary" onClick={()=>action(()=>post(`/progress-claims/${claim.id}/invoice`,{}))}>Issue optional invoice</button>}
      {claim.invoice_reference&&<button className="secondary" onClick={()=>doc('invoice')}>Invoice PDF · {claim.invoice_reference}</button>}
      {claim.status==='Certified'&&Number(claim.netPayable)>Number(claim.paidAmount)&&permitted('finance.invoice')&&<button className="primary" onClick={()=>setForm('receipt')}>Record payment</button>}
    </div>
    <p>Claimed work: {rupees(claim.submitted_amount)} · Certified payable: {rupees(claim.netPayable||0)} · Received: {rupees(claim.paidAmount||0)}</p>
    <Table title="Submitted and certified values" columns={['Item','Previous certified','This claimed','Cumulative claimed','This certified']} template="minmax(220px,1fr) 145px 145px 145px 145px">
      {claim.submitted_items.map(row=><Row key={row.code} template="minmax(220px,1fr) 145px 145px 145px 145px"><span>{row.code} · {row.description}</span><span>{rupees(row.previousAmount)}</span><span>{rupees(row.current)}</span><span>{rupees(row.cumulative)}</span><span>{claim.certified_items?rupees(claim.certified_items.find(item=>item.code===row.code)?.current):'Pending'}</span></Row>)}
    </Table>
    {['Submitted','Withdrawn'].includes(form)&&<FormModal title={form==='Submitted'?'Submit application':'Withdraw application'} label="Confirm" close={()=>setForm('')} onSubmit={async values=>{
      await patch(`/progress-claims/${claim.id}/status`,{status:form,reason:values.reason});setForm('');await reload();
    }}><TextArea name="reason" label="Submission / withdrawal reason" minLength={3}/></FormModal>}
    {form==='certify'&&<CertificationForm claim={claim} close={()=>setForm('')} reload={reload}/>}
    {form==='edit'&&<ApplicationForm claim={claim} schedule={claim.schedule_snapshot} close={()=>setForm('')} reload={reload}/>}
    {form==='receipt'&&<ReceiptForm invoice={{id:claim.invoice_id,reference:claim.receivableReference,outstanding:Number(claim.netPayable)-Number(claim.paidAmount)}} close={()=>setForm('')} reload={reload}/>}
  </Modal>;
}
function CertificationForm({claim,close,reload}){
  const [retention,setRetention]=useState(0);
  return <FormModal wide title="Record client-certified values" label="Save certificate and receivable" close={close} onSubmit={async values=>{
    await post(`/progress-claims/${claim.id}/certify`,{certificateReference:values.certificateReference,certifiedDate:values.certifiedDate,dueDate:values.dueDate,
      quantities:entered(claim.submitted_items,values),retention:Number(values.retention),retentionReleaseDate:values.retentionReleaseDate||undefined,
      advance:Number(values.advance),other:Number(values.other),stampDuty:Number(values.stampDuty),vatRate:Number(values.vatRate),taxBasis:values.taxBasis,reason:values.reason});await reload();
  }}>
    <Field name="certificateReference" label="Client certificate reference" maxLength={180}/><Field name="certifiedDate" label="Certified on" type="date" defaultValue={todayInput()}/>
    <Field name="dueDate" label="Payment due" type="date"/>
    <Quantities items={claim.submitted_items} defaults={Object.fromEntries(claim.submitted_items.map(row=>[row.code,row.quantity]))}/>
    <Field name="retention" label="Retention held (LKR)" type="number" min="0" step="0.01" defaultValue="0" onChange={event=>setRetention(Number(event.target.value))}/>
    <Field name="retentionReleaseDate" label="Retention release date" type="date" required={retention>0}/>
    <Field name="advance" label="Advance recovered (LKR)" type="number" min="0" step="0.01" defaultValue="0"/>
    <Field name="other" label="Other recoveries before VAT (LKR)" type="number" min="0" step="0.01" defaultValue="0"/>
    <Field name="stampDuty" label="Stamp duty after VAT (LKR)" type="number" min="0" step="0.01" defaultValue="0"/>
    <Field name="vatRate" label="Applicable VAT rate (%)" type="number" min="0" max="100" step="0.01" defaultValue="0"/>
    <SelectField name="taxBasis" label="VAT calculation basis" options={['Gross','After recoveries']}/>
    <TextArea name="reason" label="Certification and deduction basis / supporting reference" minLength={3} maxLength={1000}/>
  </FormModal>;
}
