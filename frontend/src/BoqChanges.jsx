import React, { useEffect, useState } from 'react';
import { ShieldCheck, Clock, Check, X } from 'lucide-react';
import { api, rupees, onDataChanged } from './api.js';

/*
 * Changes waiting on approval.
 *
 * Once a bill of quantities is approved it is what quotations, invoices and the project
 * budget are built on, so it stops being editable directly. A change is proposed with a
 * reason and applies only when somebody holding the approval permission agrees — the MD
 * by default, or whoever they have given it to.
 */
export default function BoqChanges({ can, reload }) {
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = () => api('/boq/changes/pending').then(setPending).catch(() => setPending([]));
  useEffect(() => { load(); return onDataChanged(load); }, []);

  const decide = async (id, status) => {
    setError('');
    setBusy(id);
    try {
      await api(`/boq/changes/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await load();
      reload?.();
    } catch (failure) { setError(failure.message); } finally { setBusy(null); }
  };

  if (!pending.length) return null;

  const describe = request => {
    const before = request.beforeJson || {};
    const after = request.afterJson || {};
    if (request.action === 'Remove') return `Remove “${before.description}”`;
    if (request.action === 'Add') return `Add “${after.description}”`;
    const changes = Object.keys(after)
      .filter(key => String(after[key]) !== String(before[key] ?? ''))
      .map(key => `${key}: ${format(key, before[key])} → ${format(key, after[key])}`);
    return `${before.description} — ${changes.join(', ') || 'no visible change'}`;
  };

  const format = (key, value) => (key === 'rate' || key === 'amount' ? rupees(value || 0) : String(value ?? '—'));

  return <section className="panel boq-changes">
    <div className="panel-title">
      <h2>Changes waiting for approval</h2>
      <span className="badge watch">{pending.length}</span>
    </div>
    {error && <p className="form-error boq-review-error">{error}</p>}
    <div className="boq-change-list">
      {pending.map(request => (
        <div className="boq-change" key={request.id}>
          <span className="boq-change-icon"><Clock size={16} /></span>
          <div className="boq-change-body">
            <strong>{request.reference} — {describe(request)}</strong>
            <small>{request.requestedBy} · {request.reason}</small>
          </div>
          {can?.has('qs.boqAmend') ? (
            <div className="boq-change-actions">
              <button type="button" className="secondary" disabled={busy === request.id}
                onClick={() => decide(request.id, 'Rejected')}><X size={15} /> Reject</button>
              <button type="button" className="primary" disabled={busy === request.id}
                onClick={() => decide(request.id, 'Approved')}><Check size={15} /> Approve</button>
            </div>
          ) : (
            <span className="boq-change-waiting"><ShieldCheck size={14} /> Waiting for approval</span>
          )}
        </div>
      ))}
    </div>
  </section>;
}
