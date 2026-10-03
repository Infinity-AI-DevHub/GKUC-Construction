import React, { useEffect, useState } from 'react';
import { api } from './api.js';

const labels = { clients: 'Clients', subcontractors: 'Subcontractors', projects: 'Projects', boqs: 'BOQs', quotations: 'Client quotations', costs: 'Cost controls', retentions: 'Retentions' };
const order = ['clients', 'subcontractors', 'projects', 'boqs', 'quotations', 'costs', 'retentions'];

export default function ImportCentre() {
  const [types, setTypes] = useState([]);
  const [batches, setBatches] = useState([]);
  const [kind, setKind] = useState('');
  const [file, setFile] = useState(null);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [context, setContext] = useState(null);
  const refresh = () => api('/import-centre/batches').then(setBatches);
  useEffect(() => {
    api('/import-centre/types').then(rows => { setTypes(rows); setKind(rows[0]?.kind || ''); }).catch(failure => setError(failure.message));
    refresh().catch(failure => setError(failure.message));
  }, []);
  const check = async event => {
    event.preventDefault(); setBusy(true); setError(''); setReview(null);
    try {
      const form = new FormData(); form.append('kind', kind); form.append('file', file);
      const next = await api('/import-centre/dry-check', { method: 'POST', body: form });
      setReview(next);
      if (next.mode === 'document-review' && !context) setContext(await api('/import-centre/review-context'));
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const open = async id => {
    setError('');
    try { const record = await api(`/import-centre/batches/${id}`); const next = { id: record.id, status: record.status, ...record.preview };
      setReview(next); if (next.mode === 'document-review' && !context) setContext(await api('/import-centre/review-context')); }
    catch (failure) { setError(failure.message); }
  };
  const confirm = async () => {
    if (!window.confirm(review.mode === 'document-review'
      ? 'Create this BOQ and any new client or project shown in the review? This action changes live records.'
      : `Create ${review.counts.create} ${labels[review.kind]?.toLowerCase()}? Existing records will be skipped. This action changes live records.`)) return;
    setBusy(true); setError('');
    try {
      if (review.mode === 'document-review') {
        const saved = await api(`/import-centre/batches/${review.id}/review`, { method: 'PATCH',
          body: JSON.stringify({ document: review.document, rows: review.rows }) });
        setReview(saved);
        if (saved.counts.blocked) throw new Error('Correct every highlighted BOQ line before importing.');
      }
      const result = await api(`/import-centre/batches/${review.id}/confirm`, { method: 'POST', body: '{}' });
      setReview(current => ({ ...current, status: result.status })); await refresh(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <div className="import-centre">
    <section className="table-panel" style={{ padding: 24 }}>
      <h2>Import historical records</h2>
      <p>Upload existing records and check what SiteOps extracted before anything is created. BOQs accept any readable Excel workbook or PDF; you can correct every line and link or create the client and project during review.</p>
      <form className="form-grid" onSubmit={check}>
        <div className="form-field"><label htmlFor="import-kind">Template</label><select id="import-kind" value={kind} onChange={event => { setKind(event.target.value); setReview(null); }}>
          {order.filter(id => types.some(type => type.kind === id)).map(id => <option key={id} value={id}>{labels[id]}</option>)}
        </select></div>
        <div className="form-field"><label htmlFor="import-file">{kind === 'boqs' ? 'Excel workbook or PDF' : 'Completed Excel workbook'}</label><input id="import-file" type="file" accept={kind === 'boqs' ? '.xlsx,.pdf' : '.xlsx'} required onChange={event => setFile(event.target.files?.[0] || null)} /></div>
        <div className="form-actions"><button className="primary" type="submit" disabled={!file || !kind || busy}>{busy ? 'Checking…' : 'Run dry check'}</button></div>
      </form>
      <p className="form-note">Uploading only creates a review. For BOQs, SiteOps detects unfamiliar layouts and scanned PDFs, then lets you verify dependencies and every priced line. Other bulk registers continue to use their controlled templates.</p>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {review?.mode === 'document-review' && <DocumentReview review={review} setReview={setReview} context={context}
      busy={busy} onConfirm={confirm} />}
    {review && review.mode !== 'document-review' && <section className="table-panel" style={{ padding: 24, marginTop: 20 }}>
      <div className="table-tools"><div><h2>{labels[review.kind]} · dry-check report</h2><p>Sheets found: {review.sheets?.join(', ')}</p></div></div>
      <div className="toolbar"><span><strong>{review.counts.create}</strong> to create</span><span><strong>{review.counts.skip}</strong> already imported</span><span><strong>{review.counts.blocked}</strong> need correction</span></div>
      {review.sourceTotal > 0 && <p>Workbook amount: LKR {Number(review.sourceTotal).toLocaleString('en-LK', { minimumFractionDigits: 2 })}. Check this against the original Excel totals before confirming.</p>}
      <div className="import-review-scroll"><table className="import-review-table"><thead><tr><th>Sheet</th><th>Row</th><th>Migration code</th><th>Decision</th><th>What needs attention</th></tr></thead><tbody>
        {review.rows.map(row => <tr key={`${row.sheet}-${row.row}`}><td>{row.sheet}</td><td>{row.row}</td><td>{row.code || 'Missing'}</td><td>{row.action}</td><td>{row.errors.length ? row.errors.join(' ') : row.action === 'skip' ? 'Already imported. Will not be added again.' : 'Ready to create.'}</td></tr>)}
      </tbody></table></div>
      {review.status === 'Imported' ? <p className="form-note">Imported. Keep this report and reconcile the register against the source workbook before retiring the Excel file.</p>
        : review.counts.blocked === 0 && review.counts.create > 0 && types.find(type => type.kind === review.kind)?.importReady && <button className="primary" onClick={confirm} disabled={busy}>Confirm and create records</button>}
    </section>}
    <section className="table-panel" style={{ padding: 24, marginTop: 20 }}><h2>Import history</h2>
      {batches.length ? <div className="import-review-scroll"><table className="import-review-table"><thead><tr><th>Checked</th><th>Template</th><th>Workbook</th><th>Created / skipped / blocked</th><th>Status</th><th></th></tr></thead><tbody>
        {batches.map(batch => <tr key={batch.id}><td>{new Date(batch.createdAt).toLocaleString('en-GB')}</td><td>{labels[batch.kind]}</td><td>{batch.filename}</td><td>{batch.counts.create} / {batch.counts.skip} / {batch.counts.blocked}</td><td>{batch.status}</td><td><button className="secondary" onClick={() => open(batch.id)}>Open report</button></td></tr>)}
      </tbody></table></div> : <p>No workbook has been checked yet.</p>}
    </section>
  </div>;
}

function DocumentReview({ review, setReview, context, busy, onConfirm }) {
  const document = review.document || {};
  const updateDocument = change => setReview(current => ({ ...current,
    document: { ...current.document, ...change } }));
  const updateRow = (index, field, value) => setReview(current => ({ ...current,
    rows: current.rows.map((row, rowIndex) => rowIndex === index
      ? { ...row, data: { ...row.data, [field]: value } } : row) }));
  const removeRow = index => setReview(current => ({ ...current,
    rows: current.rows.filter((_, rowIndex) => rowIndex !== index) }));
  const addRow = () => setReview(current => ({ ...current, rows: [...current.rows, {
    sheet: 'Manual', row: current.rows.length + 1, code: String(current.rows.length + 1), action: 'create', errors: [],
    data: { category: '', description: '', unit: 'Item', quantity: 1, rate: 0, method: '', notes: '' }
  }] }));
  const selectedProject = context?.projects?.find(row => Number(row.id) === Number(document.projectId));
  const projectClient = selectedProject?.client;

  return <section className="table-panel import-document-review" style={{ padding: 24, marginTop: 20 }}>
    <div className="table-tools"><div><h2>Verify the extracted BOQ</h2>
      <p>Nothing below is live yet. Link existing records or enter the missing details, then check every priced line.</p></div>
      <span className="badge">{review.rows.length} lines extracted</span></div>

    <div className="import-review-section">
      <h3>1. BOQ details</h3>
      <div className="form-grid import-detail-grid">
        <label>BOQ title *<input value={document.title || ''} onChange={event => updateDocument({ title: event.target.value })} /></label>
        <label>Source reference<input value={document.reference || ''} onChange={event => updateDocument({ reference: event.target.value })} /></label>
        <label>Document date<input type="date" value={(document.documentDate || '').slice(0, 10)} onChange={event => updateDocument({ documentDate: event.target.value })} /></label>
        <label>Location<input value={document.location || ''} onChange={event => updateDocument({ location: event.target.value })} /></label>
        <label className="wide">Notes<textarea rows="2" value={document.notes || ''} onChange={event => updateDocument({ notes: event.target.value })} /></label>
      </div>
    </div>

    <div className="import-review-section">
      <h3>2. Project and client</h3>
      <p className="form-note">Choose an existing project whenever possible. Its saved client is used automatically. If this is historical work for a project not in SiteOps, leave the selection on “Create a new project”.</p>
      <div className="form-grid import-detail-grid">
        <label>Project<select value={document.projectId || ''} onChange={event => updateDocument({ projectId: event.target.value ? Number(event.target.value) : null })}>
          <option value="">Create a new project</option>
          {(context?.projects || []).map(project => <option key={project.id} value={project.id}>{project.name} · {project.client}</option>)}
        </select></label>
        {selectedProject && <div className="import-derived"><span>Client from project</span><strong>{projectClient}</strong><small>No duplicate client will be created.</small></div>}
      </div>
      {!selectedProject && <>
        {!context?.canCreateProject && <p className="form-error">You cannot create projects. Ask a project administrator to create it, then select it above.</p>}
        <div className="form-grid import-detail-grid">
          <label>New project name *<input value={document.projectName || ''} onChange={event => updateDocument({ projectName: event.target.value })} /></label>
          <label>Operating company<select value={document.companyId || 1} onChange={event => updateDocument({ companyId: Number(event.target.value) })}>
            {(context?.companies || []).map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select></label>
          <label>Site / address<input value={document.projectSite || ''} onChange={event => updateDocument({ projectSite: event.target.value })} /></label>
          <label>Project manager<input value={document.projectManager || ''} onChange={event => updateDocument({ projectManager: event.target.value })} placeholder="Can be corrected later" /></label>
          <label>Start date<input type="date" value={(document.projectStartDate || '').slice(0, 10)} onChange={event => updateDocument({ projectStartDate: event.target.value })} /></label>
        </div>
        <h4>Client for the new project</h4>
        <div className="form-grid import-detail-grid">
          <label>Client<select value={document.clientId || ''} onChange={event => updateDocument({ clientId: event.target.value ? Number(event.target.value) : null })}>
            <option value="">Create a new client</option>
            {(context?.clients || []).map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
          </select></label>
          {!document.clientId && <>
            {!context?.canCreateClient && <p className="form-error wide">You cannot create clients. Ask a client administrator to add it, then select it here.</p>}
            <label>Client name *<input value={document.clientName || ''} onChange={event => updateDocument({ clientName: event.target.value })} /></label>
            <label>Client type<select value={document.clientType || 'Organisation'} onChange={event => updateDocument({ clientType: event.target.value })}><option>Organisation</option><option>Individual</option></select></label>
            <label>Registration number<input value={document.clientRegistrationNumber || ''} onChange={event => updateDocument({ clientRegistrationNumber: event.target.value })} /></label>
            <label>TIN<input value={document.clientTin || ''} onChange={event => updateDocument({ clientTin: event.target.value })} /></label>
            <label>VAT number<input value={document.clientVatNumber || ''} onChange={event => updateDocument({ clientVatNumber: event.target.value })} /></label>
            <label>Address<input value={document.clientAddress || ''} onChange={event => updateDocument({ clientAddress: event.target.value })} /></label>
            <label>Phone<input value={document.clientPhone || ''} onChange={event => updateDocument({ clientPhone: event.target.value })} /></label>
            <label>Email<input type="email" value={document.clientEmail || ''} onChange={event => updateDocument({ clientEmail: event.target.value })} /></label>
            <label>Contact person<input value={document.clientContactPerson || ''} onChange={event => updateDocument({ clientContactPerson: event.target.value })} /></label>
          </>}
        </div>
      </>}
    </div>

    <div className="import-review-section">
      <div className="table-tools"><div><h3>3. Verify every BOQ line</h3><p>Edit anything that was read incorrectly. Category remains optional.</p></div>
        <button type="button" className="secondary" onClick={addRow}>Add line</button></div>
      <div className="import-review-scroll"><table className="import-review-table import-edit-table"><thead><tr>
        <th>Source</th><th>Category</th><th>Description *</th><th>Unit *</th><th>Quantity *</th><th>Rate *</th><th>Amount</th><th></th>
      </tr></thead><tbody>{review.rows.map((row, index) => <tr key={`${row.sheet}-${row.row}-${index}`}>
        <td>{row.sheet}<small>Row {row.row}</small>{row.errors?.length > 0 && <em>{row.errors.join(' ')}</em>}</td>
        <td><input value={row.data.category || ''} onChange={event => updateRow(index, 'category', event.target.value)} /></td>
        <td><textarea rows="2" value={row.data.description || ''} onChange={event => updateRow(index, 'description', event.target.value)} /></td>
        <td><input value={row.data.unit || ''} onChange={event => updateRow(index, 'unit', event.target.value)} /></td>
        <td><input type="number" min="0" step="any" value={row.data.quantity} onChange={event => updateRow(index, 'quantity', event.target.value)} /></td>
        <td><input type="number" min="0" step="any" value={row.data.rate} onChange={event => updateRow(index, 'rate', event.target.value)} /></td>
        <td>{(Number(row.data.quantity || 0) * Number(row.data.rate || 0)).toLocaleString('en-LK', { minimumFractionDigits: 2 })}</td>
        <td><button type="button" className="secondary" onClick={() => removeRow(index)}>Remove</button></td>
      </tr>)}</tbody></table></div>
      <div className="import-review-total"><span>Reviewed BOQ total</span><strong>LKR {review.rows.reduce((sum, row) => sum + Number(row.data.quantity || 0) * Number(row.data.rate || 0), 0).toLocaleString('en-LK', { minimumFractionDigits: 2 })}</strong></div>
    </div>
    {review.status === 'Imported' ? <p className="form-note">Imported successfully. The BOQ remains a draft until the normal QS approval step.</p>
      : <div className="form-actions"><button type="button" className="primary" onClick={onConfirm} disabled={busy || !context}>{busy ? 'Saving…' : 'Review and create records'}</button></div>}
  </section>;
}
