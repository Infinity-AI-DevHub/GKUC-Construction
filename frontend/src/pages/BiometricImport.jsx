import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, PencilLine, UserPlus, Upload } from 'lucide-react';
import { api, post, shortDate, slug } from '../api.js';
import { notice } from '../notices.js';
import { Badge, Field, FormModal, Row, SelectField, Summary, Table, TextArea } from '../ui.jsx';

const keyFor = row => `${row.code || row.name || row.employeeId}|${row.date}`;
const seconds = value => value && value.length === 5 ? `${value}:00` : value || null;

/**
 * PID v3 §1.2 — the pendrive export is dropped in here. Nothing about how workers clock in
 * changes; this only closes the gap between the device and payroll.
 *
 * The file is previewed before anything is written, because this is the payroll input and
 * an unmatched name or an unreadable row should be seen by a person, not discovered later
 * in a wage dispute.
 */
export default function BiometricImport({ data, projects = data.projects, can, reload }) {
  const [preview, setPreview] = useState(null);
  const [personLocations, setPersonLocations] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [commitError, setCommitError] = useState('');
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [result, setResult] = useState(null);
  const [choices, setChoices] = useState({});
  const [identityErrors, setIdentityErrors] = useState({});
  const [edits, setEdits] = useState({});
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(80);
  const input = useRef(null);
  const lastFile = useRef(null);

  const read = async (file, keepPreview = false) => {
    setBusy(true); setError(''); setResult(null);
    setConfirmPartial(false);
    if (!keepPreview) { setPreview(null); setIdentityErrors({}); setEdits({}); setPersonLocations({}); setSearch(''); setVisibleLimit(80); }
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
    const rows = preview.rows.map(row => ({ ...row, ...edits[keyFor(row)] }));
    const usable = rows.filter(row => row.employeeId);
    const missing = usable.filter(row => !locationFor(row));
    if (missing.length) {
      setCommitError(`${missing.length} matched day(s) still need a work location. Set each person's usual location below, then override any days spent elsewhere before importing.`);
      setConfirmPartial(false);
      return;
    }
    setBusy(true); setError(''); setCommitError(''); setConfirmPartial(false);
    try {
      const leftOut = rows.length - usable.length;
      const outcome = await post('/biometric/commit', {
        filename: preview.filename,
        rows: usable.map(row => ({
          employeeId: row.employeeId, code: row.code, name: row.name,
          date: row.date, checkIn: row.checkIn, checkOut: row.checkOut,
          needsReview: Boolean(row.needsReview), declaredState: row.declaredState || null,
          correctionReason: row.correctionReason || null,
          ...locationPayload(locationFor(row))
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
      setCommitError(`Attendance could not be imported. ${failure.message} Your preview is still here; check the locations and identities before trying again.`);
    } finally { setBusy(false); }
  };

  if (!can.hrImport) return <p className="empty-state">You do not have permission to import attendance.</p>;

  const template = 'minmax(160px,1.3fr) 120px 100px 100px 130px minmax(130px,1fr) 110px';
  const matched = preview?.rows.filter(row => row.employeeId).length || 0;
  const editedRows = preview?.rows?.map(row => ({ ...row, ...edits[keyFor(row)], originalKey: keyFor(row) })) || [];
  const locationFor = row => ['Absent', 'On leave'].includes(row.declaredState) || (!row.declaredState && !row.checkIn && !row.checkOut)
    ? 'not-working' : (row.locationKey || (row.plannedWorkLocation === 'Office' ? 'office'
      : row.plannedWorkLocation === 'Site' ? `site:${row.plannedProjectId}` : '') || personLocations[row.employeeId] || '');
  const locationPayload = key => key === 'office' ? { workLocation: 'Office', projectId: null }
    : key === 'not-working' ? { workLocation: 'Not working', projectId: null }
      : { workLocation: 'Site', projectId: Number(key.slice(5)) };
  const locationLabel = key => key === 'office' ? 'Head office'
    : key === 'not-working' ? 'Not working' : projects.find(project => `site:${project.id}` === key)?.name || 'Unassigned';
  const peopleInFile = [...new Map(editedRows.filter(row => row.employeeId)
    .map(row => [row.employeeId, row])).values()];
  const unassigned = editedRows.filter(row => row.employeeId && !locationFor(row)).length;
  const orderedRows = [
    ...editedRows.filter(row => row.needsReview || row.duplicate),
    ...editedRows.filter(row => !row.needsReview && !row.duplicate)
  ];
  const searchedRows = orderedRows.filter(row => `${row.employee || row.name || ''} ${row.code || ''} ${row.date}`
    .toLowerCase().includes(search.trim().toLowerCase()));
  const previewRows = searchedRows.slice(0, visibleLimit);
  const editingRow = editing && editedRows.find(row => row.originalKey === editing);
  const saveEdit = (originalKey, values) => {
    const original = preview.rows.find(row => keyFor(row) === originalKey);
    const date = values.date;
    const duplicate = date !== original.date && preview.rows.some(row => keyFor(row) !== originalKey
      && (row.employeeId || row.code) === (original.employeeId || original.code)
      && (edits[keyFor(row)]?.date || row.date) === date);
    if (duplicate) throw new Error('This person already has another row on that date. Choose the correct date before saving.');
    const declaredState = values.declaredState || null;
    setEdits(current => ({ ...current, [originalKey]: {
      date, checkIn: declaredState ? null : seconds(values.checkIn),
      checkOut: declaredState ? null : seconds(values.checkOut),
      declaredState, needsReview: values.reviewStatus === 'Needs review',
      correctionReason: values.reason.trim(), locationKey: values.locationKey || ''
    } }));
    setConfirmPartial(false);
  };

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
          Imported with <strong>individual work locations</strong> — {result.inserted} new day(s),
          {' '}{result.updated} updated{result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.
          {result.skipped.some(item => item.why === 'A manual correction was kept') && ' Existing HR corrections were kept unchanged.'}
          {result.leftOut ? ` ${result.leftOut} unmatched day(s) were not imported; link those people below and import them later.` : ' Payroll and leave now read from this record.'}
        </span>
      </div>
    )}

    {preview?.rows?.length > 0 && <>
      <div className="attendance-summary">
        <Summary label={result?.leftOut ? 'Days still unmatched' : 'Days read'} value={preview.summary.rows} icon={CheckCircle2} />
        <Summary label="Matched to staff" value={preview.summary.matched} icon={CheckCircle2} />
        <Summary label="Unmatched" value={preview.summary.unmatched} icon={AlertTriangle} />
        <Summary label="Need review" value={editedRows.filter(row => row.needsReview).length} icon={AlertTriangle} />
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

      {peopleInFile.length > 0 && <section className="table-panel import-location-panel">
        <div className="table-tools">
          <h2>Where did each person work?</h2>
          <small>Dated locations from the Workforce map are used first. Set a usual location here for days without a schedule; edit any individual day below if they worked elsewhere. Absent and leave days are marked Not working automatically.</small>
          <strong className={unassigned ? 'needs-review' : ''}>{unassigned ? `${unassigned} matched day(s) need a location` : 'All matched days have a location'}</strong>
        </div>
        <div className="import-location-grid">
          {peopleInFile.map(person => <label key={person.employeeId}>
            <span><strong>{person.employee || person.name}</strong> <small>#{person.code || person.employeeId} · {editedRows.filter(row => row.employeeId === person.employeeId).length} day(s)</small></span>
            <select value={personLocations[person.employeeId] || ''} disabled={busy}
              onChange={event => { setPersonLocations(current => ({ ...current, [person.employeeId]: event.target.value })); setCommitError(''); setConfirmPartial(false); }}
              aria-label={`Usual work location for ${person.employee || person.name}`}>
              <option value="">Choose work location…</option>
              <option value="office">Head office</option>
              {projects.map(project => <option value={`site:${project.id}`} key={project.id}>{project.name}</option>)}
            </select>
          </label>)}
        </div>
      </section>}

      <div className="import-commit">
        <button className="primary" onClick={() => {
          if (unassigned) { setCommitError(`${unassigned} matched day(s) need a location. Assign each person above or edit individual days before importing.`); return; }
          preview.summary.unmatched > 0 ? setConfirmPartial(true) : commit();
        }} disabled={busy || !matched}>
          {busy ? 'Importing…' : preview.summary.unmatched > 0 ? `Review import of ${matched} matched day(s)` : `Import ${matched} matched day(s)`}
        </button>
        <small>
          File period: {preview.from === preview.to ? shortDate(preview.from) : `${shortDate(preview.from)} → ${shortDate(preview.to)}`}
          {preview.summary.unmatched > 0 && ` · ${preview.summary.unmatched} unmatched day(s) will be left out`}
        </small>
        {confirmPartial && <div className="import-partial-confirm" role="alert">
          <strong>Review before saving: {matched} matched day(s)</strong>
          <span>The {preview.summary.unmatched} unmatched day(s) will not be saved. Link their scanner numbers above and import them later. Each saved day uses the location shown in the preview. Previously imported days will be updated, not duplicated, if you use this file again.</span>
          <div><button className="secondary" type="button" onClick={() => setConfirmPartial(false)}>Wait and link people</button>
            <button className="primary" type="button" onClick={commit}>Yes, save {matched} matched days</button></div>
        </div>}
        {commitError && <p className="form-error" role="alert">{commitError}</p>}
      </div>

      <Table columns={['Employee', 'Date', 'In', 'Out', 'Reads as', 'Work location', 'Match', 'Edit']}
        template={`${template} 66px`}
        title={`Attendance preview — ${previewRows.length} of ${searchedRows.length} days`}
        tools={<input className="import-preview-search" type="search" value={search}
          placeholder="Find a person, number or date" aria-label="Find a person, scanner number or date"
          onChange={event => { setSearch(event.target.value); setVisibleLimit(80); }} />}>
        {previewRows.map((row, index) => (
          <Row template={`${template} 66px`} key={`${row.originalKey}-${index}`}>
            <div><strong>{row.employee || row.name || row.code}</strong><small>{row.code || '—'}{row.correctionReason ? ' · Edited for this import' : ''}</small></div>
            <span>{shortDate(row.date)}</span>
            <span>{row.checkIn || '—'}</span>
            <span>{row.checkOut || '—'}</span>
            <div>
              <Badge tone={slug(row.declaredState || row.state)}>{row.correctionReason ? 'Edited' : row.state}</Badge>
              {row.needsReview && <small className="needs-review">One punch only — confirm</small>}
            </div>
            <div>{row.employeeId ? <><strong className={locationFor(row) ? '' : 'needs-review'}>{locationLabel(locationFor(row))}</strong>
              {row.locationKey ? <small>Day override</small> : row.plannedWorkLocation && <small>Workforce schedule</small>}</> : <span>Awaiting identity</span>}</div>
            {row.employeeId
              ? <Badge tone={row.duplicate ? 'watch' : 'on-track'}>{row.duplicate ? 'Will update' : 'New'}</Badge>
              : <Badge tone="at-risk">No match</Badge>}
            <button className="icon-btn" type="button" title={`Edit imported day for ${row.employee || row.name || row.code}`}
              aria-label={`Edit date and times for ${row.employee || row.name || row.code} on ${shortDate(row.date)}`}
              onClick={() => setEditing(row.originalKey)}><PencilLine size={16} /></button>
          </Row>
        ))}
      </Table>
      {searchedRows.length > previewRows.length && <button className="secondary import-more" type="button"
        onClick={() => setVisibleLimit(current => current + 80)}>Show next {Math.min(80, searchedRows.length - previewRows.length)} days</button>}
      <p className="import-preview-note">Single-punch days and overlapping records are shown first. Edit any day's date, times, work location or review status before importing. Changes here are not saved until import.</p>
      {editingRow && <FormModal title={`Edit import day — ${editingRow.employee || editingRow.name || editingRow.code}`}
        close={() => setEditing(null)} label="Apply to preview" onSubmit={values => saveEdit(editingRow.originalKey, values)}>
        <Field name="date" label="Work date" type="date" defaultValue={editingRow.date} />
        <Field name="checkIn" label="Check in" type="time" step="1" required={false} defaultValue={editingRow.checkIn || ''} />
        <Field name="checkOut" label="Check out" type="time" step="1" required={false} defaultValue={editingRow.checkOut || ''} />
        <SelectField name="declaredState" label="How should this day read?"
          options={[["", 'Use the recorded times'], ['Absent', 'Absent'], ['On leave', 'On leave'], ['Business trip', 'Business trip']]}
          defaultValue={editingRow.declaredState || ''} />
        <SelectField name="reviewStatus" label="Review status" options={['Needs review', 'Confirmed']}
          defaultValue={editingRow.needsReview ? 'Needs review' : 'Confirmed'} />
        <SelectField name="locationKey" label="Work location for this day"
          options={[["", 'Use person’s location'], ['office', 'Head office'], ...projects.map(project => [`site:${project.id}`, project.name])]}
          defaultValue={editingRow.locationKey || ''} />
        <TextArea name="reason" label="Reason for editing this import day" defaultValue={editingRow.correctionReason || ''}
          placeholder="For example: employee went directly to site; supervisor confirmed arrival time." />
      </FormModal>}
    </>}
  </>;
}
