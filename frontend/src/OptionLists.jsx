import React, { useState } from 'react';
import { Plus, Lock, EyeOff, Eye, Trash2, Pencil, Check, X } from 'lucide-react';
import { api, post, del } from './api.js';
import { useOptionLists, refreshOptions } from './options.js';

/*
 * The lists behind every dropdown in the system.
 *
 * These are the company's own classifications — kinds of cost, kinds of leave, the papers
 * a vehicle carries. They change as the business does, and holding them here means that
 * happens without anybody touching the software.
 *
 * Workflow statuses are deliberately absent. The system decides what to do by reading
 * them, so a status somebody invented would be a value nothing knows how to act on.
 */
export default function OptionLists({ can }) {
  const [lists, reload] = useOptionLists();
  const [error, setError] = useState('');
  const mayEdit = can?.has('admin.lists');

  const departments = [...new Set(lists.map(list => list.department))];

  const run = async action => {
    setError('');
    try { await action(); await refreshOptions(); await reload(); }
    catch (failure) { setError(failure.message); }
  };

  if (!lists.length) return <p className="empty-state">Loading the lists…</p>;

  return <div className="option-lists">
    <p className="option-intro">
      These are the choices offered in dropdowns across the system. Add what the company
      needs, rename anything worded awkwardly, and turn off what is no longer used.
      {mayEdit ? '' : ' You can see them here, but changing them needs permission from the Managing Director.'}
    </p>
    {error && <p className="form-error">{error}</p>}

    {departments.map(department => (
      <section className="panel" key={department}>
        <div className="panel-title"><h2>{department}</h2></div>
        {lists.filter(list => list.department === department).map(list => (
          <ListEditor key={list.listKey} list={list} mayEdit={mayEdit} run={run} />
        ))}
      </section>
    ))}

    <div className="option-note">
      <Lock size={15} />
      <div>
        <strong>Why statuses are not here</strong>
        <p>
          Words like <em>Draft</em>, <em>Approved</em> and <em>Pending</em> are not just
          labels — the system reads them to decide what happens next. An invoice that is
          Approved can be paid; a BOQ that is Approved locks. A status nobody wrote code
          for would leave a record stuck in a state nothing could move it out of, so those
          stay fixed.
        </p>
      </div>
    </div>
  </div>;
}

function ListEditor({ list, mayEdit, run }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  const add = async () => {
    const value = draft.trim();
    if (!value) return;
    await run(() => post(`/options/${list.listKey}`, { value }));
    setDraft('');
    setAdding(false);
  };

  const saveEdit = async option => {
    const value = editValue.trim();
    setEditingId(null);
    if (!value || value === option.value) return;
    await run(() => api(`/options/${list.listKey}/${option.id}`, {
      method: 'PATCH', body: JSON.stringify({ value })
    }));
  };

  return <div className="option-list">
    <div className="option-list-head">
      <div>
        <strong>{list.label}</strong>
        <small>{list.description}</small>
      </div>
      {mayEdit && !adding && (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add
        </button>
      )}
    </div>

    <div className="option-chips">
      {list.values.map(option => (
        <span key={option.id} className={`option-chip${option.active ? '' : ' is-off'}`}>
          {editingId === option.id ? (
            <input autoFocus value={editValue}
              onChange={event => setEditValue(event.target.value)}
              onBlur={() => saveEdit(option)}
              onKeyDown={event => {
                if (event.key === 'Enter') event.target.blur();
                if (event.key === 'Escape') setEditingId(null);
              }} />
          ) : (
            <>
              <span className="option-name">{option.value}</span>
              {option.locked && <Lock size={11} aria-label="The system depends on this name" />}
              {mayEdit && !option.locked && (
                <span className="option-tools">
                  <button type="button" title="Rename"
                    onClick={() => { setEditingId(option.id); setEditValue(option.value); }}>
                    <Pencil size={12} />
                  </button>
                  <button type="button" title={option.active ? 'Stop offering this' : 'Offer this again'}
                    onClick={() => run(() => api(`/options/${list.listKey}/${option.id}`, {
                      method: 'PATCH', body: JSON.stringify({ active: !option.active })
                    }))}>
                    {option.active ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  {!option.isSystem && (
                    <button type="button" title="Delete"
                      onClick={() => run(() => del(`/options/${list.listKey}/${option.id}`))}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              )}
            </>
          )}
        </span>
      ))}

      {adding && (
        <span className="option-chip is-new">
          <input autoFocus value={draft} placeholder="New option"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') add();
              if (event.key === 'Escape') { setAdding(false); setDraft(''); }
            }} />
          <button type="button" onClick={add} title="Add"><Check size={13} /></button>
          <button type="button" onClick={() => { setAdding(false); setDraft(''); }} title="Cancel">
            <X size={13} />
          </button>
        </span>
      )}
    </div>
  </div>;
}
