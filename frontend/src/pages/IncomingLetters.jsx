import React, { useEffect, useState } from 'react';
import { api, patch, post, shortDate, todayInput } from '../api.js';
import { Badge, Modal } from '../ui.jsx';
import Attachments from '../Attachments.jsx';

const STATUSES = ['Received', 'Assigned', 'In progress', 'Responded', 'Closed'];
const blank = () => ({ receivedDate: todayInput(), sender: '', senderAddress: '', letterReference: '', subject: '', description: '', documentType: 'Letter', clientId: '', projectId: '', assignedEmployeeId: '', assignedDepartment: '', status: 'Received' });

export default function IncomingLetters({ data, can }) {
  const [letters, setLetters] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [options, setOptions] = useState({ clients: [], projects: [], employees: [] });
  const load = () => api('/inquiries/letters').then(setLetters).catch(e => setError(e.message));
  useEffect(() => { load(); api('/inquiries/letters/options').then(setOptions).catch(e => setError(e.message)); }, []);
  const {clients,projects,employees} = options;
  const visible = letters.filter(letter => (!status || letter.status === status) &&
    [letter.sender, letter.subject, letter.letterReference, letter.client, letter.project].some(value => String(value || '').toLowerCase().includes(search.toLowerCase())));
  const save = async event => {
    event.preventDefault(); setError('');
    const payload = { ...form, clientId: form.clientId ? Number(form.clientId) : null,
      projectId: form.projectId ? Number(form.projectId) : null,
      assignedEmployeeId: form.assignedEmployeeId ? Number(form.assignedEmployeeId) : null };
    try {
      const row = form.id ? await patch(`/inquiries/letters/${form.id}`, payload) : await post('/inquiries/letters', payload);
      setForm(null); setSelected(row); await load();
    } catch (failure) { setError(failure.message); }
  };
  const field = (name, label, type = 'text') => <label>{label}<input type={type} value={form[name] || ''} onChange={event => setForm({ ...form, [name]: event.target.value })} required={['receivedDate','sender','subject'].includes(name)} /></label>;
  const select = (name, label, choices) => <label>{label}<select value={form[name] || ''} onChange={event => setForm({ ...form, [name]: event.target.value })}><option value="">None</option>{choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <>
    <section className="panel">
      <div className="panel-title"><div><h2>Incoming-letter register</h2><p>Letters and bank statements, including correspondence unrelated to an enquiry or project.</p></div>{can.enquiries && <button className="primary" onClick={() => setForm(blank())}>Register incoming letter</button>}</div>
      <div className="row-actions"><input aria-label="Search incoming letters" placeholder="Search sender, subject or reference" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Filter processing status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{STATUSES.map(value => <option key={value}>{value}</option>)}</select></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="table-scroll"><table className="data-table"><thead><tr><th>Received</th><th>Sender / reference</th><th>Subject</th><th>Assigned to</th><th>Status</th><th></th></tr></thead><tbody>{visible.map(letter => <tr key={letter.id}><td>{shortDate(letter.receivedDate)}</td><td><strong>{letter.sender}</strong><br /><small>{letter.letterReference || 'No reference'}</small></td><td>{letter.subject}<br /><small>{letter.project || letter.client || 'General correspondence'}</small></td><td>{letter.assignedEmployee || letter.assignedDepartment || 'Unassigned'}</td><td><Badge>{letter.status}</Badge></td><td><button className="secondary" onClick={() => setSelected(letter)}>Open</button></td></tr>)}</tbody></table>{!visible.length && <p className="empty-state">No incoming letters match this view.</p>}</div>
    </section>
    {selected && <Modal title={selected.subject} close={() => setSelected(null)}><div className="report-form"><p><strong>Received:</strong> {shortDate(selected.receivedDate)} · <strong>Type:</strong> {selected.documentType} · <strong>Status:</strong> {selected.status}</p><p><strong>From:</strong> {selected.sender}<br />{selected.senderAddress || 'Address not recorded'}<br /><strong>Reference:</strong> {selected.letterReference || 'Not supplied'}</p><p><strong>Assigned:</strong> {selected.assignedEmployee || selected.assignedDepartment || 'Unassigned'}<br /><strong>Related to:</strong> {selected.project || selected.client || 'General correspondence'}</p><p className="wide">{selected.description || 'No processing notes yet.'}</p><div className="wide"><Attachments ownerType="incoming_letter" ownerId={selected.id} title="Letter or bank-statement file" canUpload={can.enquiries} canDelete={can.enquiries} /></div>{can.enquiries && <button className="secondary" onClick={() => { setForm(selected); setSelected(null); }}>Edit / update status</button>}</div></Modal>}
    {form && <Modal title={form.id ? 'Update incoming letter' : 'Register incoming letter'} close={() => setForm(null)}><form className="report-form" onSubmit={save}>{field('receivedDate','Date received','date')}{select('documentType','Document type',['Letter','Bank statement','Other'].map(value => [value,value]))}{field('sender','Sender')}{field('letterReference','Letter / reference number')}{field('senderAddress','Sender address')}{field('subject','Subject')}{select('clientId','Related client (optional)',clients.map(row => [row.id,row.name]))}{select('projectId','Related project (optional)',projects.map(row => [row.id,row.name]))}{select('assignedEmployeeId','Assigned employee',employees.map(row => [row.id,row.name]))}{field('assignedDepartment','Assigned department')}{select('status','Processing status',STATUSES.map(value => [value,value]))}<label className="wide">Processing notes<textarea value={form.description || ''} onChange={event => setForm({ ...form, description: event.target.value })} /></label><p className="form-note wide">Save first, then attach the scanned letter or bank statement from its record.</p>{error && <p className="form-error wide">{error}</p>}<div className="form-actions wide"><button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button><button className="primary">Save letter</button></div></form></Modal>}
  </>;
}
