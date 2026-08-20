import React, { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { api } from './api.js';
import { Field, TextArea } from './ui.jsx';

/**
 * The details that appear on every document sent to a client.
 *
 * Kept on a settings screen rather than in the code because a TIN, an address or a bank
 * account changes without a developer — and a quotation carrying last year's VAT number is
 * a problem for GKUC, not for us.
 */
export default function CompanySettings({ can }) {
  const [company, setCompany] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/company').then(setCompany).catch(failure => setError(failure.message)); }, []);

  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const saved = await api('/company', {
        method: 'PUT',
        body: JSON.stringify({
          name: form.get('name'),
          address: form.get('address') || '',
          telephone: form.get('telephone') || '',
          email: form.get('email') || '',
          tin: form.get('tin') || '',
          vatNumber: form.get('vatNumber') || '',
          bankDetails: form.get('bankDetails') || '',
          vatPercent: Number(form.get('vatPercent') || 0)
        })
      });
      setCompany(saved);
      setMessage('Saved. Documents produced from here on carry these details.');
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  };

  if (!company) return <p className="empty-state">{error || 'Loading company details…'}</p>;

  return <section className="table-panel">
    <div className="table-tools"><h2><Building2 size={16} /> Company details on client documents</h2></div>
    <form className="report-form" onSubmit={submit}>
      <Field name="name" label="Registered name" defaultValue={company.name} />
      <Field name="telephone" label="Telephone" defaultValue={company.telephone} required={false} />
      <Field name="email" label="Email" type="email" defaultValue={company.email} required={false} />
      <Field name="vatPercent" label="VAT rate (%)" type="number" step="0.01" defaultValue={company.vatPercent} required={false} />
      <Field name="tin" label="TIN" defaultValue={company.tin} required={false} />
      <Field name="vatNumber" label="VAT registration number" defaultValue={company.vatNumber} required={false} />
      <TextArea name="address" label="Address (one line each)" defaultValue={company.address} required={false} />
      <TextArea name="bankDetails" label="Bank details" defaultValue={company.bankDetails} required={false} />
      <p className="wide document-credit">
        Terms and the look of documents are set under <strong>Documents</strong>.
      </p>
      {error && <p className="form-error">{error}</p>}
      {message && <p className="wide form-success">{message}</p>}
      <div className="form-actions">
        <button className="primary" disabled={busy || !can.manage}>{busy ? 'Saving…' : 'Save details'}</button>
      </div>
    </form>
    {!can.manage && <p className="empty-state">Only an administrator can change these.</p>}
  </section>;
}
