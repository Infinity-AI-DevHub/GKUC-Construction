import React, { useEffect, useState } from 'react';
import { ShieldAlert, TriangleAlert, Check, X, RefreshCw, ChevronDown, Settings2 } from 'lucide-react';
import { api, post, rupees, shortDate } from './api.js';
import { useLiveList } from './ui.jsx';
import Attachments from './Attachments.jsx';

/*
 * What the watch has found.
 *
 * Ranked, because a list of two hundred things is a list nobody reads. Each finding says
 * what was seen, what was expected and why it matters — a flag a reviewer cannot check is
 * a flag they learn to dismiss, and once that habit sets in the whole thing is decoration.
 */

const TONE = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' };
const CATEGORY_HELP = {
  Fraud: 'Patterns that money is leaving the company improperly',
  Error: 'Almost certainly a mistake rather than dishonesty',
  Control: 'A rule of the business that was not followed',
  Integrity: 'The records or documents do not hold together'
};

export default function Integrity({ can }) {
  const [findings, setFindings] = useState([]);
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('Open');
  const [category, setCategory] = useState('All');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [investigators, setInvestigators] = useState([]);

  const load = () => Promise.all([
    api(`/integrity/findings?status=${status}`).then(setFindings),
    api('/integrity/summary').then(setSummary)
  ]).catch(failure => setError(failure.message));

  useLiveList(load);
  useEffect(() => { load(); }, [status]);
  useEffect(() => { api('/integrity/investigators').then(setInvestigators).catch(() => {}); }, []);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && findings.some(row => Number(row.id) === id)) setOpen(id); }, [findings]);

  const scan = async () => {
    setBusy(true);
    setError('');
    try { await post('/integrity/scan'); await load(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };

  const shown = category === 'All' ? findings : findings.filter(one => one.category === category);

  return <div className="integrity">
    <div className="integrity-top">
      <div className="integrity-scores">
        <Score label="Needs attention now" value={summary?.totals?.urgent ?? '—'} tone="critical"
          help="Critical and high findings nobody has looked at" />
        <Score label="Open findings" value={summary?.totals?.open ?? '—'} tone="plain" />
        <Score label="Confirmed as real" value={summary?.totals?.confirmed ?? '—'} tone="high" />
        <Score label="Value under question" value={summary ? rupees(summary.totals.exposure) : '—'} tone="plain"
          help="Total of the amounts attached to open findings" />
      </div>
      <div className="integrity-actions">
        {can?.has('admin.users') && (
          <button type="button" className="secondary" onClick={() => setShowSettings(true)}>
            <Settings2 size={15} /> What counts as normal
          </button>
        )}
        <button type="button" className="primary" onClick={scan} disabled={busy}>
          <RefreshCw size={15} /> {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
    </div>

    {error && <p className="form-error">{error}</p>}

    <div className="integrity-filters">
      <div className="segments">
        {['Open', 'Confirmed', 'Resolved', 'Dismissed'].map(one => (
          <button type="button" key={one} className={status === one ? 'active' : ''}
            onClick={() => setStatus(one)}>{one}</button>
        ))}
      </div>
      <div className="integrity-cats">
        {['All', 'Fraud', 'Error', 'Control', 'Integrity'].map(one => (
          <button type="button" key={one} className={category === one ? 'is-on' : ''}
            title={CATEGORY_HELP[one] || 'Everything'}
            onClick={() => setCategory(one)}>
            {one}
            {summary && one !== 'All' && (
              <b>{summary.byCategory.find(row => row.category === one)?.count || 0}</b>
            )}
          </button>
        ))}
      </div>
    </div>

    {!shown.length && (
      <div className="integrity-clear">
        <ShieldAlert size={26} />
        <strong>Nothing {status === 'Open' ? 'outstanding' : `marked ${status.toLowerCase()}`}</strong>
        <p>The last check found no {category === 'All' ? '' : `${category.toLowerCase()} `}
          problems in the records. Checks run on their own every few hours.</p>
      </div>
    )}

    <div className="integrity-list">
      {shown.map(finding => (
        <article key={finding.id} className={`finding finding-${TONE[finding.severity]}`}>
          <button type="button" className="finding-head"
            onClick={() => setOpen(open === finding.id ? null : finding.id)}
            aria-expanded={open === finding.id}>
            <span className="finding-sev">{finding.severity}</span>
            <span className="finding-title">
              <strong>{finding.title}</strong>
              <small>
                {finding.category}
                {finding.project ? ` · ${finding.project}` : ''}
                {finding.subject ? ` · ${finding.subject}` : ''}
                {` · ${shortDate(finding.createdAt)}`}
              </small>
            </span>
            {finding.amount ? <span className="finding-amount">{rupees(finding.amount)}</span> : null}
            <ChevronDown size={17} className={open === finding.id ? 'is-open' : ''} />
          </button>

          {open === finding.id && (
            <div className="finding-body">
              <p>{finding.detail}</p>
              {finding.evidence && (
                <dl className="finding-evidence">
                  {Object.entries(finding.evidence).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())}</dt>
                      <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p><strong>Investigator:</strong> {finding.assignedTo || 'Not assigned'} · <strong>Resolution due:</strong> {finding.resolutionDueAt ? shortDate(finding.resolutionDueAt) : 'Not set'} · <strong>Financial exposure:</strong> {rupees(finding.amount || 0)}</p>
              {finding.resolutionProof && <p><strong>Resolution proof:</strong> {finding.resolutionProof}</p>}
              <Attachments ownerType="risk_finding" ownerId={finding.id} title="Evidence files" canUpload canDelete={false} />
              <FindingComments id={finding.id} />
              {finding.status === 'Open'
                ? <Review finding={finding} investigators={investigators} onDone={load} />
                : finding.status === 'Confirmed'
                  ? <Review finding={finding} investigators={investigators} onDone={load} />
                : <p className="finding-decided">
                  Marked <b>{finding.status.toLowerCase()}</b> by {finding.reviewedBy} on {shortDate(finding.reviewedAt)}
                  {finding.reviewNote ? ` — “${finding.reviewNote}”` : ''}
                </p>}
            </div>
          )}
        </article>
      ))}
    </div>

    {showSettings && <RiskSettings onClose={() => setShowSettings(false)} />}
  </div>;
}

function Score({ label, value, tone, help }) {
  return <div className={`integrity-score is-${tone}`} title={help || ''}>
    <strong>{value}</strong>
    <span>{label}</span>
  </div>;
}

function Review({ finding, investigators, onDone }) {
  const [note, setNote] = useState('');
  const [assignedUserId, setAssignedUserId] = useState(finding.assignedUserId || '');
  const [resolutionDueAt, setResolutionDueAt] = useState(finding.resolutionDueAt ? String(finding.resolutionDueAt).slice(0, 16) : '');
  const [resolutionProof, setResolutionProof] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const decide = async status => {
    setBusy(true);
    setError('');
    try {
      await post(`/integrity/findings/${finding.id}/review`, {
        status, note: note.trim() || undefined,
        assignedUserId: assignedUserId ? Number(assignedUserId) : undefined,
        resolutionDueAt: resolutionDueAt ? new Date(resolutionDueAt).toISOString() : undefined,
        resolutionProof: resolutionProof.trim() || undefined
      });
      await onDone();
    } catch (failure) { setError(failure.message); setBusy(false); }
  };

  return <div className="finding-review">
    <label>
      What did you find when you looked?
      <textarea value={note} rows={2} onChange={event => setNote(event.target.value)}
        placeholder="Checked against the delivery note — genuine bulk order for the Kaduwela pour" />
    </label>
    <label>Assign investigator
      <select value={assignedUserId} onChange={event => setAssignedUserId(event.target.value)}>
        <option value="">Choose an employee…</option>
        {investigators.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
    </label>
    <label>Resolve by <input type="datetime-local" value={resolutionDueAt} onChange={event => setResolutionDueAt(event.target.value)} /></label>
    {finding.status === 'Confirmed' && <label>Resolution proof
      <textarea value={resolutionProof} rows={2} onChange={event => setResolutionProof(event.target.value)} placeholder="Describe the correction and attach supporting evidence above" />
    </label>}
    {error && <p className="form-error">{error}</p>}
    <div className="finding-buttons">
      {finding.status === 'Open' && <button type="button" className="secondary" disabled={busy} onClick={() => decide('Dismissed')}>
        <X size={15} /> Not a problem
      </button>}
      {finding.status === 'Open' && <button type="button" className="secondary finding-confirm" disabled={busy}
        onClick={() => decide('Confirmed')}>
        <TriangleAlert size={15} /> This is real
      </button>}
      {finding.status === 'Confirmed' && <button type="button" className="primary" disabled={busy} onClick={() => decide('Resolved')}>
        <Check size={15} /> Dealt with
      </button>}
    </div>
    <p className="finding-hint">
      Saying why matters more than which button. Six months from now the note is the only thing
      that says whether this was checked or just cleared off the list.
    </p>
  </div>;
}

function FindingComments({ id }) {
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const load = () => api(`/integrity/findings/${id}/comments`).then(setRows).catch(failure => setError(failure.message));
  useEffect(() => { load(); }, [id]);
  const add = async () => {
    try { await post(`/integrity/findings/${id}/comments`, { body }); setBody(''); await load(); }
    catch (failure) { setError(failure.message); }
  };
  return <div className="finding-comments"><strong>Investigation notes</strong>
    {rows.map(row => <p key={row.id}><b>{row.author}</b> · {shortDate(row.createdAt)} — {row.body}</p>)}
    <label>Add a note<textarea value={body} onChange={event => setBody(event.target.value)} rows={2} /></label>
    {error && <p className="form-error">{error}</p>}
    <button type="button" className="secondary" onClick={add} disabled={!body.trim()}>Add note</button>
  </div>;
}

function RiskSettings({ onClose }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { api('/integrity/settings').then(setRows).catch(f => setError(f.message)); }, []);

  const save = async (key, value) => {
    try {
      await api(`/integrity/settings/${key}`, { method: 'PATCH', body: JSON.stringify({ value }) });
      setRows(await api('/integrity/settings'));
    } catch (failure) { setError(failure.message); }
  };

  return <div className="chat-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="chat-picker risk-settings" role="dialog" aria-label="What counts as normal">
      <div className="chat-picker-head">
        <strong>What counts as normal</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <p className="risk-intro">
        Every figure the checks compare against is here. A rule nobody can adjust is a rule that
        gets switched off the first time it is wrong.
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="risk-rows">
        {rows.map(row => (
          <label key={row.settingKey}>
            <span><strong>{row.label}</strong>{row.help ? <small>{row.help}</small> : null}</span>
            <input defaultValue={row.value}
              onBlur={event => { if (event.target.value !== row.value) save(row.settingKey, event.target.value); }} />
          </label>
        ))}
      </div>
    </div>
  </div>;
}
