import React,{useEffect,useState} from 'react';
import {api,post,todayInput,rupees,shortDate} from '../api.js';
import {Table,Row,FormModal,Field,SelectField,TextArea} from '../ui.jsx';

export default function SpecialDailyPay({data,companyId}){
  const [records,setRecords]=useState({profiles:[],days:[]}),[error,setError]=useState(''),[form,setForm]=useState(null);
  const load=()=>api(`/payroll/special-pay?companyId=${companyId}`).then(setRecords).catch(failure=>setError(failure.message));
  useEffect(()=>{setRecords({profiles:[],days:[]});setForm(null);setError('');let live=true;
    api(`/payroll/special-pay?companyId=${companyId}`).then(value=>{if(live)setRecords(value);}).catch(failure=>{if(live)setError(failure.message);});
    return()=>{live=false;};},[companyId]);
  const employees=data.employees.filter(row=>Number(row.payrollCompanyId||1)===Number(companyId));
  const rule=(id,date)=>records.profiles.filter(row=>Number(row.employee_id)===Number(id)&&row.effective_from<=date)
    .sort((a,b)=>b.effective_from.localeCompare(a.effective_from)||b.id-a.id)[0];
  const openDay=row=>setForm({type:'day',row,employeeId:row?.employee_id||'',date:row?.work_date||todayInput()});
  const mode=form?.type==='day'?rule(form.employeeId,form.date)?.mode:null;
  const kind=form?.kind||form?.row?.work_kind||(mode==='Machine operator'?'Machine':'Bass');
  const template='minmax(150px,1fr) 120px 140px minmax(190px,1.5fr) 110px';
  return <section className="panel" style={{marginBottom:24}}>
    <div className="panel-title"><h2>Special daily pay · HR entry</h2><div className="payroll-input-actions">
      <button type="button" className="secondary" onClick={()=>setForm({type:'rule'})}>Set employee pay method</button>
      <button type="button" className="primary" onClick={()=>openDay(null)}>Record daily work / meter</button>
    </div></div>
    <p className="form-note">Select the correct employee and save a dated rule first. HR records one work type per day; no supervisor approval is required. Machine operator days with saved Machine meter records can be paid without attendance. Standby and Bass/Gola still require attendance. No attendance and no Machine work means absent. Missing daily details block Draft payroll. Approved/Paid payroll keeps its saved figures.</p>
    <p className="form-note">Bass: {rupees(records.rates?.bass??3000)} / day; Gola: {rupees(records.rates?.gola??2500)} / day (8 hours). Operator: {rupees(records.rates?.meterHourly??650)} / meter hour, minimum {rupees(records.rates?.minimum??1800)}; standby {rupees(225)} / hour up to 8 hours; {rupees(300)} transport per worked day. Extra-day operator basic: {rupees(2700)}. Machine days: no OT. Standby days: normal labour Site OT from 30 minutes. No operator late deduction. Special methods currently exclude EPF; ETF keeps the existing profile setting.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <Table title="Effective employee pay methods" columns={['Employee','Effective from','Method','Reason','']} template={template} empty="No special pay methods configured. Normal payroll rules still apply.">
      {records.profiles.map(row=><Row key={row.id} template={template}><strong>{row.employee}</strong><span>{shortDate(row.effective_from)}</span><span>{row.mode}</span><span>{row.reason}</span><button className="secondary" onClick={()=>setForm({type:'rule',row})}>Edit</button></Row>)}
    </Table>
    <Table title="HR daily work / meter records" columns={['Employee','Date','Work type','Hours / readings','']} template={template} empty="No daily work records saved.">
      {records.days.map(row=><Row key={row.id} template={template}><strong>{row.employee}</strong><span>{shortDate(row.work_date)}</span><span>{row.work_kind}</span><span>{row.work_kind==='Machine'?`${row.start_meter} → ${row.end_meter} (${Number((row.end_meter-row.start_meter).toFixed(3))} h)`:row.work_kind==='Standby'?`${row.hours} hours`:'Hours from attendance'}</span><div><button className="secondary" onClick={()=>openDay(row)}>Edit</button><button className="secondary" onClick={()=>setForm({type:'archive',row})}>Archive</button></div></Row>)}
    </Table>
    {form?.type==='rule'&&<FormModal title="Set employee special pay method" close={()=>setForm(null)} label="Save effective rule" onSubmit={async values=>{
      await post('/payroll/special-pay/rules',{employeeId:Number(values.employeeId),date:values.date,mode:values.mode,reason:values.reason});await load();
    }}>
      <SelectField name="employeeId" label="Employee" options={form.row?employees.filter(row=>Number(row.id)===Number(form.row.employee_id)).map(row=>[row.id,`${row.name} — ${row.code}`]):[['','Choose employee…'],...employees.map(row=>[row.id,`${row.name} — ${row.code}`])]} defaultValue={form.row?.employee_id||''}/>
      <Field name="date" label="Effective from" type="date" defaultValue={form.row?.effective_from||'2026-01-01'}/>
      <SelectField name="mode" label="Pay method" options={['Work role','Machine operator','Standard']} defaultValue={form.row?.mode}/>
      <TextArea name="reason" label="HR reason / agreement reference" defaultValue={form.row?.reason||''}/>
      <p className="form-note wide">Work role = Bass/Gola selected per date. Machine operator = meter/standby entries. Standard restores normal payroll from this date. This does not identify anyone by name or change other staff. Regenerate a Draft explicitly to apply corrections.</p>
    </FormModal>}
    {form?.type==='day'&&<FormModal title="Record HR daily work / meter" close={()=>setForm(null)} label="Save daily record" onSubmit={async values=>{
      await post('/payroll/special-pay/days',{employeeId:Number(form.employeeId),date:form.date,kind,reason:values.reason,
        ...(kind==='Machine'?{startMeter:Number(values.startMeter),endMeter:Number(values.endMeter)}:kind==='Standby'?{hours:Number(values.hours)}:{})});await load();
    }}>
      <label>Employee *<select required disabled={Boolean(form.row)} value={form.employeeId} onChange={event=>setForm({...form,row:null,kind:null,employeeId:event.target.value})}><option value="">Choose employee…</option>{employees.map(row=><option key={row.id} value={row.id}>{row.name} — {row.code}</option>)}</select></label>
      <label>Work date *<input required disabled={Boolean(form.row)} type="date" value={form.date} onChange={event=>setForm({...form,kind:null,date:event.target.value})}/></label>
      <label>Work type *<select required value={kind} onChange={event=>setForm({...form,kind:event.target.value})}>{(mode==='Machine operator'?['Machine','Standby']:['Bass','Gola']).map(value=><option key={value}>{value}</option>)}</select></label>
      {(!mode||mode==='Standard')&&<p className="form-note wide">Save a special pay method effective on this date before saving daily work.</p>}
      {kind==='Machine'&&<><Field name="startMeter" label="Start hour meter" type="number" min="0" step="0.001" defaultValue={form.row?.start_meter??''}/><Field name="endMeter" label="End hour meter" type="number" min="0" step="0.001" defaultValue={form.row?.end_meter??''}/></>}
      {kind==='Standby'&&<Field name="hours" label="Hours attended without machine work" type="number" min="0.001" max="24" step="0.001" defaultValue={form.row?.hours??8}/>}
      <TextArea name="reason" label="HR source / correction reason" defaultValue={form.row?.reason||''}/>
      <p className="form-note wide">One type per day. Bass/Gola hours come from attendance. Standby pay is capped at eight hours; machine work uses the meter only. Standby Site OT uses saved attendance times and the effective labour rate, starting at 30 minutes; Machine days have no OT. Machine records provide payroll evidence without creating attendance. Standby still requires saved attendance; days without attendance or Machine work are absent.</p>
    </FormModal>}
    {form?.type==='archive'&&<FormModal title="Archive daily work record" close={()=>setForm(null)} label="Archive record" onSubmit={async values=>{await post(`/payroll/special-pay/days/${form.row.id}/archive`,{reason:values.reason});await load();}}>
      <p className="form-note wide">{form.row.employee} · {shortDate(form.row.work_date)}. History stays in the audit trail. Any attended day still needs a replacement daily record before payroll.</p><TextArea name="reason" label="Reason"/>
    </FormModal>}
  </section>;
}
