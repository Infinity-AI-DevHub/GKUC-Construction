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
  const refresh = () => api('/import-centre/batches').then(setBatches);
  useEffect(() => {
    api('/import-centre/types').then(rows => { setTypes(rows); setKind(rows[0]?.kind || ''); }).catch(failure => setError(failure.message));
    refresh().catch(failure => setError(failure.message));
  }, []);
  const check = async event => {
    event.preventDefault(); setBusy(true); setError(''); setReview(null);
    try {
      const form = new FormData(); form.append('kind', kind); form.append('file', file);
      setReview(await api('/import-centre/dry-check', { method: 'POST', body: form }));
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const open = async id => {
    setError('');
    try { const record = await api(`/import-centre/batches/${id}`); setReview({ id: record.id, status: record.status, ...record.preview }); }
    catch (failure) { setError(failure.message); }
  };
  const confirm = async () => {
    if (!window.confirm(`Create ${review.counts.create} ${labels[review.kind]?.toLowerCase()}? Existing records will be skipped. This action changes live records.`)) return;
    setBusy(true); setError('');
    try { const result = await api(`/import-centre/batches/${review.id}/confirm`, { method: 'POST', body: '{}' });
      setReview(current => ({ ...current, status: result.status })); await refresh(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <div className="import-centre">
    <section className="table-panel" style={{ padding: 24 }}>
      <h2>Import historical records</h2>
      <p>Start with clients, then subcontractors and projects. Check every workbook before it changes SiteOps. Use the migration codes from the prepared templates to connect related records.</p>
      <form className="form-grid" onSubmit={check}>
        <div className="form-field"><label htmlFor="import-kind">Template</label><select id="import-kind" value={kind} onChange={event => { setKind(event.target.value); setReview(null); }}>
          {order.filter(id => types.some(type => type.kind === id)).map(id => <option key={id} value={id}>{labels[id]}</option>)}
        </select></div>
        <div className="form-field"><label htmlFor="import-file">Completed Excel workbook</label><input id="import-file" type="file" accept=".xlsx" required onChange={event => setFile(event.target.files?.[0] || null)} /></div>
        <div className="form-actions"><button className="primary" type="submit" disabled={!file || !kind || busy}>{busy ? 'Checking…' : 'Run dry check'}</button></div>
      </form>
      <p className="form-note">A dry check saves an audit report, not business records. BOQs, quotations, cost controls and retentions currently support checking only; their live import remains unavailable until their linked sheets are mapped safely. Related sheets with populated rows also block confirmation, so contacts, teams and subcontractor pricing cannot be silently omitted.</p>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {review && <section className="table-panel" style={{ padding: 24, marginTop: 20 }}>
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
