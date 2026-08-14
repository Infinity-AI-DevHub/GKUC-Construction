import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react';
import { post, shortDate, slug, token } from '../api.js';
import { Badge, Row, SelectField, Summary, Table } from '../ui.jsx';

/**
 * PID v3 §1.2 — the pendrive export is dropped in here. Nothing about how workers clock in
 * changes; this only closes the gap between the device and payroll.
 *
 * The file is previewed before anything is written, because this is the payroll input and
 * an unmatched name or an unreadable row should be seen by a person, not discovered later
 * in a wage dispute.
 */
export default function BiometricImport({ data, can, reload }) {
  const [preview, setPreview] = useState(null);
  const [projectId, setProjectId] = useState(data.projects[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const input = useRef(null);

  const choose = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(''); setResult(null); setPreview(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const stored = token.get();
      const response = await fetch('/api/biometric/preview', {
        method: 'POST',
        headers: stored ? { Authorization: `Bearer ${stored}` } : {},
        body: form
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error || 'That file could not be read');
        setPreview({ problems: body.problems || [], columns: body.columns || [], rows: [] });
        return;
      }
      setPreview(body);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const commit = async () => {
    setBusy(true); setError('');
    try {
      const usable = preview.rows.filter(row => row.employeeId);
      const outcome = await post('/biometric/commit', {
        projectId: Number(projectId),
        filename: preview.filename,
        rows: usable.map(row => ({
          employeeId: row.employeeId, code: row.code, name: row.name,
          date: row.date, checkIn: row.checkIn, checkOut: row.checkOut
        }))
      });
      setResult(outcome);
      setPreview(null);
      await reload();
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  };

  if (!can.hrImport) return <p className="empty-state">You do not have permission to import attendance.</p>;

  const template = 'minmax(160px,1.3fr) 120px 100px 100px 120px 110px';
  const matched = preview?.rows.filter(row => row.employeeId).length || 0;

  return <>
    <div className="import-panel">
      <div>
        <h2>Upload the biometric export</h2>
        <p>
          Copy the file from the pendrive and drop it in. Punch logs and daily in/out exports
          are both understood, with tab, comma or semicolon separators. Nothing is written
          until you have seen what the file contains.
        </p>
      </div>
      <label className="primary import-choose">
        <Upload size={16} />{busy ? 'Reading…' : 'Choose export file'}
        <input ref={input} type="file" onChange={choose} disabled={busy} hidden />
      </label>
    </div>

    {error && <p className="form-error">{error}</p>}

    {preview?.problems?.length > 0 && (
      <div className="import-problems">
        <strong><AlertTriangle size={15} /> {preview.problems.length} row(s) need a look</strong>
        <ul>{preview.problems.slice(0, 8).map((problem, index) => <li key={index}>{problem}</li>)}</ul>
        {preview.columns?.length > 0 && <small>Columns found: {preview.columns.join(', ')}</small>}
      </div>
    )}

    {result && (
      <div className="import-result">
        <CheckCircle2 size={16} />
        <span>
          Imported into <strong>{result.site}</strong> — {result.inserted} new day(s),
          {' '}{result.updated} updated{result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.
          Payroll and leave now read from this record.
        </span>
      </div>
    )}

    {preview?.rows?.length > 0 && <>
      <div className="attendance-summary">
        <Summary label="Days read" value={preview.summary.rows} icon={CheckCircle2} />
        <Summary label="Matched to staff" value={preview.summary.matched} icon={CheckCircle2} />
        <Summary label="Unmatched" value={preview.summary.unmatched} icon={AlertTriangle} />
        <Summary label="Already recorded" value={preview.summary.duplicates} icon={AlertTriangle} />
      </div>

      <div className="import-commit">
        <SelectField name="projectId" label="Record this attendance against"
          options={data.projects.map(project => [project.id, project.name])}
          defaultValue={projectId} />
        <button className="primary" onClick={commit} disabled={busy || !matched}>
          {busy ? 'Importing…' : `Import ${matched} day(s)`}
        </button>
        <small>
          {preview.from === preview.to ? shortDate(preview.from) : `${shortDate(preview.from)} → ${shortDate(preview.to)}`}
          {preview.summary.unmatched > 0 && ` · ${preview.summary.unmatched} unmatched row(s) will be left out`}
        </small>
      </div>

      <Table columns={['Employee', 'Date', 'In', 'Out', 'Reads as', 'Match']} template={template}
        title={`Preview — ${preview.filename}`}>
        {preview.rows.map((row, index) => (
          <Row template={template} key={`${row.code}-${row.date}-${index}`}>
            <div><strong>{row.employee || row.name || row.code}</strong><small>{row.code || '—'}</small></div>
            <span>{shortDate(row.date)}</span>
            <span>{row.checkIn || '—'}</span>
            <span>{row.checkOut || '—'}</span>
            <Badge tone={slug(row.state)}>{row.state}</Badge>
            {row.employeeId
              ? <Badge tone={row.duplicate ? 'watch' : 'on-track'}>{row.duplicate ? 'Will update' : 'New'}</Badge>
              : <Badge tone="at-risk">No match</Badge>}
          </Row>
        ))}
      </Table>
    </>}
  </>;
}
