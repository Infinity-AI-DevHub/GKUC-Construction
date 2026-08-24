import React, { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { api, patch, post, slug } from '../api.js';
import { Avatar, Badge, Field, FormModal, Page, Row, SelectField, Table, Tabs, useLiveList } from '../ui.jsx';
import AccessControl from './AccessControl.jsx';
import AccountPanel from '../AccountPanel.jsx';
import CompanySettings from '../CompanySettings.jsx';
import DocumentSettings from '../DocumentSettings.jsx';
import DocumentDesigner from '../DocumentDesigner.jsx';
import Messaging from '../Messaging.jsx';
import OptionLists from '../OptionLists.jsx';

export const TABS = ['Users', 'Access control', 'Company', 'Documents', 'Designer', 'Notifications', 'Messages', 'Lists', 'Audit log', 'My account'];

/** PID 2.14 and 2.13 — who can do what, and everything the system has alerted on. */
export default function Admin({ can, user, reload, initialTab = TABS[0], onTabChange }) {
  const [tab, setTab] = useState(TABS.includes(initialTab) ? initialTab : TABS[0]);
  const [creating, setCreating] = useState(false);

  /* Arriving from the alert bell should land on Notifications, not the last tab used. */
  useEffect(() => { if (TABS.includes(initialTab)) setTab(initialTab); }, [initialTab]);

  /* This is the one tab set that lives in the address bar, because alerts elsewhere link
     straight to the notification centre — so choosing a tab has to update the URL too. */
  const chooseTab = next => { setTab(next); onTabChange?.(next); };

  return <Page title="Administration" subtitle="Manage staff accounts, role-based permissions, alerts and the audit trail."
    action={tab === 'Users' && can.manage ? 'Add user' : null} onAction={() => setCreating(true)}>
    <Tabs tabs={TABS} active={tab} onChange={chooseTab} />
    {tab === 'Users' && <Users can={can} creating={creating} closeCreate={() => setCreating(false)} />}
    {tab === 'Access control' && <AccessControl user={user} />}
    {tab === 'Company' && <CompanySettings can={can} />}
    {tab === 'Documents' && <DocumentSettings can={can} />}
    {tab === 'Designer' && <DocumentDesigner can={can} />}
    {tab === 'Notifications' && <Notifications can={can} reload={reload} />}
    {tab === 'Messages' && (can.messages
      ? <Messaging />
      : <p className="empty-state">You do not have permission to send messages.</p>)}
    {tab === 'Lists' && <OptionLists can={can} />}
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

const NOTIFICATION_TEMPLATE = '110px minmax(220px,1.4fr) minmax(240px,2fr) 160px 110px';

function Notifications({ can, reload }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/notifications').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  /* The bell in the top bar counts the same alerts, but from the bootstrap data rather
     than from this list — so marking them read here has to refresh that too, or the dot
     stays lit over a centre that has just been emptied. */
  const refresh = async () => { await load(); await reload?.(); };

  const markRead = async id => { await post(`/notifications/${id}/read`); await refresh(); };
  const rescan = async () => { await post('/notifications/scan'); await refresh(); };
  const markAll = async () => { await post('/notifications/read-all'); await refresh(); };

  return <>
    <div className="toolbar" style={{ marginBottom: '14px' }}>
      <button className="secondary" onClick={markAll}>Mark all read</button>
      {can.manage && <button className="secondary" onClick={rescan}><BellRing size={15} /> Run deadline scan</button>}
    </div>
    <Table columns={['Severity', 'Alert', 'Detail', 'Raised', 'Status']} template={NOTIFICATION_TEMPLATE}
      title="Notification centre" empty="Nothing needs attention.">
      {rows.map(row => <Row template={NOTIFICATION_TEMPLATE} key={row.id}
        onClick={row.status !== 'Read' ? () => markRead(row.id) : undefined}>
        <Badge tone={row.severity === 'Critical' ? 'at-risk' : row.severity === 'Warning' ? 'watch' : 'low'}>{row.severity}</Badge>
        <strong>{row.title}</strong>
        <span>{row.message}</span>
        <span>{new Date(row.createdAt).toLocaleString('en-GB')}</span>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
      </Row>)}
    </Table>
  </>;
}

const AUDIT_TEMPLATE = '190px minmax(150px,1fr) 140px minmax(150px,1fr) 130px';

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
  useEffect(() => { api('/users/roles').then(setRoles).catch(() => setRoles([])); }, []);
  return <FormModal title="Add user" close={close} label="Create user" onSubmit={async values => {
    await post('/users', {
      name: values.name, email: values.email, password: values.password, roleId: Number(values.roleId)
    });
    await reload();
  }}>
    <Field name="name" label="Full name" />
    <Field name="email" label="Email" type="email" />
    <Field name="password" label="Temporary password (10+ characters)" type="password" />
    <SelectField name="roleId" label="Role" options={roles.map(role => [role.id, role.name])} />
  </FormModal>;
}
