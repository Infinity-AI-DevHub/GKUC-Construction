import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Plus, X } from 'lucide-react';
import { initials, onDataChanged, slug } from './api.js';
import './workflow.css';
import { RecordScopeBadge, showScopeSaved, useRecordScope } from './record-scope.jsx';

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
  const sections = React.Children.toArray(children);
  const navigation = title !== 'Tasks' && sections.find(child => React.isValidElement(child) && child.type === Tabs);
  return <>
    <div className="page-heading">
      <div><h1>{title}</h1><p>{subtitle}</p><RecordScopeBadge /></div>
      {action && onAction && <button className="primary" onClick={onAction}><Plus size={17} />{action}</button>}
    </div>
    {navigation ? <div className="module-layout">
      <aside className="module-navigation" aria-label={`${title} sections`}>
        <div className="module-navigation-label">{title} workspace</div>
        {navigation}
      </aside>
      <div className="module-content">{sections.filter(child => child !== navigation)}</div>
    </div> : children}
  </>;
}

/** Sub-navigation inside a module, using the same segmented control as the task filters. */
export function Tabs({ tabs, active, onChange, groups }) {
  const sections = groups
    ? groups.map(group => ({ ...group, tabs: group.tabs.filter(tab => tabs.includes(tab)) })).filter(group => group.tabs.length)
    : [{ label: null, tabs }];
  return <div className="toolbar">
    {groups && <label className="compact-section-picker">Jump to section
      <select value={active} onChange={event => onChange(event.target.value)}>
        {sections.map((group, index) => <optgroup label={group.label} key={group.label || index}>
          {group.tabs.map(tab => <option key={tab} value={tab}>{tab}</option>)}
        </optgroup>)}
      </select>
    </label>}
    <div className={`segments${groups ? ' grouped-segments' : ''}`}>
    {sections.map((group, index) => <div className="segment-group" key={group.label || index}>
      {group.label && <div className="segment-group-label">{group.label}</div>}
      {group.tabs.map(tab => <button type="button" aria-pressed={active === tab} className={active === tab ? 'active' : ''} onClick={() => onChange(tab)} key={tab}>{tab}</button>)}
    </div>)}
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

const FormErrors = createContext({});
const FieldError = ({ name }) => {
  const message = useContext(FormErrors)[name];
  return message ? <span className="field-error" role="alert">{message}</span> : null;
};
function focusFormError(form, issues, fallback) {
  const first = Object.keys(issues)[0];
  const field = first && form?.elements.namedItem(first);
  requestAnimationFrame(() => (field?.focus ? field : fallback)?.focus());
}
function parseFieldErrors(failure) {
  return Object.fromEntries(Object.entries(failure.details?.issues?.fieldErrors || {})
    .filter(([, messages]) => messages?.length).map(([name, messages]) => [name, messages[0]]));
}

export function Modal({ title, close, children, wide = false, scope }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector('input,select,textarea,button,[href]')?.focus();
    const onKeyDown = event => {
      const overlays = [...document.querySelectorAll('.modal-backdrop')];
      if (overlays.at(-1) !== dialog?.parentElement) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
        .filter(item => !item.disabled && item.getClientRects().length);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div ref={dialogRef} className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-title"><div className="modal-title-context"><h2>{title}</h2><RecordScopeBadge scope={scope} compact /></div><button className="icon-btn" onClick={close}><X size={18} /></button></div>
      <div className="modal-content">{children}</div>
    </div>
  </div>;
}

export function EntityForm({ onSubmit, error, children, fieldErrors = {}, errorRef }) {
  return <FormErrors.Provider value={fieldErrors}><form onSubmit={onSubmit} className="report-form">{error && <p ref={errorRef} tabIndex={-1} className="form-error" role="alert">{error}</p>}{children}</form></FormErrors.Provider>;
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
    <input name={name} type={type} required={required} defaultValue={defaultValue} step={step} min={min} max={max} placeholder={placeholder} /><FieldError name={name} />
  </label>;
}

export function TextArea({ name, label, required = true, placeholder, defaultValue, rows }) {
  return <label className="wide">{label}<Required when={required} />
    <textarea name={name} required={required} placeholder={placeholder} defaultValue={defaultValue} rows={rows} /><FieldError name={name} />
  </label>;
}

export function SelectField({ name, label, options, defaultValue, wide = false, required = true }) {
  return <label className={wide ? 'wide' : ''}>{label}<Required when={required} />
    <select name={name} defaultValue={defaultValue} required={required}>
      {options.map(option => {
        const [value, text] = Array.isArray(option) ? option : [option, option];
        return <option value={value} key={value}>{text}</option>;
      })}
    </select><FieldError name={name} />
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
export function Table({ columns, template, children, title, tools, empty = 'No records in this view. Check the selected company, project, filters, or date range.', emptyAction, emptyActionLabel }) {
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
    {(title || tools) && <div className="table-tools"><div className="table-tools-context"><h2>{title}</h2><RecordScopeBadge compact /></div>{tools}</div>}
    <div className="table-grid" style={{ gridTemplateColumns: template }}>
      <div className="table-head" style={{ gridTemplateColumns: template }}>
        {columns.map(column => <span key={column}>{column}</span>)}
      </div>
      {rows.length ? rows : <div className="table-row table-empty"><span>{empty}{emptyAction && <button type="button" className="status-button" onClick={emptyAction}>{emptyActionLabel || 'Get started'}</button>}</span></div>}
    </div>
  </section>;
}

export function Row({ template, children, onClick }) {
  /* The inline template is the fallback for browsers without subgrid; where subgrid is
     supported the stylesheet overrides it and the parent's columns win. */
  return <div className="table-row" role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
    style={{ gridTemplateColumns: template, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}
    onKeyDown={onClick ? event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(event); } } : undefined}>{children}</div>;
}

/**
 * Wraps a create/edit form in a modal and handles the submit lifecycle, so each module
 * describes only its fields and the request to send.
 */
export function FormModal({ title, close, label, onSubmit, children, wide = false, scope }) {
  const recordScope = useRecordScope(scope);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const errorRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError('');
    setFieldErrors({});
    const form = new FormData(formElement);
    try {
      await onSubmit(Object.fromEntries(form.entries()), form);
      close();
      showScopeSaved(recordScope);
    } catch (failure) {
      const issues = parseFieldErrors(failure);
      setFieldErrors(issues);
      setError(Object.keys(issues).length ? 'Please correct the highlighted field, then save again.' : failure.message);
      focusFormError(formElement, issues, errorRef.current);
    } finally {
      setBusy(false);
    }
  };
  return <Modal title={title} close={close} wide={wide} scope={scope}>
    <EntityForm onSubmit={submit} error={error} fieldErrors={fieldErrors} errorRef={errorRef}>
      {children}
      <FormButtons close={close} label={label} busy={busy} />
    </EntityForm>
  </Modal>;
}

/** Long, consequential records get room to breathe and a separate review before writing. */
export function WorkflowForm({ title, close, label, onSubmit, children, summary = [], reviewContent = null, scope }) {
  const recordScope = useRecordScope(scope);
  const formRef = useRef(null);
  const pageRef = useRef(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const errorRef = useRef(null);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, []);
  const collect = () => Object.fromEntries(new FormData(formRef.current).entries());
  const displayValues = () => Object.fromEntries(Array.from(formRef.current.elements)
    .filter(element => element.name && element.value)
    .map(element => [element.name, element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent : element.value]));
  const requestClose = () => { if (!dirty || window.confirm('Discard this unsaved draft and return?')) close(); };
  const reviewFields = () => Array.from(formRef.current.elements).filter(element => element.name && !['submit', 'button', 'hidden'].includes(element.type))
    .map(element => ({ name: element.name, label: element.closest('label')?.firstChild?.textContent?.trim() || element.name,
      value: element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent : element.value }))
    .filter(item => item.value && item.value.trim());
  const prepare = event => {
    event.preventDefault();
    if (!formRef.current.reportValidity()) return;
    setValues(displayValues());
    setError(''); setFieldErrors({});
    setReview(true);
    pageRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const save = async () => {
    setBusy(true); setError('');
    try { const form = new FormData(formRef.current); await onSubmit(Object.fromEntries(form.entries()), form); close(); showScopeSaved(recordScope); }
    catch (failure) { const issues = parseFieldErrors(failure); setFieldErrors(issues);
      setError(Object.keys(issues).length ? 'Please correct the highlighted field, then review again.' : failure.message);
      setReview(false); focusFormError(formRef.current, issues, errorRef.current); }
    finally { setBusy(false); }
  };
  return <div className="workflow-page" role="region" aria-label={title} ref={pageRef}>
    <header className="workflow-header"><div><span>GKUC SiteOps · guided entry</span><h1>{title}</h1><RecordScopeBadge scope={scope} /></div><button type="button" className="secondary" onClick={requestClose}>Close and return</button></header>
    <div className="workflow-progress" aria-label="Workflow progress"><span className={!review ? 'current' : 'done'}>1 · Complete details</span><span className={review ? 'current' : ''}>2 · Review and confirm</span></div>
    <div className="workflow-layout"><div className="workflow-main">
      <FormErrors.Provider value={fieldErrors}><form ref={formRef} className={`report-form workflow-editor${review ? ' is-reviewing' : ''}`} onSubmit={prepare} onInput={() => { setDirty(true); setValues(displayValues()); }} onChange={() => { setDirty(true); setValues(displayValues()); }}>
        {!review && error && <p className="form-error wide" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
        {children}
        <div className="form-actions wide"><button type="button" className="secondary" onClick={requestClose}>Cancel</button><button className="primary" type="submit">Review details <ChevronRight size={16} /></button></div>
      </form></FormErrors.Provider>
      {review && <section className="workflow-review"><span className="section-kicker">Final check</span><h2>Review before saving</h2><RecordScopeBadge scope={scope} /><p>Nothing has been saved yet. Check the details below, then confirm. Use “Edit details” to correct anything.</p>
        <dl>{reviewFields().map((item, index) => <div key={`${item.name}-${index}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
        {reviewContent && <div className="workflow-review-content">{reviewContent}</div>}
        {summary.length > 0 && <div className="workflow-review-summary">{summary.map(([name, value]) => <div key={name}><span>{name}</span><strong>{value || '—'}</strong></div>)}</div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="secondary" onClick={() => { setReview(false); setError(''); }}>Edit details</button><button type="button" className="primary" onClick={save} disabled={busy}><Check size={16} />{busy ? 'Saving…' : label}</button></div>
      </section>}
    </div><aside className="workflow-summary" aria-label="Current draft summary"><span className="section-kicker">Your draft</span><h2>{review ? 'Ready to confirm' : 'Summary as you work'}</h2><p>{review ? 'Review every detail before it becomes a saved record.' : 'Complete the sections on the left. You can check everything before saving.'}</p>
      {[...summary, ...Object.entries(values).filter(([name, value]) => value && ['title', 'projectId', 'clientId', 'closingDate', 'periodStart', 'periodEnd', 'dueDate'].includes(name)).map(([name, value]) => [name.replace(/([A-Z])/g, ' $1'), value])].map(([name, value], index) => <div className="workflow-summary-line" key={`${name}-${index}`}><span>{name}</span><strong>{value || '—'}</strong></div>)}
      <div className="workflow-summary-foot">{review ? 'Step 2 of 2 · confirm to save' : 'Step 1 of 2 · nothing saved yet'}</div>
    </aside></div>
  </div>;
}
