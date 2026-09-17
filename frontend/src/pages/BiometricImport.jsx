import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, UserPlus, Upload } from 'lucide-react';
import { api, post, shortDate, slug } from '../api.js';
import { notice } from '../notices.js';
import { Badge, Row, Summary, Table } from '../ui.jsx';

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
  const [workLocation, setWorkLocation] = useState('Site');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [commitError, setCommitError] = useState('');
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [result, setResult] = useState(null);
  const [choices, setChoices] = useState({});
  const [identityErrors, setIdentityErrors] = useState({});
  const input = useRef(null);
  const lastFile = useRef(null);

  const read = async (file, keepPreview = false) => {
    setBusy(true); setError(''); setResult(null);
    setConfirmPartial(false);
    if (!keepPreview) { setPreview(null); setIdentityErrors({}); }
    try {
      const form = new FormData();
      form.append('file', file);
      const body = await api('/biometric/preview', { method: 'POST', body: form });
      setPreview(body);
      return body;
    } catch (failure) {
      setError(`Could not read ${file.name}. ${failure.message} Check that this is the attendance export, then try again.`);
      if (!keepPreview && failure.details?.problems?.length) {
        setPreview({ problems: failure.details.problems, columns: failure.details.columns || [], rows: [] });
      }
      return null;
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const choose = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    lastFile.current = file;
    read(file);
  };

  /*
   * Naming a device number is a one-off: it is stored against the employee, so the file is
   * simply read again and everything that person has ever punched now matches.
   */
  const identify = async (code, employeeId) => {
    if (!employeeId) return;
    setBusy(true); setError('');
    setIdentityErrors(current => ({ ...current, [code]: '' }));
    try {
      await post('/biometric/mappings', { code, employeeId: Number(employeeId), replaceExisting: true });
      const refreshed = lastFile.current ? await read(lastFile.current, true) : false;
      if (refreshed && !refreshed.unknownDevices?.some(device => String(device.code) === String(code))) {
        notice({ title: 'Scanner identity linked', message: `Device #${code} is matched in this file and will match on future imports.`, severity: 'Info' });
      } else setIdentityErrors(current => ({ ...current, [code]: refreshed
        ? `Device #${code} is still unmatched after saving the link. Refresh the file preview and contact an administrator if it remains unmatched.`
        : 'The link was saved, but the file preview could not refresh. Choose the export file again to check the match.' }));
    } catch (failure) {
      setIdentityErrors(current => ({ ...current, [code]: `Could not link device #${code}. ${failure.message} Check that you selected the correct employee, then try again.` }));
    } finally { setBusy(false); }
  };

  const createPerson = async device => {
    setBusy(true); setError('');
    setIdentityErrors(current => ({ ...current, [device.code]: '' }));
    let created = false;
    try {
      await post('/biometric/people', {
        code: device.code,
        name: device.name || `Worker ${device.code}`,
        department: device.department || undefined,
        firstDate: device.firstDate
      });
      created = true;
      notice({ title: 'Employee profile created', message: `Device #${device.code} is now recognised.`, severity: 'Info' });
      const refreshed = lastFile.current ? await read(lastFile.current, true) : false;
      if (!refreshed) setIdentityErrors(current => ({ ...current, [device.code]: 'The profile was created, but the preview could not refresh. Choose the export file again to check the match.' }));
      await reload();
    } catch (failure) {
      setIdentityErrors(current => ({ ...current, [device.code]: created
        ? `The profile was created, but staff details could not refresh. ${failure.message} Refresh the page; do not create it again.`
        : `Could not create a profile for device #${device.code}. ${failure.message} Check the person's details before trying again.` }));
    } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!preview?.rows?.some(row => row.employeeId)) return;
    setBusy(true); setError(''); setCommitError(''); setConfirmPartial(false);
    try {
      const usable = preview.rows.filter(row => row.employeeId);
      const leftOut = preview.rows.length - usable.length;
      const outcome = await post('/biometric/commit', {
        projectId: workLocation === 'Site' ? Number(projectId) : null,
        workLocation,
        filename: preview.filename,
        rows: usable.map(row => ({
          employeeId: row.employeeId, code: row.code, name: row.name,
          date: row.date, checkIn: row.checkIn, checkOut: row.checkOut,
          needsReview: Boolean(row.needsReview), declaredState: row.declaredState || null
        }))
      });
      setResult({ ...outcome, leftOut });
      setPreview(current => leftOut && current ? {
        ...current,
        rows: current.rows.filter(row => !row.employeeId),
        summary: { ...current.summary, rows: leftOut, matched: 0, unmatched: leftOut,
          needsReview: current.rows.filter(row => !row.employeeId && row.needsReview).length }
      } : null);
      try { await reload(); }
      catch (failure) { setCommitError(`Attendance was saved, but the page could not refresh. ${failure.message} Refresh the page before importing again.`); }
    } catch (failure) {
      setCommitError(`Attendance could not be imported. ${failure.message} Your preview is still here; check the site and identities before trying again.`);
    } finally { setBusy(false); }
  };

  if (!can.hrImport) return <p className="empty-state">You do not have permission to import attendance.</p>;

  const template = 'minmax(160px,1.3fr) 120px 100px 100px 130px 110px';
  const matched = preview?.rows.filter(row => row.employeeId).length || 0;
  const previewRows = preview?.rows ? [
    ...preview.rows.filter(row => row.needsReview || row.duplicate),
    ...preview.rows.filter(row => !row.needsReview && !row.duplicate)
  ].filter((row, index, all) => all.findIndex(other => other.code === row.code && other.date === row.date) === index).slice(0, 80) : [];

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
          {result.leftOut ? ` ${result.leftOut} unmatched day(s) were not imported; link those people below and import them later.` : ' Payroll and leave now read from this record.'}
        </span>
      </div>
    )}

    {preview?.rows?.length > 0 && <>
      <div className="attendance-summary">
        <Summary label={result?.leftOut ? 'Days still unmatched' : 'Days read'} value={preview.summary.rows} icon={CheckCircle2} />
        <Summary label="Matched to staff" value={preview.summary.matched} icon={CheckCircle2} />
        <Summary label="Unmatched" value={preview.summary.unmatched} icon={AlertTriangle} />
        <Summary label="Need review" value={preview.summary.needsReview || 0} icon={AlertTriangle} />
      </div>

      {preview.unknownDevices?.length > 0 && (
        <section className="table-panel device-map">
          <div className="table-tools">
            <h2>Who are these? — {preview.unknownDevices.length} unrecognised device number(s)</h2>
            <small>Review each identity once. The scanner number is remembered after your decision.</small>
          </div>
          {preview.unknownDevices.map(device => (
            <div className="device-row" key={device.code}>
              <div>
                <strong>{device.name || `Device ${device.code}`}</strong>
                <small>#{device.code}{device.department ? ` · ${device.department}` : ''} · {device.days} day(s) in this file</small>
                {device.suggestedEmployee && <span className="identity-hint">Possible existing profile: {device.suggestedEmployee}</span>}
              </div>
              <select className="identity-select" value={choices[device.code] || device.suggestedEmployeeId || ''}
                onChange={event => setChoices(current => ({ ...current, [device.code]: event.target.value }))} disabled={busy}>
                <option value="">Choose existing person…</option>
                {(data.employees || []).map(person => (
                  <option value={person.id} key={person.id}>{person.name} ({person.code})</option>
                ))}
              </select>
              <div className="identity-actions">
                <button className="secondary" disabled={busy || !(choices[device.code] || device.suggestedEmployeeId)}
                  onClick={() => identify(device.code, choices[device.code] || device.suggestedEmployeeId)}>
                  <Link2 size={14} />Link existing
                </button>
                <button className="primary" disabled={busy} onClick={() => createPerson(device)}>
                  <UserPlus size={14} />Create new profile
                </button>
                {identityErrors[device.code] && <p className="form-error" role="alert">{identityErrors[device.code]}</p>}
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="import-commit">
        <label>Work location<select value={workLocation} onChange={event => setWorkLocation(event.target.value)}>
          <option value="Site">Project site</option><option value="Office">Head office</option>
        </select></label>
        {workLocation === 'Site' && <label>Project / site<select value={projectId} onChange={event => setProjectId(event.target.value)}>
          {data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select></label>}
        <button className="primary" onClick={() => preview.summary.unmatched > 0 ? setConfirmPartial(true) : commit()}
          disabled={busy || !matched || (workLocation === 'Site' && !projectId)}>
          {busy ? 'Importing…' : preview.summary.unmatched > 0 ? `Review import of ${matched} matched day(s)` : `Import ${matched} matched day(s)`}
        </button>
        <small>
          {preview.from === preview.to ? shortDate(preview.from) : `${shortDate(preview.from)} → ${shortDate(preview.to)}`}
          {preview.summary.unmatched > 0 && ` · ${preview.summary.unmatched} unmatched day(s) will be left out`}
        </small>
        {confirmPartial && <div className="import-partial-confirm" role="alert">
          <strong>Review before saving: {matched} matched day(s)</strong>
          <span>The {preview.summary.unmatched} unmatched day(s) will not be saved. Link their scanner numbers below and import them later. Previously imported days will be updated, not duplicated, if you use this file again.</span>
          <div><button className="secondary" type="button" onClick={() => setConfirmPartial(false)}>Wait and link people</button>
            <button className="primary" type="button" onClick={commit}>Yes, save {matched} matched days</button></div>
        </div>}
        {commitError && <p className="form-error" role="alert">{commitError}</p>}
      </div>

      <Table columns={['Employee', 'Date', 'In', 'Out', 'Reads as', 'Match']} template={template}
        title={`Priority preview — ${previewRows.length} of ${preview.rows.length} days`}>
        {previewRows.map((row, index) => (
          <Row template={template} key={`${row.code}-${row.date}-${index}`}>
            <div><strong>{row.employee || row.name || row.code}</strong><small>{row.code || '—'}</small></div>
            <span>{shortDate(row.date)}</span>
            <span>{row.checkIn || '—'}</span>
            <span>{row.checkOut || '—'}</span>
            <div>
              <Badge tone={slug(row.state)}>{row.state}</Badge>
              {row.needsReview && <small className="needs-review">One punch only — confirm</small>}
            </div>
            {row.employeeId
              ? <Badge tone={row.duplicate ? 'watch' : 'on-track'}>{row.duplicate ? 'Will update' : 'New'}</Badge>
              : <Badge tone="at-risk">No match</Badge>}
          </Row>
        ))}
      </Table>
      {preview.rows.length > previewRows.length && <p className="import-preview-note">
        Single-punch days and overlapping records are shown first. The full {preview.rows.length}-day file will be imported after all {preview.unknownDevices.length} identity decisions are resolved.
      </p>}
    </>}
  </>;
}
