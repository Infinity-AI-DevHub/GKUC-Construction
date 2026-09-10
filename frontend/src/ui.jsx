import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Plus, X } from 'lucide-react';
import { initials, onDataChanged, slug } from './api.js';

/**
 * Loads a panel's own list, and loads it again whenever anything in the system changes.
 *
 * Panels fetch their own rows, so without this a record created on the same screen is saved
 * but not shown until the page is reloaded — the create appears to have done nothing.
 */
export function useLiveList(load) {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    latest.current();
    return onDataChanged(() => latest.current());
  }, []);
}

export function Badge({ children, tone }) {
  return <span className={`badge ${tone || slug(children)}`}>{children}</span>;
}

export function Avatar({ name }) {
  return <span className="avatar">{initials(name)}</span>;
}

export function Progress({ value }) {
  return <div className="progress"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export function Metric({ icon: Icon, label, value, detail, tone }) {
  return <div className="metric">
    <span className={`metric-icon ${tone}`}><Icon size={20} /></span>
    <div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div>
  </div>;
}

export function Summary({ label, value, icon: Icon }) {
  return <div className="summary"><Icon size={19} /><div><strong>{value}</strong><span>{label}</span></div></div>;
}

export function PanelTitle({ title, action, onClick }) {
  return <div className="panel-title"><h2>{title}</h2>{onClick && <button onClick={onClick}>{action}<ChevronRight size={15} /></button>}</div>;
}

export function Page({ title, subtitle, action, children, onAction }) {
  return <>
    <div className="page-heading">
      <div><h1>{title}</h1><p>{subtitle}</p></div>
      {action && onAction && <button className="primary" onClick={onAction}><Plus size={17} />{action}</button>}
    </div>
    {children}
  </>;
}

/** Sub-navigation inside a module, using the same segmented control as the task filters. */
export function Tabs({ tabs, active, onChange }) {
  return <div className="toolbar"><div className="segments">
    {tabs.map(tab => <button className={active === tab ? 'active' : ''} onClick={() => onChange(tab)} key={tab}>{tab}</button>)}
  </div></div>;
}

/**
 * The tabs of a module that this person can actually use.
 *
 * A module is opened by anyone holding any one of its permissions, so the tabs inside it
 * cannot all be assumed usable: a site supervisor reaches People to mark attendance and has
 * no business on the payroll, and a store keeper reaches Fleet for the tools and not for the
 * lorries. Each tab names the permissions the server will accept for it, and only the tabs
 * that match are offered — so nothing on screen is a door into a refusal.
 *
 * `tabs` is a list of [name, [permission, ...]]; a tab with no permissions is open to all.
 */
export const allowedTabs = (tabs, can) => tabs
  .filter(([, keys]) => !keys || !keys.length || keys.some(key => can.has(key)))
  .map(([name]) => name);

export function Modal({ title, close, children, wide = false }) {
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div className={wide ? 'modal modal-wide' : 'modal'}>
      <div className="modal-title"><h2>{title}</h2><button className="icon-btn" onClick={close}><X size={18} /></button></div>
      {children}
    </div>
  </div>;
}

export function EntityForm({ onSubmit, error, children }) {
  return <form onSubmit={onSubmit} className="report-form">{children}{error && <p className="form-error">{error}</p>}</form>;
}

/**
 * The mark that says a field must be filled in.
 *
 * Hidden from screen readers on purpose: the `required` attribute on the input already
 * makes them announce it, and a spoken "asterisk" after every label is noise. The title
 * gives the same information to anyone who hovers, and the colour is not the only signal —
 * the star itself is.
 */
export const Required = ({ when = true }) => (when
  ? <abbr className="req" title="This field is required" aria-hidden="true">*</abbr>
  : null);

/*
 * `max` matters as much as `min`. Without it a number the server will refuse — a bid
 * validity of 250000 days, a markup of 900% — is only caught after the person has filled
 * in the whole form and pressed save. The bounds here are meant to mirror the schema the
 * route validates against, so the answer comes back at the field rather than at the end.
 */
export function Field({ name, label, type = 'text', wide = false, required = true, defaultValue, step, min, max, placeholder }) {
  return <label className={wide ? 'wide' : ''}>{label}<Required when={required} />
    <input name={name} type={type} required={required} defaultValue={defaultValue} step={step} min={min} max={max} placeholder={placeholder} />
  </label>;
}

export function TextArea({ name, label, required = true, placeholder, defaultValue, rows }) {
  return <label className="wide">{label}<Required when={required} />
    <textarea name={name} required={required} placeholder={placeholder} defaultValue={defaultValue} rows={rows} />
  </label>;
}

export function SelectField({ name, label, options, defaultValue, wide = false, required = true }) {
  return <label className={wide ? 'wide' : ''}>{label}<Required when={required} />
    <select name={name} defaultValue={defaultValue} required={required}>
      {options.map(option => {
        const [value, text] = Array.isArray(option) ? option : [option, option];
        return <option value={value} key={value}>{text}</option>;
      })}
    </select>
  </label>;
}

export function FormButtons({ close, label, busy }) {
  return <div className="form-actions">
    <button type="button" className="secondary" onClick={close}>Cancel</button>
    <button className="primary" disabled={busy}><Check size={17} />{busy ? 'Saving…' : label}</button>
  </div>;
}

export function EmptyState({ children }) {
  return <p className="empty-state">{children}</p>;
}

/**
 * Table shell used by every list in the product. `columns` drives the header and the
 * grid template, so a new module only supplies its rows.
 */
export function Table({ columns, template, children, title, tools, empty = 'Nothing recorded yet.' }) {
  const rows = React.Children.toArray(children);
  /*
   * The heading and the rows share one grid.
   *
   * They each used to be a grid of their own carrying the same template, which reads as
   * though it should line up and does not: a track written as minmax(150px,1fr) is resolved
   * against the content of whichever row it is in, so a row holding a long project name
   * came out with wider columns than the row above it and the table visibly stepped in and
   * out. The columns are declared once here and each row takes its widths from the parent,
   * so every cell in a column is measured against the same content.
   */
  return <section className="table-panel">
    {(title || tools) && <div className="table-tools"><h2>{title}</h2>{tools}</div>}
    <div className="table-grid" style={{ gridTemplateColumns: template }}>
      <div className="table-head" style={{ gridTemplateColumns: template }}>
        {columns.map(column => <span key={column}>{column}</span>)}
      </div>
      {rows.length ? rows : <div className="table-row table-empty"><span>{empty}</span></div>}
    </div>
  </section>;
}

export function Row({ template, children, onClick }) {
  /* The inline template is the fallback for browsers without subgrid; where subgrid is
     supported the stylesheet overrides it and the parent's columns win. */
  return <div className="table-row" style={{ gridTemplateColumns: template, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>{children}</div>;
}

/**
 * Wraps a create/edit form in a modal and handles the submit lifecycle, so each module
 * describes only its fields and the request to send.
 */
export function FormModal({ title, close, label, onSubmit, children, wide = false }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await onSubmit(Object.fromEntries(form.entries()), form);
      close();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return <Modal title={title} close={close} wide={wide}>
    <EntityForm onSubmit={submit} error={error}>
      {children}
      <FormButtons close={close} label={label} busy={busy} />
    </EntityForm>
  </Modal>;
}
