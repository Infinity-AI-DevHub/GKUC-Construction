import React,{useState,useEffect,useRef} from 'react';
import {api,post,patch,todayInput,rupees} from '../api.js';
import {Table,Row,FormModal,WorkflowForm,Field,TextArea,SelectField,Modal} from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import {filterPayrollInput,calculationLabels} from '../payroll-input-display.js';
const inputTypes=['Travel','Mileage','Special duty','Machine/operator','Supervisor site charge','Salary deduction'];
export default function PayrollInputs({data}){
  const [travelMethod,setTravelMethod]=useState('Calculated');
  const [employeeMode,setEmployeeMode]=useState('Single');
  const [selectedEmployees,setSelectedEmployees]=useState([]);
  const [savingClaim,setSavingClaim]=useState(false);
  const [records,setRecords]=useState({claims:[],suggestions:[],issues:[]}),[error,setError]=useState(''),[form,setForm]=useState(null),[kind,setKind]=useState('Travel'),[preview,setPreview]=useState(null),[evidence,setEvidence]=useState(null),[filter,setFilter]=useState({employee:'',project:'',date:'',type:'',status:''});
  const openedFromLink=useRef(false);
  const load=()=>api('/payroll/inputs').then(result=>{
    setRecords(result);
    const id=Number(new URLSearchParams(window.location.search).get('record'));
    const claim=result.claims.find(row=>Number(row.id)===id);
    if(!openedFromLink.current&&id&&claim&&['Draft','Confirmed'].includes(claim.status)){
      openedFromLink.current=true;
      setForm({type:'review',...claim});
    }
  }).catch(e=>setError(e.message));useEffect(()=>{load();},[]);
  const matches=row=>filterPayrollInput(row,filter);
  return <>
    <div className="panel-title payroll-input-heading"><h2>Payroll Inputs · HR review</h2><div className="payroll-input-actions">
      <button type="button" className="primary" onClick={()=>{setPreview(null);setForm({type:'claim'});}}>Add travel / allowance claim</button>
      <button type="button" className="secondary" onClick={()=>{setPreview(null);setForm({type:'deduction'});}}>Add salary deduction</button>
    </div></div>
    <p className="form-note">Attendance suggests Office/Site OT only. Travel needs its own claim. HR may record one supervisor site charge per employee and day for a site visit, labour mobilization, or both. Claims require Review and confirm, then final approval. These are payroll inputs, not a second project expense.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="report-form">{['employee','project','type','status'].map(key=><label key={key}>{key}<select value={filter[key]} onChange={e=>setFilter({...filter,[key]:e.target.value})}><option value="">All</option>{(key==='employee'?data.employees.map(e=>[e.id,e.name]):key==='project'?data.projects.map(p=>[p.id,p.name]):(key==='type'?inputTypes:['Draft','Confirmed','Approved','Rejected']).map(v=>[v,v])).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}<label>Work date<input type="date" value={filter.date} onChange={e=>setFilter({...filter,date:e.target.value})}/></label></div>
    <Table title="Attendance & OT suggestions" columns={['Employee / date','Attendance','Calculation','Review']} template="200px 200px minmax(220px,1fr) 180px">{records.suggestions.filter(matches).map(row=><Row key={row.id} template="200px 200px minmax(220px,1fr) 180px"><span>{row.employee}<small>{row.work_date} · {row.project||'Office'}</small></span><span>{row.state}<small>{row.check_in||'Missing in'} – {row.check_out||'Missing out'} · {row.source}</small></span><span>{row.suggestion.hours} hours suggested<small>{row.suggestion.warnings.join(' ')}</small></span><div><button className="secondary" onClick={()=>setEvidence({type:'attendance',id:row.id})}>Evidence</button>{row.suggestion.hours>0&&!row.existing.length&&<button className="secondary" onClick={()=>setForm({type:'ot',...row})}>Review suggestion</button>}</div></Row>)}</Table>
    <Table title="Claims and one-time salary deductions" columns={['Employee / date','Type','Calculated values','Status','Review']} template="200px 150px minmax(220px,1fr) 110px 160px">{records.claims.filter(matches).map(row=><Row key={row.id} template="200px 150px minmax(220px,1fr) 110px 160px"><span>{row.employee}<small>{row.work_date} · {row.project||'Office'}</small></span><span>{row.kind}</span><span>{row.kind==='Travel'?`${row.calculation.travelHours}h travel OT · ${rupees(row.calculation.allowance)} allowance`:rupees(row.calculation.total??row.calculation.amount)}<small>{row.detail.source} · {row.detail.notes}</small></span><span>{row.status}</span><div><button className="secondary" onClick={()=>setEvidence({type:'claim',id:row.id})}>Evidence</button>{['Draft','Confirmed'].includes(row.status)&&<button className="secondary" onClick={()=>setForm({type:'review',...row})}>Review</button>}</div></Row>)}</Table>
    <Table title="Exceptions requiring HR review" columns={['Employee','Date','Issue']} template="180px 120px minmax(240px,1fr)" empty="No additional exceptions detected.">{(records.issues||[]).filter(matches).map((row,index)=><Row key={index} template="180px 120px minmax(240px,1fr)"><span>{data.employees.find(e=>e.id===row.employee_id)?.name||row.employee_id}</span><span>{row.work_date}</span><span>{row.kind}</span></Row>)}</Table>
    {form?.type==='ot'&&<FormModal title="Review attendance OT suggestion" close={()=>setForm(null)} label="Confirm pending OT" onSubmit={async v=>{await post(`/payroll/inputs/suggestions/${form.id}`,{hours:Number(v.hours),reason:v.reason});await load();}}><p className="form-note wide">{form.check_in} – {form.check_out}: {form.suggestion.rawHours} raw hours, {form.suggestion.hours} rounded hours. Final approval is in Overtime.</p><Field name="hours" label="Reviewed hours" type="number" step="0.01" min="0.01" defaultValue={form.suggestion.hours}/><TextArea name="reason" label="Review / correction reason"/></FormModal>}
    {form?.type==='review'&&<FormModal title="Review claim" label="Save review" close={()=>setForm(null)} onSubmit={async v=>{await patch(`/payroll/inputs/${form.id}/review`,v);await load();}}><SelectField name="status" label="Decision" options={form.status==='Draft'?['Confirmed','Rejected']:['Approved','Rejected']}/><TextArea name="reason" label="Review notes"/></FormModal>}
    {form?.type==='deduction'&&<FormModal title="Add one-time salary deduction" label="Save deduction draft" close={()=>setForm(null)} onSubmit={async values=>{
      await post('/payroll/inputs',{kind:'Salary deduction',employeeId:Number(values.employeeId),workDate:values.workDate,
        amount:Number(values.amount),notes:values.notes,source:values.source});await load();
    }}>
      <SelectField name="employeeId" label="Employee" options={data.employees.map(employee=>[employee.id,employee.name])}/>
      <Field name="workDate" label="Deduction date" type="date" defaultValue={todayInput()}/>
      <Field name="amount" label="Deduction amount (LKR)" type="number" min="0.01" max="999999999.99" step="0.01"/>
      <SelectField name="source" label="Supporting source" options={['Management instruction','Signed agreement','Other']}/>
      <TextArea name="notes" label="Reason" minLength={3} maxLength={2000}/>
      <p className="form-note wide">Requires confirmation and approval. Applies once to payroll covering this date. Recalculate an existing draft to include it. Only one salary deduction record per employee and date is allowed; combine same-day deductions into one amount and reason.</p>
    </FormModal>}
    {form?.type==='claim'&&<WorkflowForm title="Create HR payroll claim" label="Calculate and preview" close={()=>setForm(null)} summary={[["Claim type",kind],["Status after saving",'Draft — HR approval required']]} onSubmit={async v=>{
      const body={employeeId:Number(v.employeeId),projectId:v.projectId?Number(v.projectId):null,workDate:v.workDate,kind,source:v.source,notes:v.notes,...(kind==='Travel'?(travelMethod==='Manual'?{calculationMethod:'Manual',amount:Number(v.amount)}:{calculationMethod:'Calculated',departure:v.departure,arrival:v.arrival,hours:Number(v.hours),distance:Number(v.distance),distanceType:v.distanceType,foodSupplied:v.foodSupplied==='true'}):kind==='Mileage'?{...(v.approvedKm?{approvedKm:Number(v.approvedKm)}:{startOdometer:Number(v.startOdometer),endOdometer:Number(v.endOdometer)}),fixedTravel:v.fixedTravel==='true'}:kind==='Supervisor site charge'?{siteChargeReason:v.siteChargeReason}:{amount:Number(v.amount)})};
      if(employeeMode==='Multiple'&&selectedEmployees.length<2)throw new Error('Select at least two employees.');
      if(employeeMode==='Multiple')delete body.employeeId;
      const endpoint=employeeMode==='Multiple'?'/payroll/inputs/batch':'/payroll/inputs';
      const payload=employeeMode==='Multiple'?{employeeIds:selectedEmployees,claim:body}:body;
      const result=await post(endpoint,employeeMode==='Multiple'?{...payload,claim:{...body,preview:true}}:{...body,preview:true});
      setPreview({body:payload,result,endpoint});
    }}>
      <div className="qs-form-section wide"><span>01</span><div><h3>Person and work</h3><p>Connect this claim to the employee and work date.</p></div></div>
      <label>Input type<select value={kind} onChange={e=>setKind(e.target.value)}>{['Travel','Mileage','Special duty','Machine/operator','Supervisor site charge'].map(k=><option key={k}>{k}</option>)}</select></label>
      <label>Apply allowance to<select value={employeeMode} onChange={event=>{setEmployeeMode(event.target.value);setSelectedEmployees([]);setPreview(null);}}><option value="Single">One employee</option><option value="Multiple">Multiple employees</option></select></label>
      {employeeMode==='Multiple'&&<fieldset className="wide payroll-claim-employees"><legend>Employees ({selectedEmployees.length} selected)</legend>
        {data.employees.map(employee=><label key={employee.id}><input type="checkbox" checked={selectedEmployees.includes(Number(employee.id))}
          onChange={event=>{setPreview(null);setSelectedEmployees(ids=>event.target.checked?[...ids,Number(employee.id)]:ids.filter(id=>id!==Number(employee.id)));}}/>{employee.name}</label>)}
      </fieldset>}
      {kind==='Travel'&&<label>Allowance calculation<select value={travelMethod} onChange={event=>{setTravelMethod(event.target.value);setPreview(null);}}><option value="Calculated">Calculate from payroll rules</option><option value="Manual">Enter amount manually</option></select></label>}
      <div className="qs-form-section wide"><span>02</span><div><h3>Claim calculation</h3><p>Record the hours, distance or approved allowance.</p></div></div>
      {employeeMode==='Single'&&<SelectField name="employeeId" label="Employee" options={data.employees.map(e=>[e.id,e.name])}/>}
      <Field name="workDate" label="Work date" type="date" defaultValue={todayInput()}/><SelectField name="projectId" label="Project / destination" required={kind==='Supervisor site charge'||kind==='Travel'&&travelMethod==='Calculated'} options={[["","Office destination"],...data.projects.map(p=>[p.id,p.name])]}/>
      {kind==='Travel'&&travelMethod==='Manual'&&<Field name="amount" label={employeeMode==='Multiple'?'Travel allowance per employee (LKR)':'Travel allowance amount (LKR)'} type="number" min="0.01" max="999999999.99" step="0.01"/>}
      {kind==='Travel'&&travelMethod==='Calculated'&&<><Field name="departure" label="Departure time" type="time"/><Field name="arrival" label="Arrival / return time" type="time"/><Field name="hours" label="Travel OT hours (not Site OT)" type="number" min="0" max="24" step="0.01"/><Field name="distance" label="Distance (km)" type="number" min="0"/><SelectField name="distanceType" label="Distance recorded as" options={['One way','Return']}/><SelectField name="foodSupplied" label="Food supplied" options={[[false,'No'],[true,'Yes']]}/></>}
      {kind==='Mileage'&&<><Field name="startOdometer" label="Start odometer" type="number" min="0" required={false}/><Field name="endOdometer" label="End odometer" type="number" min="0" required={false}/><Field name="approvedKm" label="Approved kilometres (instead of odometer)" type="number" min="0" step="0.01" required={false}/><SelectField name="fixedTravel" label="Fixed office-travel payment" options={[[false,'No'],[true,'Yes']]}/></>}
      {kind==='Supervisor site charge'&&<><SelectField name="siteChargeReason" label="Why this charge applies" options={['Site visit','Labour mobilization','Both']}/><p className="form-note wide">Only a Supervisor with a project is eligible. HR decides whether to submit the claim. One charge applies per supervisor per day, even when both reasons apply. The effective payroll policy sets the amount; it remains pending until HR confirms and approves it.</p></>}
      {['Special duty','Machine/operator'].includes(kind)&&<Field name="amount" label={employeeMode==='Multiple'?'Allowance per employee (LKR)':'Separate allowance (LKR) — does not change basic rate'} type="number" min="0" step="0.01"/>}
      <div className="qs-form-section wide"><span>03</span><div><h3>Evidence</h3><p>State where HR obtained and checked the information.</p></div></div>
      <SelectField name="source" label="Supporting source" options={['Attendance sheet','WhatsApp','Signed timesheet','Management instruction','Other']}/><TextArea name="notes" label={kind==='Travel'&&travelMethod==='Manual'?'Reason for manual amount':'Source reference / notes'} required={kind==='Travel'&&travelMethod==='Manual'} minLength={kind==='Travel'&&travelMethod==='Manual'?3:undefined}/>
    </WorkflowForm>}
    {preview&&<Modal title="Calculated claim preview" close={()=>{if(!savingClaim)setPreview(null);}}>
      {(preview.result.results||[preview.result]).map((result,index)=><section key={result.employeeId||index}>
        {result.employee&&<h3>{result.employee}</h3>}
        <dl>{calculationLabels(result.calculation).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>)}
      <p>Amounts shown apply to each employee separately. Claims are saved as Draft and require HR confirmation and approval.</p>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="primary" disabled={savingClaim} onClick={async()=>{setSavingClaim(true);try{await post(preview.endpoint,preview.body);setPreview(null);setForm(null);setSelectedEmployees([]);await load();}catch(e){setError(e.message);}finally{setSavingClaim(false);}}}>{savingClaim?'Saving…':'Save draft claim'}</button>
    </Modal>}
    {evidence&&<Modal title="Supporting evidence" close={()=>setEvidence(null)}><Attachments ownerType={evidence.type} ownerId={evidence.id} canUpload canDelete={false}/></Modal>}
  </>;
}
