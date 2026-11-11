import React, {useEffect, useRef, useState} from 'react';
import {api, fetchDownload, post, rupeesExact, shortDate, todayInput} from '../api.js';
import {Field, FormModal, Modal, SelectField, TextArea, useLiveList} from '../ui.jsx';
import {readDraft, removeDraft, saveDraft} from '../site-today-store.js';
import './FuelSubmissions.css';

export default function FuelSubmissions({can, companyId, user, reload}) {
  const [rows, setRows] = useState([]);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [photo, setPhoto] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [review,setReview] = useState(null);
  const [reviewPhoto,setReviewPhoto] = useState('');
  const [photoError,setPhotoError] = useState('');
  const [draftStatus,setDraftStatus] = useState('');
  const [online,setOnline] = useState(navigator.onLine);
  const openedLink=useRef(false);
  const draftKey = row => 'fuel:'+user.id+':'+companyId+':'+(row?.id||'new');
  const start = async row => {
    setError('');setDraftStatus('');
    try {
      const draft=await readDraft(draftKey(row));
      setPhotoFile(draft?.photo||null);
      setForm({clientRef:draft?.clientRef||crypto.randomUUID(),replaces:row,values:draft?.values||row||{}});
      if (draft) setDraftStatus(draft.waiting?'Waiting to submit':'Draft saved on this device');
    } catch {
      setPhotoFile(null);
      setForm({clientRef:crypto.randomUUID(),replaces:row,values:row||{}});
    }
  };
  useEffect(()=>{
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener('online',update); window.addEventListener('offline',update);
    return ()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};
  },[]);
  useEffect(()=>{
    let active=true, url;
    setReviewPhoto('');setPhotoError('');
    if (review?.hasPhoto) fetchDownload('/fuel-submissions/'+review.id+'/photo').then(value=>{
      url=value;
      if(active) setReviewPhoto(value); else URL.revokeObjectURL(value);
    }).catch(failure=>{if(active) setPhotoError(failure.message);});
    return ()=>{active=false;if(url) URL.revokeObjectURL(url);};
  },[review?.id,review?.hasPhoto]);

  const maySubmit = can.has('fuel.submit');
  const mayReview = can.has('fuel.review');
  const load = () => api(`/fuel-submissions?companyId=${companyId}`).then(value => { setRows(value); setError(''); }).catch(e => setError(e.message));
  useLiveList(load);
  useEffect(() => {
    let active = true;
    setRows([]); setOptions(null); setForm(null); setError('');
    if (maySubmit || mayReview) api(`/fuel-submissions/options?companyId=${companyId}`)
      .then(value => { if (active) setOptions(value); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [companyId,maySubmit,mayReview]);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo); }, [photo]);
  useEffect(()=>{
    if (!options || openedLink.current) return;
    const params=new URLSearchParams(window.location.search);
    const row=rows.find(item=>Number(item.id)===Number(params.get('record')));
    if (maySubmit && params.get('new')==='1') { openedLink.current=true; start(); }
    else if (row) {
      openedLink.current=true;
      if (row.status==='Rejected' && !row.replacementId && maySubmit && Number(row.submittedById)===Number(user.id)) start(row);
      else setReview(row);
    }
  },[rows,options,maySubmit,user.id]);
  const saveFuelDraft = async (values,waiting=false) => {
    await saveDraft(draftKey(form.replaces),{values,photo:photoFile,clientRef:form.clientRef,waiting});
    setDraftStatus(waiting?'Waiting to submit · saved on this device. Try again when connected.':'Draft saved on this device');
  };

  return <section className="panel fuel-submissions">
    <header><h2>Fuel submissions</h2>
      {maySubmit && <button type="button" className="primary" disabled={!options?.vehicles.length}
        onClick={()=>start()}>Record fuel</button>}
    </header>
    {draftStatus==='Submitted for review' && <p role="status">{draftStatus}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!rows.length && <p>No fuel submissions for this company.</p>}
    {rows.map(row => <article key={row.id} className="fuel-submission-row">
      <div><strong>{row.vehicle} · {row.registration}</strong>
        <p>{shortDate(row.fuelDate)} · {row.litres} L · {rupeesExact(row.cost)}</p>
        <small>{row.project || 'No project'} · Submitted by {row.submittedBy}{row.vendor && ` · ${row.vendor}`}</small>
        {row.reviewedBy && <p>{row.status} by {row.reviewedBy}{row.reviewNote && ` · ${row.reviewNote}`}</p>}
        {row.status==='Pending' && <p>Reviewer: {row.assignedTo||'Fuel reviewers'} · Due {shortDate(row.reviewDue)}</p>}
        {row.replacementId && <p>Resubmitted as entry #{row.replacementId}</p>}
        {row.fuelRecordId && <small>Fleet fuel record #{row.fuelRecordId}</small>}
      </div>
      <div className="row-actions"><strong>{row.status}</strong>
        {!!row.hasPhoto && <button type="button" className="secondary" onClick={async () => {
          try { setPhoto(await fetchDownload(`/fuel-submissions/${row.id}/photo`)); }
          catch (e) { setError(e.message); }
        }}>View photo</button>}
        {mayReview && Number(row.submittedById)!==Number(user?.id) && row.status==='Pending' && <>
          <button type="button" className="secondary" onClick={()=>setReview(row)}>Review fuel entry</button>
        </>}
        {maySubmit && row.status==='Rejected' && !row.replacementId && Number(row.submittedById)===Number(user.id) &&
          <button type="button" className="secondary" onClick={()=>start(row)}>Fix and resubmit</button>}
      </div>
    </article>)}
    {photo && <Modal title="Fuel photo" close={() => setPhoto('')}>
      <div className="fuel-photo-view">
        <img src={photo} alt="Photo attached to fuel submission" />
        <a href={photo} download>Download photo</a>
      </div>
    </Modal>}
    {review && !form?.row && <Modal title={'Fuel entry · '+review.vehicle} close={()=>{setReview(null);setError('');}}>
      <div className="fuel-photo-view">
        <p>{review.registration} · {review.project||'No project'} · {shortDate(review.fuelDate)}</p>
        <p><strong>{review.litres} L · {rupeesExact(review.cost)}</strong> · Submitted by {review.submittedBy}</p>
        {review.odometer && <p>Submitted odometer: {review.odometer} km</p>}
        {review.previousDetails && <p>Previous submission: {review.previousDetails.litres} L · {rupeesExact(review.previousDetails.cost)}{review.previousDetails.odometer?' · '+review.previousDetails.odometer+' km':''}</p>}
        <p>{review.status==='Pending'?'Reviewer: '+(review.assignedTo||'Fuel reviewers')+' · Due '+shortDate(review.reviewDue):review.status}</p>
        {review.reviewNote && <p>{review.reviewNote}</p>}
        {reviewPhoto && <img src={reviewPhoto} alt="Fuel receipt photo" />}
        {review.hasPhoto && !reviewPhoto && <p role="status">{photoError||'Loading receipt photo…'}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        {mayReview && review.status==='Pending' && Number(review.submittedById)!==Number(user.id) && <div className="row-actions">
          {!review.assignedTo && <button type="button" className="secondary" onClick={async()=>{
            try {await post('/fuel-submissions/'+review.id+'/claim');setReview({...review,assignedTo:user.name});await load();}
            catch(failure){setError(failure.message);}
          }}>Take ownership</button>}
          <button type="button" className="secondary" onClick={()=>setForm({row:review,decision:'Rejected'})}>Return for correction</button>
          <button type="button" className="primary" onClick={()=>setForm({row:review,decision:'Approved'})}>Approve</button>
        </div>}
      </div>
    </Modal>}
    {form?.clientRef && <FormModal title={form.replaces?'Fix and resubmit fuel entry':'Record fuel'}
      label={online?'Send for approval':'Save for later submission'} close={() => setForm(null)}
      onSaveDraft={saveFuelDraft}
      onSubmit={async values => {
        if (!online) { await saveFuelDraft(values,true); return false; }
        const details = {clientRef:form.clientRef,replacesId:form.replaces?.id,companyId:Number(companyId),vehicleId:Number(values.vehicleId),
          projectId:Number(values.projectId)||null,fuelDate:values.fuelDate,litres:Number(values.litres),
          cost:Number(values.cost),odometer:values.odometer?Number(values.odometer):undefined,vendor:values.vendor};
        try {
          if (photoFile?.size) {
            const body = new FormData();
            body.append('details',JSON.stringify(details)); body.append('file',photoFile);
            await api('/fuel-submissions',{method:'POST',body});
          } else await post('/fuel-submissions',details);
        } catch (failure) {
          if (failure.status && failure.status<500) throw failure;
          await saveFuelDraft(values,true);
          return false;
        }
        setDraftStatus('Submitted for review');
        await removeDraft(draftKey(form.replaces)).catch(()=>{});
        await load();
      }}>
      {form.replaces?.reviewNote && <p className="wide">Correction requested: {form.replaces.reviewNote}</p>}
      {(draftStatus || !online) && <p className="wide" role="status">{draftStatus}{!online?' · Offline. Save and submit once connected.':''}</p>}
      <SelectField defaultValue={form.values.vehicleId} name="vehicleId" label="Vehicle" options={[[ '', 'Choose vehicle…'], ...options.vehicles.map(v=>[v.id,`${v.vehicle} · ${v.registration}`])]} />
      <Field name="fuelDate" label="Fuel date" type="date" defaultValue={form.values.fuelDate||todayInput()} />
      <Field name="litres" defaultValue={form.values.litres} label="Litres" type="number" min=".01" max="2000" step=".01" />
      <Field name="cost" defaultValue={form.values.cost} label="Amount (LKR)" type="number" min=".01" step=".01" />
      <Field name="odometer" defaultValue={form.values.odometer} label="Odometer (km)" type="number" min="1" step="1" required={false} />
      <Field name="vendor" defaultValue={form.values.vendor} label="Fuel station" required={false} />
      <SelectField name="projectId" defaultValue={form.values.projectId} label="Project (optional)" required={false} options={[[ '', 'No project'], ...options.projects.map(p=>[p.id,p.name])]} />
      <fieldset className="wide fuel-photo-options">
        <legend>Fuel photo (optional)</legend>
        <label>Take a photo<input type="file" accept="image/*" capture="environment"
          onChange={event => setPhotoFile(event.target.files[0] || null)} /></label>
        <label>Choose a photo<input type="file" accept="image/*"
          onChange={event => setPhotoFile(event.target.files[0] || null)} /></label>
        {form.replaces?.hasPhoto && !photoFile && <small>The original receipt will be kept.</small>}
        {photoFile && <div className="row-actions"><small>{photoFile.name}</small>
          <button type="button" className="secondary" onClick={event => {
            for (const input of event.currentTarget.closest('fieldset').querySelectorAll('input')) input.value = '';
            setPhotoFile(null);
          }}>Remove photo</button></div>}
      </fieldset>
    </FormModal>}
    {form?.row && <FormModal title={form.decision==='Approved'?'Approve fuel entry':'Return fuel entry'}
      label={form.decision==='Approved'?'Approve and record fuel':'Return for correction'} close={() => setForm(null)}
      onSubmit={async values => {
        await post(`/fuel-submissions/${form.row.id}/review`,{decision:form.decision,note:values.note,
          odometer:values.odometer?Number(values.odometer):undefined,fuelFloatId:values.fuelFloatId?Number(values.fuelFloatId):undefined});
        setReview(null);
        await load();
        if (form.decision==='Approved') await reload?.().catch(() => {});
      }}>
      <div className="wide fuel-photo-view">
        <p>{form.row.vehicle} · {form.row.project||'No project'} · {form.row.litres} L · {rupeesExact(form.row.cost)}</p>
        {form.row.previousDetails && <p>Previous submission: {form.row.previousDetails.litres} L · {rupeesExact(form.row.previousDetails.cost)}</p>}
        {reviewPhoto && <img src={reviewPhoto} alt="Fuel receipt photo" />}
        {form.row.hasPhoto && !reviewPhoto && <p>{photoError||'Loading receipt photo…'}</p>}
      </div>
      {form.decision==='Approved' && <>
        <Field name="odometer" label="Actual odometer (km)" type="number" min="1" step="1" defaultValue={form.row.odometer} />
        <SelectField name="fuelFloatId" label="Fuel float (if used)" required={false} options={[[ '', 'No petty cash float'], ...(options?.floats||[]).map(f=>[f.id,f.name])]} />
      </>}
      <TextArea name="note" label={form.decision==='Rejected'?'Correction reason':'Review note'} required={form.decision==='Rejected'} />
    </FormModal>}
  </section>;
}
