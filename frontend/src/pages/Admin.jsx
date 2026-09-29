import React, { useEffect, useState } from 'react';
import { BellRing, Eye, EyeOff, Send } from 'lucide-react';
import { api, patch, post, slug } from '../api.js';
import { Avatar, Badge, Field, FormModal, Page, Required, Row, SelectField, Table, Tabs, useLiveList } from '../ui.jsx';
import AccessControl from './AccessControl.jsx';
import AccountPanel from '../AccountPanel.jsx';
import CompanySettings from '../CompanySettings.jsx';
import DocumentSettings from '../DocumentSettings.jsx';
import Messaging from '../Messaging.jsx';
import OptionLists from '../OptionLists.jsx';
import Integrity from '../Integrity.jsx';
import ImportCentre from '../ImportCentre.jsx';

export const TABS = ['Users', 'Access control', 'Company', 'Documents', 'Import centre', 'Notifications', 'Evening summary', 'Messages', 'Lists', 'Fraud watch', 'Audit log', 'My account'];

/** PID 2.14 and 2.13 — who can do what, and everything the system has alerted on. */
export default function Admin({ can, user, reload, companyId, initialTab = TABS[0], onTabChange }) {
  const allowed = TABS.filter(name => ({Users:can.manage,'Access control':can.roles,Company:can.companySettings,Documents:can.documentSettings,'Import centre':['clients.manage','subcontractors.manage','projects.manage','qs.boq','qs.quotation','qs.costControl','qs.retention'].some(key=>can.has(key)),Notifications:true,'Evening summary':can.audit,Messages:can.messages,Lists:can.lists,'Fraud watch':can.audit,'Audit log':can.audit,'My account':true})[name]);
  const [selectedTab, setTab] = useState(initialTab);
  const tab = allowed.includes(selectedTab) ? selectedTab : allowed[0];
  const [creating, setCreating] = useState(false);

  /* Arriving from the alert bell should land on Notifications, not the last tab used. */
  useEffect(() => { if (TABS.includes(initialTab)) setTab(initialTab); }, [initialTab]);

  /* This is the one tab set that lives in the address bar, because alerts elsewhere link
     straight to the notification centre — so choosing a tab has to update the URL too. */
  const chooseTab = next => { if(allowed.includes(next)){setTab(next); onTabChange?.(next);} };

  return <Page title="Administration" subtitle="Manage staff accounts, role-based permissions, alerts and the audit trail."
    action={tab === 'Users' && can.manage ? 'Add user' : null} onAction={() => setCreating(true)}>
    <Tabs tabs={allowed} active={tab} onChange={chooseTab} />
    {tab === 'Users' && <Users can={can} creating={creating} closeCreate={() => setCreating(false)} />}
    {tab === 'Access control' && <AccessControl user={user} />}
    {tab === 'Company' && <CompanySettings can={{...can,manage:can.companySettings}} companyId={companyId} />}
    {tab === 'Documents' && <DocumentSettings can={{...can,manage:can.documentSettings}} />}
    {tab === 'Import centre' && <ImportCentre />}
    {tab === 'Notifications' && <Notifications can={can} reload={reload} />}
    {tab === 'Evening summary' && <EveningSummary can={can} />}
    {tab === 'Messages' && (can.messages
      ? <Messaging />
      : <p className="empty-state">You do not have permission to send messages.</p>)}
    {tab === 'Lists' && <OptionLists can={can} />}
    {tab === 'Fraud watch' && (can.audit
      ? <Integrity can={can} />
      : <p className="empty-state">You do not have permission to see the fraud watch.</p>)}
    {tab === 'Audit log' && <AuditLog />}
    {tab === 'My account' && <section className="table-panel">
      <div className="table-tools"><h2>Change your password</h2></div>
      <AccountPanel />
    </section>}
  </Page>;
}

const USER_COLUMNS = ['User', 'Email', 'Role', 'Status', ''];
const USER_TEMPLATE = 'minmax(180px,1.2fr) minmax(190px,1.2fr) minmax(160px,1fr) 100px 130px';

function Users({ can, creating, closeCreate }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const load = () => api('/users').then(setRows).catch(failure => setError(failure.message));
  useLiveList(load);

  const toggle = async user => { await patch(`/users/${user.id}`, { active: !user.active }); await load(); };

  if (error && !rows.length) return <p className="empty-state">{error}</p>;
  return <>
    <Table columns={USER_COLUMNS} template={USER_TEMPLATE} title="Staff accounts">
      {rows.map(user => <Row template={USER_TEMPLATE} key={user.id}>
        <div className="person"><Avatar name={user.name} /><strong>{user.name}</strong></div>
        <span>{user.email}</span>
        <span>{user.role}</span>
        <Badge tone={user.active ? 'on-track' : 'inactive'}>{user.active ? 'Active' : 'Inactive'}</Badge>
        {can.manage
          ? <button className="status-button" onClick={() => toggle(user)}>{user.active ? 'Deactivate' : 'Reactivate'}</button>
          : <span>—</span>}
      </Row>)}
    </Table>
    {creating && <UserForm close={closeCreate} reload={load} />}
  </>;
}

const NOTIFICATION_TEMPLATE = '100px minmax(220px,1.5fr) minmax(160px,1fr) 130px 135px';
const casePath = row => {
  if(row.referenceType==='alert_case')return `/administration/notifications?case=${row.referenceId}`;
  if(row.referenceType==='project')return `/projects/${encodeURIComponent(row.referenceId)}`;
  if(row.referenceType==='employee')return `/people/${encodeURIComponent(row.referenceId)}`;
  const section={task:'/tasks',fleet:'/fleet/vehicles',vehicle:'/fleet/vehicles',vehicle_document:'/fleet/compliance',
    material:'/materials',equipment_assignment:'/materials',employee_document:'/people/employees',
    insurance:'/people/insurance',milestone:'/projects/milestones',supplier_invoice:'/finance/supplier-invoices',
    operating_bill:'/finance/bills',credit_card_statement:'/finance/credit-cards',client_invoice:'/finance/invoices',
    invoice:'/finance/invoices',cheque:'/finance/cheques',received_cheque:'/finance/cheques',bond:'/finance/bonds',
    retention:'/quantity-surveying/retentions',tender:'/quantity-surveying/tenders',
    subcontract_quotation:'/projects',purchase_request:'/materials'}[row.referenceType];
  return section ? `${section}?record=${encodeURIComponent(row.referenceId)}` : null;
};

function Notifications({ can, reload }) {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [assignees,setAssignees]=useState([]);
  const [note,setNote]=useState('');
  const [evidence,setEvidence]=useState('');
  const [until,setUntil]=useState('');
  const [assigneeId,setAssigneeId]=useState('');
  const [error,setError]=useState('');
  const load = () => api('/notification-cases').then(setRows).catch(failure => setError(failure.message));
  useLiveList(load);
  const refresh = async () => { await load(); await reload?.(); };
  const openCase=async row=>{
    setError('');setNote('');setEvidence('');setUntil('');setAssigneeId('');
    try {setSelected(await api(`/notification-cases/${row.id}`));
      setAssignees(await api(`/notification-cases/assignees?caseId=${row.id}`));}
    catch(failure){setError(failure.message);}
  };
  useEffect(()=>{
    const id=Number(new URLSearchParams(window.location.search).get('case'));
    if(id&&rows.some(row=>Number(row.id)===id)&&Number(selected?.id)!==id) openCase({id});
  },[rows]);
  const act=async(action,extra={})=>{
    try{setError('');const updated=await post(`/notification-cases/${selected.id}/actions`,{action,note:note.trim(),evidence:evidence.trim(),...extra});
      setSelected(await api(`/notification-cases/${updated.id}`));setNote('');setEvidence('');setUntil('');await refresh();}
    catch(failure){setError(failure.message);}
  };
  const rescan = async () => { await post('/notifications/scan'); await refresh(); };

  return <>
    <div className="toolbar" style={{ marginBottom: '14px' }}>
      <p className="form-note">Reading a case does not resolve it. Assign an owner, record the action taken and attach an evidence reference before resolving.</p>
      {can.has('admin.notifications') && <button className="secondary" onClick={rescan}><BellRing size={15} /> Run deadline scan</button>}
    </div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <Table columns={['Risk', 'Case', 'Owner', 'Response due', 'State']} template={NOTIFICATION_TEMPLATE}
      title="Notification centre" empty="Nothing needs attention.">
      {rows.map(row => <Row template={NOTIFICATION_TEMPLATE} key={row.id}
        onClick={() => openCase(row)}>
        <Badge tone={row.severity === 'Critical' ? 'at-risk' : row.severity === 'Warning' ? 'watch' : 'low'}>{row.severity}</Badge>
        <div><strong>{row.title}</strong><small>#{row.id} · Seen {row.occurrenceCount} time(s) · {row.message}</small></div>
        <span>{row.assignedTo||'Unassigned'}</span>
        <span>{new Date(row.dueAt).toLocaleString('en-GB')}</span>
        <Badge tone={slug(row.state)}>{row.state}{row.escalatedAt?' · Escalated':''}</Badge>
      </Row>)}
    </Table>
    {selected&&<section className="table-panel" style={{marginTop:16,padding:20}} aria-label={`Case ${selected.id}`}>
      <div className="table-tools"><div><h2>Case #{selected.id} · {selected.title}</h2><p>{selected.message}</p></div>
        <button className="secondary" onClick={()=>setSelected(null)}>Close</button></div>
      <p><strong>State:</strong> {selected.state} · <strong>Owner:</strong> {selected.assignedTo||'Unassigned'} · <strong>First seen:</strong> {new Date(selected.firstSeenAt).toLocaleString('en-GB')}</p>
      <p><strong>Response due:</strong> {new Date(selected.dueAt).toLocaleString('en-GB')}{selected.snoozedUntil?` · Snoozed until ${new Date(selected.snoozedUntil).toLocaleString('en-GB')}`:''}</p>
      {casePath(selected)&&<p><a href={casePath(selected)}>Open affected record →</a></p>}
      {selected.state!=='Resolved'&&<div className="form-grid">
        <div className="form-field"><label htmlFor="case-assignee">Assign to</label><select id="case-assignee" value={assigneeId} onChange={event=>setAssigneeId(event.target.value)}><option value="">Myself</option>{assignees.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select><button className="secondary" onClick={()=>act('assign',{assigneeId:assigneeId?Number(assigneeId):undefined})}>Assign</button></div>
        <div className="form-field"><label htmlFor="case-snooze">Snooze until</label><input id="case-snooze" type="datetime-local" value={until} onChange={event=>setUntil(event.target.value)} /><button className="secondary" onClick={()=>act('snooze',{until:until?new Date(until).toISOString():undefined})}>Snooze</button></div>
        <div className="form-field"><label htmlFor="case-note">Action note / resolution</label><textarea id="case-note" value={note} onChange={event=>setNote(event.target.value)} /></div>
        <div className="form-field"><label htmlFor="case-evidence">Evidence reference (file link, document number or URL)</label><input id="case-evidence" value={evidence} onChange={event=>setEvidence(event.target.value)} /></div>
        <div className="toolbar"><button className="secondary" disabled={selected.state!=='New'} onClick={()=>act('acknowledge')}>Acknowledge</button><button className="secondary" disabled={!['Acknowledged','Assigned'].includes(selected.state)} onClick={()=>act('start')}>Start work</button><button className="secondary" disabled={!note.trim()} onClick={()=>act('note')}>Add note</button><button className="primary" disabled={!note.trim()||!evidence.trim()} onClick={()=>act('resolve')}>Resolve with evidence</button></div>
      </div>}
      <h3>Case history</h3><div className="activity-list">{selected.events?.map(event=><p key={event.id}><strong>{event.action}</strong> · {event.actor||'System'} · {new Date(event.createdAt).toLocaleString('en-GB')}{event.note?` — ${event.note}`:''}{event.evidence?` · Evidence: ${event.evidence}`:''}</p>)}</div>
    </section>}
  </>;
}

const AUDIT_TEMPLATE = '190px minmax(150px,1fr) 140px minmax(150px,1fr) 130px';

/**
 * What tonight's message to the MD will say.
 *
 * Shown as the message rather than as a dashboard on purpose: it goes out as a block of
 * WhatsApp text, and the only way to know whether that text reads well is to read it.
 */
function EveningSummary({ can }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  const load = () => api('/summary/preview')
    .then(result => { setPreview(result); setError(''); })
    .catch(failure => { setPreview(null); setError(failure.message); });
  useLiveList(load);

  const sendNow = async () => {
    setSending(true);
    setError('');
    try { setSent(await post('/summary/send')); }
    catch (failure) { setError(failure.message); }
    finally { setSending(false); }
  };

  return <section className="table-panel">
    <div className="table-tools">
      <h2>Evening summary</h2>
      {can.audit && <button className="secondary" disabled={sending} onClick={sendNow}>
        <Send size={14} />{sending ? 'Sending…' : 'Send it now'}
      </button>}
    </div>
    <div className="summary-preview">
      <p className="risk-intro">
        This goes out each evening to everyone holding the daily summary permission. Nobody
        is sent anything until a WhatsApp number is on their account.
      </p>
      {error && <p className="form-error">{error}</p>}
      {sent && <p className="form-note">
        Sent to {sent.sent.length} recipient{sent.sent.length === 1 ? '' : 's'}.
      </p>}
      {preview ? <pre className="summary-text">{preview.text}</pre>
        : !error && <p className="empty-state">Building tonight's message…</p>}
    </div>
  </section>;
}

function AuditLog() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useLiveList(() => api('/audit').then(setRows).catch(failure => setError(failure.message)));
  if (error) return <p className="empty-state">{error}</p>;
  return <Table columns={['Date and time', 'User', 'Action', 'Record', 'From']} template={AUDIT_TEMPLATE}
    title="Immutable audit trail" empty="No activity recorded yet.">
    {rows.map(entry => <Row template={AUDIT_TEMPLATE} key={entry.id}>
      <span>{new Date(entry.createdAt).toLocaleString('en-GB')}</span>
      <strong>{entry.user || 'System'}</strong>
      <Badge tone={slug(entry.action)}>{entry.action}</Badge>
      <span>{entry.entity} #{entry.entityId}</span>
      <span>{entry.ip || '—'}</span>
    </Row>)}
  </Table>;
}

function UserForm({ close, reload }) {
  const [roles, setRoles] = useState([]);
  const [employees, setEmployees] = useState([]);
  useEffect(() => { api('/users/employee-options').then(setEmployees).catch(() => setEmployees([])); }, []);
  useEffect(() => { api('/users/roles').then(setRoles).catch(() => setRoles([])); }, []);
  return <FormModal title="Add user" close={close} label="Create user" onSubmit={async values => {
    await post('/users', {
      name: values.name, email: values.email, password: values.password, roleId: Number(values.roleId),
      ...(values.employeeId ? { employeeId: Number(values.employeeId) } : {}),
      ...(values.employmentStartDate ? { employmentStartDate: values.employmentStartDate } : {})
    });
    await reload();
  }}>
    <p className="form-note wide">Creates system access and an employee profile. Select an existing employee to avoid creating another profile. For a new employee, HR should complete their personal details and pay settings in People before payroll.</p>
    <SelectField name="employeeId" label="Employee profile" required={false} wide options={[
      ['', 'Create a new profile (or match the same email)'], ...employees.map(employee => [employee.id, `${employee.name} — ${employee.code}`])
    ]} />
    <Field name="name" label="Full name" />
    <Field name="email" label="Email" type="email" />
    <Field name="employmentStartDate" label="Employment start date (new profile only)" type="date" required={false} />
    <TemporaryPasswordField />
    <SelectField name="roleId" label="Role" options={roles.map(role => [role.id, role.name])} />
  </FormModal>;
}

function TemporaryPasswordField() {
  const [visible, setVisible] = useState(false);
  return <label>Temporary password (12+ characters)<Required />
    <span className="password-field">
      <input name="password" type={visible ? 'text' : 'password'} required minLength={12}
        autoComplete="new-password" />
      <button type="button" onClick={() => setVisible(value => !value)}
        title={visible ? 'Hide temporary password' : 'Show temporary password'}
        aria-label={visible ? 'Hide temporary password' : 'Show temporary password'}
        aria-pressed={visible}>
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </span>
  </label>;
}
