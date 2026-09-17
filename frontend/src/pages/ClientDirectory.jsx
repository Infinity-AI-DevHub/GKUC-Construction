import React, { useEffect, useState } from 'react';
import { Building2, Mail, MapPin, Phone, UserRound } from 'lucide-react';
import { api, patch, post, rupees, shortDate } from '../api.js';
import { Badge, Field, FormModal, Row, Summary, Table, TextArea } from '../ui.jsx';

const empty = value => value || '—';

export default function ClientDirectory({ canManage, companyId }) {
  const fromPath = () => Number(window.location.pathname.match(/^\/projects\/clients\/(\d+)\/?$/)?.[1]) || null;
  const [selectedId, setSelectedId] = useState(fromPath);
  const [rows, setRows] = useState([]);
  const [archived, setArchived] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const load = () => api(`/clients?archived=${archived ? 1 : 0}`).then(setRows).catch(failure => setError(failure.message));
  const loadDetail = id => api(`/clients/${id}?companyId=${companyId}`).then(setDetail).catch(failure => setError(failure.message));
  useEffect(() => { load(); }, [archived]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else setDetail(null); }, [selectedId, companyId]);
  useEffect(() => { const onBack = () => setSelectedId(fromPath()); window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack); }, []);
  const open = id => { window.history.pushState({}, '', `/projects/clients/${id}`); setSelectedId(id); };
  const close = () => { window.history.pushState({}, '', '/projects'); setSelectedId(null); };
  const refresh = async () => { await load(); if (selectedId) await loadDetail(selectedId); };
  const changeActive = async active => {
    setError('');
    try { await patch(`/clients/${detail.id}`, { active }); await refresh(); }
    catch (failure) { setError(failure.message); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${detail.name}? This is only allowed when the client has no linked history.`)) return;
    setError('');
    try { await api(`/clients/${detail.id}`, { method: 'DELETE' }); close(); await load(); }
    catch (failure) { setError(failure.message); }
  };

  return <div className="client-directory">
    {error && <p className="form-error" role="alert">{error}</p>}
    {selectedId ? detail && <>
      <button className="secondary" type="button" onClick={close}>← All clients</button>
      <section className="client-profile-hero">
        <span className="client-profile-icon">{detail.type === 'Private' ? <UserRound size={26} /> : <Building2 size={26} />}</span>
        <div><span>{detail.type === 'Private' ? 'Private client' : 'Organisation'}</span><h2>{detail.name}</h2>
          <p>{empty(detail.city)}{detail.district ? ` · ${detail.district}` : ''}</p></div>
        <Badge tone={detail.active ? 'on-track' : 'watch'}>{detail.active ? 'Active' : 'Archived'}</Badge>
        {canManage && <div className="client-profile-actions"><button className="secondary" onClick={() => setEditing(detail)}>Edit details</button>
          <button className="secondary" onClick={() => changeActive(!detail.active)}>{detail.active ? 'Archive' : 'Restore'}</button>
          <button className="secondary" onClick={remove}>Delete</button></div>}
      </section>
      <div className="attendance-summary">
        <Summary label="Projects" value={detail.summary.projects} icon={Building2} />
        {detail.quotationsVisible && <Summary label="Quotations" value={detail.summary.quotations} icon={Building2} />}
        {detail.financialVisible && <Summary label="Invoiced" value={rupees(detail.summary.billed)} icon={Building2} />}
        {detail.financialVisible && <Summary label="Payments recorded" value={rupees(detail.summary.received)} icon={Building2} />}
      </div>
      <section className="client-contact-card"><h3>Client details</h3>
        <div><span><UserRound size={15} /> Contact: {empty(detail.contactPerson)}</span><span><Phone size={15} /> {empty(detail.phone)}{detail.alternatePhone ? ` / ${detail.alternatePhone}` : ''}</span>
          <span><Mail size={15} /> {empty(detail.email)}</span><span><MapPin size={15} /> Billing: {empty(detail.billingAddress)}</span>
          <span><MapPin size={15} /> Site: {empty(detail.siteAddress)}</span><span>City / district / province: {[detail.city, detail.district, detail.province].filter(Boolean).join(', ') || '—'}</span>
          <span>Registration: {empty(detail.registrationNumber)}</span><span>Tax number: {empty(detail.taxNumber)}</span></div>
        {detail.notes && <p>{detail.notes}</p>}
      </section>
      <ClientHistory title="Projects" columns={['Project', 'Company', 'Site', 'Stage', 'Budget']} rows={detail.projects.map(row => [row.name, row.company, row.site, row.stage, rupees(row.budget)])} />
      {detail.activityVisible && <ClientHistory title="Inquiries" columns={['Reference', 'Need', 'Status', 'Expected value']} rows={detail.inquiries.map(row => [row.reference, row.description, row.status, rupees(row.expectedValue)])} />}
      {detail.quotationsVisible && <ClientHistory title="Quotations" columns={['Reference', 'Title', 'Company', 'Status', 'Total']} rows={detail.quotations.map(row => [row.reference, row.title, row.company, row.status, rupees(row.total)])} />}
      {detail.quotationsVisible && <ClientHistory title="Tenders" columns={['Reference', 'Title', 'Company', 'Status', 'Expected value']} rows={detail.tenders.map(row => [row.reference, row.title, row.company, row.status, rupees(row.estimatedValue)])} />}
      {detail.financialVisible && <ClientHistory title="Invoices" columns={['Reference', 'Project', 'Company', 'Status', 'Payable']} rows={detail.invoices.map(row => [row.reference, row.project, row.company, row.status, rupees(row.netPayable)])} />}
      {detail.financialVisible && <ClientHistory title="Payments" columns={['Date', 'Invoice', 'Project', 'Method', 'Amount']} rows={detail.payments.map(row => [shortDate(row.receivedDate), row.invoiceReference, row.project, row.method, rupees(row.amount)])} />}
      {detail.activityVisible && <ClientHistory title="Contact activity" columns={['Date', 'Direction', 'Channel', 'Contact', 'Summary']} rows={detail.communications.map(row => [shortDate(row.happenedAt), row.direction, row.channel, row.contactPerson || '—', row.summary])} />}
    </> : <>
      <div className="client-directory-head"><div><h2>Clients</h2><p>One profile for contact details and the complete project and payment history.</p></div>
        <div><button className="secondary" onClick={() => setArchived(current => !current)}>{archived ? 'Show active' : 'Show archived'}</button>
          {canManage && <button className="primary" onClick={() => setEditing({})}>Add client</button>}</div></div>
      <div className="client-grid">{rows.map(client => <button className="client-card" key={client.id} onClick={() => open(client.id)}>
        <span className="client-card-icon">{client.type === 'Private' ? <UserRound size={20} /> : <Building2 size={20} />}</span>
        <strong>{client.name}</strong><small>{client.type} · {client.city || client.district || 'Location not recorded'}</small>
        <span>{client.contactPerson || client.phone || client.email || 'Open profile'}</span>
      </button>)}</div>
      {!rows.length && <p className="empty-state">{archived ? 'No archived clients.' : 'No clients yet. Add the first client before creating a project.'}</p>}
    </>}
    {editing && <ClientForm client={editing} close={() => setEditing(null)} saved={async client => {
      setEditing(null); await refresh(); if (!selectedId) open(client.id);
    }} />}
  </div>;
}

function ClientHistory({ title, columns, rows }) {
  const template = columns.map((_, index) => index === 0 ? 'minmax(150px,1.2fr)' : 'minmax(120px,1fr)').join(' ');
  return <Table title={title} columns={columns} template={template} empty={`No ${title.toLowerCase()} recorded for this client.`}>
    {rows.map((row, index) => <Row key={index} template={template}>{row.map((cell, cellIndex) => <span key={cellIndex}>{cell ?? '—'}</span>)}</Row>)}
  </Table>;
}

function ClientForm({ client, close, saved }) {
  const edit = Boolean(client.id);
  return <FormModal title={edit ? `Edit ${client.name}` : 'Add client'} close={close} label={edit ? 'Save client' : 'Add client'} wide
    onSubmit={async values => {
      const payload = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || null]));
      const result = edit ? await patch(`/clients/${client.id}`, payload) : await post('/clients', payload);
      await saved(result);
    }}>
    <label>Client type<select name="type" defaultValue={client.type || 'Organisation'}><option value="Organisation">Organisation</option><option value="Private">Private client</option></select></label>
    <Field name="name" label="Client name" defaultValue={client.name || ''} />
    <Field name="contactPerson" label="Primary contact person" required={false} defaultValue={client.contactPerson || ''} />
    <Field name="phone" label="Phone" required={false} defaultValue={client.phone || ''} />
    <Field name="alternatePhone" label="Alternate phone" required={false} defaultValue={client.alternatePhone || ''} />
    <Field name="email" label="Email" type="email" required={false} defaultValue={client.email || ''} />
    <Field name="billingAddress" label="Billing address" required={false} defaultValue={client.billingAddress || ''} />
    <Field name="siteAddress" label="Usual work/site address" required={false} defaultValue={client.siteAddress || ''} />
    <Field name="city" label="City" required={false} defaultValue={client.city || ''} />
    <Field name="district" label="District" required={false} defaultValue={client.district || ''} />
    <Field name="province" label="Province" required={false} defaultValue={client.province || ''} />
    <Field name="country" label="Country" required={false} defaultValue={client.country || ''} />
    <Field name="registrationNumber" label="Business/registration number" required={false} defaultValue={client.registrationNumber || ''} />
    <Field name="taxNumber" label="Tax/VAT number" required={false} defaultValue={client.taxNumber || ''} />
    <TextArea name="notes" label="Other client details" required={false} defaultValue={client.notes || ''} />
  </FormModal>;
}
