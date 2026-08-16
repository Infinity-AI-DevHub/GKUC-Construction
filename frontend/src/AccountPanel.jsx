import React, { useState } from 'react';
import { post } from './api.js';
import { Field } from './ui.jsx';

/**
 * Changing your own password. Everyone can do this regardless of their permissions, so it
 * lives here rather than on the Administration page — most people cannot open that page at
 * all, and being unable to change your own password because you are not an administrator
 * would be an odd thing to tell someone.
 *
 * Shown as a panel on the Administration page and as a dialog from the account menu.
 */
export default function AccountPanel({ onDone }) {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirm')) {
      setError('The new passwords do not match');
      setBusy(false);
      return;
    }
    try {
      await post('/auth/password', { current: form.get('current'), password: form.get('password') });
      setMessage('Password changed. Any other sessions have been signed out.');
      event.target.reset();
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  };

  return <form className="report-form" onSubmit={submit}>
    <Field name="current" label="Current password" type="password" />
    <div />
    <Field name="password" label="New password (10+ characters)" type="password" />
    <Field name="confirm" label="Confirm new password" type="password" />
    {error && <p className="form-error">{error}</p>}
    {message && <p className="wide form-success">{message}</p>}
    <div className="form-actions">
      {onDone && <button type="button" className="secondary" onClick={onDone}>Close</button>}
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
    </div>
  </form>;
}
