import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Field, FormModal, SelectField } from './ui.jsx';

export default function EmployeeAccountLink({ user, employeeId, close, reload }) {
  const [users, setUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selected, setSelected] = useState(user ? String(user.id) : '');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api('/users'), api('/users/employee-links')]).then(([accounts, profiles]) => {
      if (!live) return;
      setUsers(accounts); setEmployees(profiles);
      if (employeeId) setSelected(String(profiles.find(profile => Number(profile.id) === Number(employeeId))?.userId || ''));
      setReady(true);
    }).catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [employeeId, user?.id]);
  const existing = employees.filter(profile => Number(profile.userId) === Number(selected));
  return <FormModal title="Employee account link" close={close} label="Save link" onSubmit={async values => {
    if (!ready) throw new Error('Account links are not loaded yet.');
    const previous = employeeId ? employees.find(profile => Number(profile.id) === Number(employeeId)) : null;
    const accountId = Number(selected || previous?.userId);
    if (!accountId) throw new Error('Select an account.');
    if (employeeId && previous?.userId && selected && Number(previous.userId) !== accountId) {
      throw new Error('Remove the current link before selecting another account.');
    }
    const linked = employees.filter(profile => Number(profile.userId) === accountId);
    await api(`/users/${accountId}/employee-link`, { method: 'PUT', body: JSON.stringify({
      employeeId: employeeId ? (selected ? Number(employeeId) : null) : (values.employeeId ? Number(values.employeeId) : null),
      previousEmployeeIds: linked.map(profile => Number(profile.id)), reason: values.reason
    }) });
    await reload?.();
  }}>
    {error && <p className="form-error wide">{error}</p>}
    {ready && <>
      {employeeId ? <label className="wide">User account<select name="accountId" value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">No linked account</option>
        {users.map(account => <option key={account.id} value={account.id}>{account.name} ({account.email})</option>)}
      </select></label> : <>
        <p className="form-note wide">Account: {user.name}. Current profile: {existing.map(profile => `${profile.name} (${profile.code})`).join(', ') || 'None'}.</p>
        <SelectField name="employeeId" label="Employee profile" required={false} wide defaultValue={existing[0]?.id || ''}
          options={[['', 'No linked employee'], ...employees.filter(profile => profile.status === 'Active' && (!profile.userId || Number(profile.userId) === Number(user.id))).map(profile => [profile.id, `${profile.name} (${profile.code})`])]} />
      </>}
      {employeeId && existing.length > 0 && <p className="form-note wide">Currently linked to: {existing.map(profile => `${profile.name} (${profile.code})`).join(', ')}. Saving moves this account link to the selected employee.</p>}
      <p className="form-note wide">Removing or changing a link keeps both records and their history. Account permissions, payroll and employee details are unchanged.</p>
      <Field name="reason" label="Reason for change" wide minLength={3} maxLength={1000} />
    </>}
  </FormModal>;
}
