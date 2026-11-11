import React, {useEffect, useState} from 'react';
import {api, fetchDownload, post, rupeesExact, shortDate, todayInput} from '../api.js';
import {Field, FormModal, Modal, SelectField, TextArea, useLiveList} from '../ui.jsx';
import './FuelSubmissions.css';

export default function FuelSubmissions({can, companyId, user, reload}) {
  const [rows, setRows] = useState([]);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [photo, setPhoto] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
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

  return <section className="panel fuel-submissions">
    <header><h2>Fuel submissions</h2>
      {maySubmit && <button type="button" className="primary" disabled={!options?.vehicles.length}
        onClick={() => { setPhotoFile(null); setForm({clientRef:crypto.randomUUID()}); }}>Submit fuel entry</button>}
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!rows.length && <p>No fuel submissions for this company.</p>}
    {rows.map(row => <article key={row.id} className="fuel-submission-row">
      <div><strong>{row.vehicle} · {row.registration}</strong>
        <p>{shortDate(row.fuelDate)} · {row.litres} L · {rupeesExact(row.cost)}</p>
        <small>{row.project || 'No project'} · Submitted by {row.submittedBy}{row.vendor && ` · ${row.vendor}`}</small>
        {row.reviewedBy && <p>{row.status} by {row.reviewedBy}{row.reviewNote && ` · ${row.reviewNote}`}</p>}
        {row.fuelRecordId && <small>Fleet fuel record #{row.fuelRecordId}</small>}
      </div>
      <div className="row-actions"><strong>{row.status}</strong>
        {!!row.hasPhoto && <button type="button" className="secondary" onClick={async () => {
          try { setPhoto(await fetchDownload(`/fuel-submissions/${row.id}/photo`)); }
          catch (e) { setError(e.message); }
        }}>View photo</button>}
        {mayReview && Number(row.submittedById)!==Number(user?.id) && row.status==='Pending' && <>
          <button type="button" className="secondary" onClick={() => setForm({row,decision:'Approved'})}>Approve</button>
          <button type="button" className="secondary" onClick={() => setForm({row,decision:'Rejected'})}>Reject</button>
        </>}
      </div>
    </article>)}
    {photo && <Modal title="Fuel photo" close={() => setPhoto('')}>
      <div className="fuel-photo-view">
        <img src={photo} alt="Photo attached to fuel submission" />
        <a href={photo} download>Download photo</a>
      </div>
    </Modal>}
    {form?.clientRef && <FormModal title="Submit fuel entry" label="Send for approval" close={() => setForm(null)}
      onSubmit={async values => {
        const details = {clientRef:form.clientRef,companyId:Number(companyId),vehicleId:Number(values.vehicleId),
          projectId:Number(values.projectId)||null,fuelDate:values.fuelDate,litres:Number(values.litres),
          cost:Number(values.cost),odometer:values.odometer?Number(values.odometer):undefined,vendor:values.vendor};
        if (photoFile?.size) {
          const body = new FormData();
          body.append('details',JSON.stringify(details)); body.append('file',photoFile);
          await api('/fuel-submissions',{method:'POST',body});
        } else await post('/fuel-submissions',details);
        await load();
      }}>
      <SelectField name="vehicleId" label="Vehicle" options={[[ '', 'Choose vehicle…'], ...options.vehicles.map(v=>[v.id,`${v.vehicle} · ${v.registration}`])]} />
      <Field name="fuelDate" label="Fuel date" type="date" defaultValue={todayInput()} />
      <Field name="litres" label="Litres" type="number" min=".01" max="2000" step=".01" />
      <Field name="cost" label="Amount (LKR)" type="number" min=".01" step=".01" />
      <Field name="odometer" label="Odometer (km)" type="number" min="1" step="1" required={false} />
      <Field name="vendor" label="Fuel station" required={false} />
      <SelectField name="projectId" label="Project (optional)" required={false} options={[[ '', 'No project'], ...options.projects.map(p=>[p.id,p.name])]} />
      <fieldset className="wide fuel-photo-options">
        <legend>Fuel photo (optional)</legend>
        <label>Take a photo<input type="file" accept="image/*" capture="environment"
          onChange={event => setPhotoFile(event.target.files[0] || null)} /></label>
        <label>Choose a photo<input type="file" accept="image/*"
          onChange={event => setPhotoFile(event.target.files[0] || null)} /></label>
        {photoFile && <div className="row-actions"><small>{photoFile.name}</small>
          <button type="button" className="secondary" onClick={event => {
            for (const input of event.currentTarget.closest('fieldset').querySelectorAll('input')) input.value = '';
            setPhotoFile(null);
          }}>Remove photo</button></div>}
      </fieldset>
    </FormModal>}
    {form?.row && <FormModal title={form.decision==='Approved'?'Approve fuel entry':'Reject fuel entry'}
      label={form.decision==='Approved'?'Approve and record fuel':'Reject submission'} close={() => setForm(null)}
      onSubmit={async values => {
        await post(`/fuel-submissions/${form.row.id}/review`,{decision:form.decision,note:values.note,
          odometer:values.odometer?Number(values.odometer):undefined,fuelFloatId:values.fuelFloatId?Number(values.fuelFloatId):undefined});
        await load();
        if (form.decision==='Approved') await reload?.().catch(() => {});
      }}>
      <p className="wide">{form.row.vehicle} · {form.row.litres} L · {rupeesExact(form.row.cost)}</p>
      {form.decision==='Approved' && <>
        <Field name="odometer" label="Actual odometer (km)" type="number" min="1" step="1" defaultValue={form.row.odometer} />
        <SelectField name="fuelFloatId" label="Fuel float (if used)" required={false} options={[[ '', 'No petty cash float'], ...(options?.floats||[]).map(f=>[f.id,f.name])]} />
      </>}
      <TextArea name="note" label={form.decision==='Rejected'?'Rejection reason':'Review note'} required={form.decision==='Rejected'} />
    </FormModal>}
  </section>;
}
