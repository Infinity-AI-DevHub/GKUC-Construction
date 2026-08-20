import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, UserCog } from 'lucide-react';
import { api, del, patch, post, shortDate } from '../api.js';
import { Avatar, Badge, EmptyState, Field, FormModal, Modal, Row, Table, useLiveList } from '../ui.jsx';

/**
 * PID v3 §2.2 — "The MD opens a simple settings screen showing every role and every
 * permission as a toggle. Turning something on or off for a role takes effect immediately."
 *
 * The grid is roles across the top, permissions down the side, grouped by department.
 * Every cell is a switch; changes save as they are made, because a save button on a matrix
 * this size invites half-applied states.
 */
export default function AccessControl({ user }) {
  const [catalogue, setCatalogue] = useState(null);
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);
  const [creating, setCreating] = useState(false);
  const [delegating, setDelegating] = useState(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    const [permissions, roleRows, userRows] = await Promise.all([
      api('/access/permissions').catch(() => null),
      api('/access/roles').catch(() => []),
      api('/users').catch(() => [])
    ]);
    setCatalogue(permissions);
    setRoles(roleRows);
    setUsers(userRows);
  };
  useLiveList(load);

  if (!catalogue) return <EmptyState>You do not have access to the access-control screen.</EmptyState>;

  const toggle = async (role, permission, granted) => {
    setSaving(`${role.id}:${permission}`);
    setError('');
    /* Optimistic, because a permission matrix should feel like flipping a switch. */
    setRoles(current => current.map(row => (row.id !== role.id ? row : {
      ...row,
      permissions: granted ? [...row.permissions, permission] : row.permissions.filter(key => key !== permission)
    })));
    try {
      await patch(`/access/roles/${role.id}/permissions`, { permission, granted });
    } catch (failure) {
      setError(failure.message);
      await load();
    } finally { setSaving(''); }
  };

  const removeRole = async role => {
    if (!window.confirm(`Delete the "${role.name}" role?`)) return;
    try { await del(`/access/roles/${role.id}`); await load(); } catch (failure) { setError(failure.message); }
  };

  /*
   * Fixed track widths, not fractions.
   *
   * The heading strip and every row are separate grids inside a horizontally scrolling
   * panel. A fractional track resolves against whatever width that particular grid happens
   * to have — and the heading, holding long role names, stretched wider than the rows,
   * which hold only a switch. The two then disagreed and every switch sat left of the role
   * it belonged to. Fixed widths resolve identically no matter what a row contains.
   */
  const template = `260px repeat(${roles.length}, 128px)`;

  return <>
    <div className="access-intro">
      <div>
        <h2><ShieldCheck size={17} /> Roles and permissions</h2>
        <p>
          Every role and every permission, as a switch. A change applies to the next action the
          affected person takes — no restart, and nothing to request from Infinity AI.
        </p>
      </div>
      <button className="primary" onClick={() => setCreating(true)}><KeyRound size={16} />Create role</button>
    </div>

    {error && <p className="form-error">{error}</p>}

    <section className="table-panel access-matrix">
      <div className="table-head" style={{ gridTemplateColumns: template }}>
        <span>Permission</span>
        {roles.map(role => (
          <span key={role.id} className="access-role" title={role.description || role.name}>
            {role.name}
            <small>{role.users} {role.users === 1 ? 'person' : 'people'}</small>
            {!role.isSystem && <button onClick={() => removeRole(role)} title="Delete role">✕</button>}
          </span>
        ))}
      </div>

      {catalogue.departments.map(department => (
        <React.Fragment key={department}>
          <div className="access-group" style={{ gridTemplateColumns: template }}>
            <span>{department}</span>
          </div>
          {catalogue.permissions.filter(item => item.department === department).map(permission => (
            <div className="table-row" style={{ gridTemplateColumns: template }} key={permission.key}>
              <div><strong>{permission.label}</strong><small>{permission.key}</small></div>
              {roles.map(role => {
                const held = role.permissions.includes(permission.key);
                const busy = saving === `${role.id}:${permission.key}`;
                return (
                  <span key={role.id} className="access-cell">
                    <button
                      className={`access-toggle ${held ? 'on' : ''}`}
                      disabled={busy || (role.isSystem && held)}
                      title={role.isSystem ? 'The Managing Director always holds every permission' : role.name}
                      onClick={() => toggle(role, permission.key, !held)}
                    >
                      <i />
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        </React.Fragment>
      ))}
    </section>

    <div style={{ height: '16px' }} />

    <PeopleAndDelegation users={users} roles={roles} reload={load} onDelegate={setDelegating} currentUserId={user.id} />

    {creating && <RoleForm catalogue={catalogue} close={() => setCreating(false)} reload={load} />}
    {delegating && <DelegationPanel person={delegating} catalogue={catalogue}
      close={() => setDelegating(null)} reload={load} />}
  </>;
}

const PEOPLE_TEMPLATE = 'minmax(180px,1.3fr) minmax(180px,1.2fr) minmax(180px,1.2fr) 120px 130px';

function PeopleAndDelegation({ users, roles, reload, onDelegate, currentUserId }) {
  const setRole = async (id, roleId) => { await patch(`/access/users/${id}/role`, { roleId: Number(roleId) }); await reload(); };
  return <Table columns={['Person', 'Email', 'Role', 'Status', '']} template={PEOPLE_TEMPLATE}
    title="Who holds which role" empty="No accounts yet.">
    {users.map(person => <Row template={PEOPLE_TEMPLATE} key={person.id}>
      <div className="person"><Avatar name={person.name} /><strong>{person.name}</strong></div>
      <span>{person.email}</span>
      <select className="status-button" value={person.roleId || ''} disabled={person.id === currentUserId}
        onChange={event => setRole(person.id, event.target.value)}
        title={person.id === currentUserId ? 'You cannot change your own role' : 'Move this person to another role'}>
        {roles.map(role => <option value={role.id} key={role.id}>{role.name}</option>)}
      </select>
      <Badge tone={person.active ? 'on-track' : 'inactive'}>{person.active ? 'Active' : 'Inactive'}</Badge>
      <button className="status-button" onClick={() => onDelegate(person)}><UserCog size={13} />Delegate</button>
    </Row>)}
  </Table>;
}

/**
 * Delegation is deliberately separate from roles: it hands one authority to one person,
 * optionally until a date, without disturbing anybody else.
 */
function DelegationPanel({ person, catalogue, close, reload }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const load = () => api(`/access/users/${person.id}/permissions`).then(setState).catch(() => setState(null));
  useEffect(() => { load(); }, [person.id]);

  const add = async event => {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await post(`/access/users/${person.id}/permissions`, {
        permission: form.get('permission'),
        effect: form.get('effect'),
        reason: form.get('reason') || undefined,
        expiresAt: form.get('expiresAt') || undefined
      });
      await load();
      await reload();
      event.target.reset();
    } catch (failure) { setError(failure.message); }
  };

  const remove = async key => { await del(`/access/users/${person.id}/permissions/${key}`); await load(); await reload(); };
  const template = 'minmax(200px,1.6fr) 110px 130px 110px';

  return <Modal title={`Delegated authority — ${person.name}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Role</span><strong>{state?.user.role || person.role}</strong></div>
        <div><span>Permissions in total</span><strong>{state?.effective.length ?? '—'}</strong></div>
      </div>

      <div className="wide">
        <Table columns={['Permission', 'Effect', 'Expires', '']} template={template}
          title="Given to this person specifically" empty="Nothing delegated — this person has exactly what their role gives them.">
          {(state?.delegated || []).map(row => <Row template={template} key={row.id}>
            <div>
              <strong>{catalogue.permissions.find(item => item.key === row.permissionKey)?.label || row.permissionKey}</strong>
              <small>{row.reason || row.permissionKey}</small>
            </div>
            <Badge tone={row.effect === 'Grant' ? 'on-track' : 'at-risk'}>{row.effect}</Badge>
            <span>{row.expiresAt ? shortDate(row.expiresAt) : 'No end date'}</span>
            <button className="status-button" onClick={() => remove(row.permissionKey)}>Withdraw</button>
          </Row>)}
        </Table>
      </div>

      <form onSubmit={add} className="wide delegate-form">
        <label>Authority
          <select name="permission">
            {catalogue.permissions.map(item => (
              <option value={item.key} key={item.key}>{item.department} — {item.label}</option>
            ))}
          </select>
        </label>
        <label>Effect
          <select name="effect"><option>Grant</option><option>Revoke</option></select>
        </label>
        <label>Until <input type="date" name="expiresAt" /></label>
        <label>Reason <input name="reason" placeholder="Covering during the busy period" /></label>
        <button className="secondary">Delegate</button>
      </form>
      {error && <p className="form-error">{error}</p>}

      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
  </Modal>;
}

function RoleForm({ catalogue, close, reload }) {
  const [selected, setSelected] = useState([]);
  const toggle = key => setSelected(current =>
    (current.includes(key) ? current.filter(item => item !== key) : [...current, key]));

  return <FormModal title="Create a role" close={close} label="Create role" onSubmit={async values => {
    await post('/access/roles', {
      name: values.name,
      description: values.description || undefined,
      permissions: selected
    });
    await reload();
  }}>
    <Field name="name" label="Role name" />
    <Field name="description" label="What this role is for" required={false} />
    <div className="wide role-permission-picker">
      {catalogue.departments.map(department => (
        <div key={department}>
          <strong>{department}</strong>
          {catalogue.permissions.filter(item => item.department === department).map(item => (
            <label key={item.key}>
              <input type="checkbox" checked={selected.includes(item.key)} onChange={() => toggle(item.key)} />
              {item.label}
            </label>
          ))}
        </div>
      ))}
    </div>
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      {selected.length} permission(s) selected. You can change any of this afterwards on the matrix.
    </p>
  </FormModal>;
}
