import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, AlertTriangle, Info, Check, X, FileSpreadsheet, Loader2, PencilLine, Wand2, Paperclip } from 'lucide-react';
import { api, post, del, rupees, token, announceDataChanged, fetchDownload } from './api.js';

/*
 * Bringing a bill of quantities in from a spreadsheet.
 *
 * The step that matters is the one in the middle: nothing reaches a real bill until the
 * person who uploaded the file has seen every row the system read, corrected whatever it
 * could not understand, and said yes. A spreadsheet filled in by hand always carries
 * something — a category spelled differently, a quantity with a note beside it — and the
 * alternative to showing it here is discovering it in a quotation already sent to a client.
 */

const LABELS = {
  ref: 'Their item reference', description: 'Description', unit: 'Unit',
  quantity: 'Quantity', rate: 'Rate', amount: 'Amount', category: 'Category'
};

export default function BoqImport({ projects, onDone, onCreate }) {
  const [staged, setStaged] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectId, setProjectId] = useState('');
  const fileInput = useRef(null);

  const downloadTemplate = async () => {
    setError('');
    try {
      const response = await fetch(`/api/boq/template${projectId ? `?projectId=${projectId}` : ''}`, {
        headers: { Authorization: `Bearer ${token.get()}` }
      });
      if (!response.ok) throw new Error('The template could not be prepared');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'GKUC-BOQ-template.xlsx';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (failure) { setError(failure.message); }
  };

  const upload = async file => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (projectId) form.append('projectId', projectId);
      const response = await fetch('/api/boq/import', {
        method: 'POST', headers: { Authorization: `Bearer ${token.get()}` }, body: form
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!response.ok) throw new Error(body?.error || `The file could not be read (${response.status}).`);
      setStaged(body);
      if (body.projectId) setProjectId(String(body.projectId));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (staged) {
    return <ReviewTable
      staged={staged}
      projects={projects}
      projectId={projectId}
      setProjectId={setProjectId}
      onChange={setStaged}
      onCancel={async () => { await del(`/boq/imports/${staged.id}`).catch(() => {}); setStaged(null); }}
      onCommitted={result => { setStaged(null); announceDataChanged(); onDone?.(result); }}
    />;
  }

  return <>
    <section className="panel boq-import">
      <div className="panel-title"><h2>Create a bill of quantities</h2></div>
      <div className="boq-choice">
        {/* Both ways are equally supported. Which suits depends on the job: a short bill is
            quicker typed here, a long one is usually already in a spreadsheet. */}
        <button type="button" className="boq-way" onClick={onCreate}>
          <span className="boq-way-icon"><PencilLine size={20} /></span>
          <strong>Build it here</strong>
          <small>Add the lines one at a time, on screen. Best for a short bill, or when
            you are pricing as you go.</small>
        </button>
        <div className="boq-way is-active">
          <span className="boq-way-icon"><FileSpreadsheet size={20} /></span>
          <strong>Bring it in from Excel</strong>
          <small>Work in a spreadsheet and upload it when finished. Best for a long bill,
            or one somebody has already priced.</small>
        </div>
      </div>
    </section>

    <section className="panel boq-import">
    <div className="panel-title"><h2>Bring a BOQ in from Excel</h2></div>
    <div className="boq-import-body">
      <ol className="boq-steps">
        <li><strong>Download the template.</strong> It has the right columns and an example row.</li>
        <li><strong>Fill it in.</strong> One line of work per row. Leave the Amount column empty — it is worked out for you.</li>
        <li><strong>Upload it back.</strong> You will see everything the system read, and anything it could not understand, before it is saved.</li>
      </ol>

      <label className="boq-project-pick">
        Which project is this for?
        <select value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Choose later</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>

      <div className="boq-import-actions">
        <button type="button" className="secondary" onClick={downloadTemplate}>
          <Download size={16} /> Download the template
        </button>
        <button type="button" className="primary" onClick={() => fileInput.current?.click()} disabled={busy}>
          {busy ? <Loader2 size={16} className="docsearch-spin" /> : <Upload size={16} />}
          {busy ? 'Reading the file…' : 'Upload a filled-in BOQ'}
        </button>
        <input ref={fileInput} type="file" hidden
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={event => upload(event.target.files?.[0])} />
      </div>

      {error && <p className="form-error">{error}</p>}
    </div>
    </section>
  </>;
}

function ReviewTable({ staged, projects, projectId, setProjectId, onChange, onCancel, onCommitted }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const problems = staged.items.filter(item => item.include && item.problems).length;

  const patch = async (itemId, change) => {
    try {
      const updated = await api(`/boq/imports/${staged.id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(change)
      });
      onChange(updated);
    } catch (failure) { setError(failure.message); }
  };

  const commit = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await post(`/boq/imports/${staged.id}/commit`, { projectId: Number(projectId) });
      onCommitted(result);
    } catch (failure) {
      setError(failure.message);
    } finally { setSaving(false); }
  };

  const [bulkCategory, setBulkCategory] = useState('');
  const [bulking, setBulking] = useState(false);

  /* Fills in what the other company's bill never had, in one go rather than line by line. */
  const applyBulkCategory = async () => {
    setBulking(true);
    setError('');
    try {
      const next = await post(`/boq/imports/${staged.id}/bulk`,
        { field: 'category', value: bulkCategory, onlyMissing: true });
      onChange(next);
      setBulkCategory('');
    } catch (failure) { setError(failure.message); } finally { setBulking(false); }
  };

  /* The file travels with the session, so it is fetched rather than linked. */
  const downloadOriginal = async event => {
    event.preventDefault();
    try {
      const url = await fetchDownload(`/boq/imports/${staged.id}/file`);
      const link = document.createElement('a');
      link.href = url;
      link.download = staged.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (failure) { setError(failure.message); }
  };

  const included = staged.items.filter(item => item.include);
  const total = included.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return <section className="panel boq-review">
    <div className="panel-title">
      <h2>Check this before it is saved</h2>
      <span className={`badge ${problems ? 'at-risk' : 'on-track'}`}>
        {problems ? `${problems} row${problems === 1 ? '' : 's'} need attention` : 'Everything reads correctly'}
      </span>
    </div>

    <div className="boq-review-head">
      <div>
        <FileSpreadsheet size={17} />
        <div>
          <strong>{staged.title || staged.filename}</strong>
          <small>{staged.client ? `${staged.client} · ` : ''}{included.length} of {staged.items.length} lines included</small>
        </div>
      </div>
      <label>
        Project
        <select value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Choose a project…</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
    </div>

    {/*
      * A bill written on somebody else's template was read by working out what the columns
      * meant. Showing that working is the difference between the reviewer checking the
      * figures and being asked to take them on trust.
      */}
    {staged.layout?.foreign && (
      <div className="boq-foreign">
        <Info size={17} />
        <div>
          <strong>This is not our template, so the system worked out the layout</strong>
          <p>
            Headings were found on row {staged.layout.headerRow} of sheet
            <b> {staged.layout.sheet || 'the first sheet'}</b>. Check the columns were read the right way round:
          </p>
          <ul className="boq-mapping">
            {Object.entries(staged.layout.headings || {}).map(([key, heading]) => (
              <li key={key}><span>{LABELS[key] || key}</span><b>{heading || '—'}</b></li>
            ))}
          </ul>
          {staged.layout.notes?.length ? (
            <p className="boq-mapping-notes">{staged.layout.notes.join('. ')}.</p>
          ) : null}
          <p className="boq-mapping-notes">
            Section headings and subtotal lines were left out. Their own item references are
            kept in the notes on each line.
          </p>
        </div>
      </div>
    )}

    <div className="boq-bulk">
      <Wand2 size={15} />
      <span>Set every line still missing a category to</span>
      <select value={bulkCategory} onChange={event => setBulkCategory(event.target.value)}>
        <option value="">Choose…</option>
        {(staged.categories || []).map(category => <option key={category}>{category}</option>)}
      </select>
      <button type="button" className="secondary" disabled={!bulkCategory || bulking}
        onClick={applyBulkCategory}>{bulking ? 'Setting…' : 'Apply'}</button>
      <a className="boq-evidence" href={`/api/boq/imports/${staged.id}/file`}
        onClick={downloadOriginal}>
        <Paperclip size={14} /> The original file
      </a>
    </div>

    <div className="boq-review-scroll">
      <table className="boq-review-table">
        <thead>
          <tr>
            <th>Use</th><th>Row</th><th>Category</th><th>Description</th>
            <th>Unit</th><th>Quantity</th><th>Rate</th><th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {staged.items.map(item => (
            <tr key={item.id} className={item.problems && item.include ? 'has-problem' : ''}>
              <td className="boq-use">
                {/* The label wraps the box, so the whole cell toggles it. A bare checkbox is
                    a 26px target — hard to hit on a phone held on a site, and the row beside
                    it does nothing when tapped, which reads as the screen being broken. */}
                <label className="boq-use-hit">
                  <input type="checkbox" checked={Boolean(item.include)}
                    aria-label={`Include row ${item.sourceRow}`}
                    onChange={event => patch(item.id, { include: event.target.checked })} />
                </label>
              </td>
              <td className="num">{item.sourceRow}</td>
              <td>
                <select value={item.category || ''} onChange={event => patch(item.id, { category: event.target.value })}>
                  <option value="">—</option>
                  {staged.categories.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </td>
              <td className="boq-desc">
                <Editable value={item.description} onSave={value => patch(item.id, { description: value })} />
                {item.problems && item.include && (
                  <span className="boq-problem"><AlertTriangle size={13} /> {item.problems}</span>
                )}
                {/* Worth reading, but nothing to fix — the system uses quantity x rate. */}
                {!item.problems && item.notice && item.include && (
                  <span className="boq-notice"><Info size={13} /> {item.notice}</span>
                )}
              </td>
              <td><Editable value={item.unit} width={64} onSave={value => patch(item.id, { unit: value })} /></td>
              <td className="num"><Editable value={item.quantity} width={84} align="right"
                onSave={value => patch(item.id, { quantity: value })} /></td>
              <td className="num"><Editable value={item.rate} width={96} align="right"
                onSave={value => patch(item.id, { rate: value })} /></td>
              <td className="num">{item.amount === null ? '—' : rupees(item.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td colSpan={7}>Total of the lines being used</td><td className="num"><strong>{rupees(total)}</strong></td></tr>
        </tfoot>
      </table>
    </div>

    {error && <p className="form-error boq-review-error">{error}</p>}

    <div className="boq-review-actions">
      <button type="button" className="secondary" onClick={onCancel}><X size={16} /> Discard this file</button>
      <button type="button" className="primary" onClick={commit}
        disabled={saving || !projectId || problems > 0 || !included.length}>
        <Check size={16} /> {saving ? 'Saving…' : 'Approve and create the BOQ'}
      </button>
    </div>
    {problems > 0 && (
      <p className="boq-review-note">
        Correct the rows marked above, or untick them, before this can be saved.
      </p>
    )}
  </section>;
}

/** A cell that becomes an input when clicked, and saves when you leave it. */
function Editable({ value, onSave, width, align }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);

  if (!editing) {
    return <button type="button" className="boq-cell" style={{ textAlign: align || 'left' }}
      onClick={() => setEditing(true)}>
      {value === null || value === '' ? <span className="boq-empty">—</span> : String(value)}
    </button>;
  }
  return <input autoFocus value={draft} style={{ width, textAlign: align || 'left' }}
    onChange={event => setDraft(event.target.value)}
    onBlur={() => { setEditing(false); if (String(draft) !== String(value ?? '')) onSave(draft); }}
    onKeyDown={event => {
      if (event.key === 'Enter') event.target.blur();
      if (event.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
    }} />;
}
