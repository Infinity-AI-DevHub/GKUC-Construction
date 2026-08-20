import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from './api.js';
import { Field, SelectField, TextArea, useLiveList } from './ui.jsx';

const TOGGLES = [
  ['showLogo', 'Show the company mark on the letterhead'],
  ['showSignatures', 'Include signature lines'],
  ['showAmountInWords', 'State the total in words'],
  ['showBankDetails', 'Print bank details on quotations']
];

/**
 * How every generated document looks and what standing text it carries.
 *
 * These are presentation choices GKUC will want to change without a developer — the accent
 * to match their letterhead, whether a bill of quantities is signed, the terms under each
 * type. What cannot be changed here is the attribution at the foot of every document; that
 * is a statement of who built the system, not a preference.
 */
export default function DocumentSettings({ can }) {
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useLiveList(() => api('/document-settings').then(setSettings).catch(failure => setError(failure.message)));

  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const saved = await api('/document-settings', {
        method: 'PUT',
        body: JSON.stringify({
          accentColour: form.get('accentColour'),
          paperSize: form.get('paperSize'),
          showLogo: form.get('showLogo') === 'on',
          showSignatures: form.get('showSignatures') === 'on',
          showAmountInWords: form.get('showAmountInWords') === 'on',
          showBankDetails: form.get('showBankDetails') === 'on',
          footerNote: form.get('footerNote') || '',
          quotationTerms: form.get('quotationTerms') || '',
          boqTerms: form.get('boqTerms') || '',
          invoiceTerms: form.get('invoiceTerms') || ''
        })
      });
      setSettings(saved);
      setMessage('Saved. Every document produced from here on uses these.');
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  };

  if (!settings) return <p className="empty-state">{error || 'Loading document settings…'}</p>;

  return <section className="table-panel">
    <div className="table-tools"><h2><FileText size={16} /> How generated documents look</h2></div>
    <form className="report-form" onSubmit={submit}>
      <Field name="accentColour" label="Accent colour (e.g. #16305c)" defaultValue={settings.accentColour} />
      <SelectField name="paperSize" label="Paper size" options={['A4', 'Letter']} defaultValue={settings.paperSize} />

      <div className="wide document-toggles">
        {TOGGLES.map(([name, label]) => (
          <label key={name}>
            <input type="checkbox" name={name} defaultChecked={settings[name]} />{label}
          </label>
        ))}
      </div>

      <Field name="footerNote" label="Extra footer line (optional)" wide
        defaultValue={settings.footerNote} required={false} />
      <TextArea name="quotationTerms" label="Standing terms on quotations (one per line)"
        rows={3} defaultValue={settings.quotationTerms} required={false} />
      <TextArea name="boqTerms" label="Standing terms on bills of quantities (one per line)"
        rows={3} defaultValue={settings.boqTerms} required={false} />
      <TextArea name="invoiceTerms" label="Standing terms on invoices (one per line)"
        rows={3} defaultValue={settings.invoiceTerms} required={false} />

      {error && <p className="form-error">{error}</p>}
      {message && <p className="wide form-success">{message}</p>}
      <p className="wide document-credit">
        Every document also carries “Built by Infinity AI (Pvt) Ltd, Sri Lanka” at its foot.
      </p>
      <div className="form-actions">
        <button className="primary" disabled={busy || !can.manage}>{busy ? 'Saving…' : 'Save document settings'}</button>
      </div>
    </form>
    {!can.manage && <p className="empty-state">Only an administrator can change these.</p>}
  </section>;
}
