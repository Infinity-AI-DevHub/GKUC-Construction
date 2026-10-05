import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CalendarClock, ClipboardCheck, CornerDownLeft, Handshake } from 'lucide-react';
import { api, onDataChanged, patch } from './api.js';
import { Modal } from './ui.jsx';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const datePart = value => String(value || '').slice(0, 10);
const waiting = value => {
  if (!value) return 'Waiting time unknown';
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
  return Number.isFinite(days) ? (days === 0 ? 'Added today' : `Waiting ${days} day${days === 1 ? '' : 's'}`) : 'Waiting time unknown';
};
const timing = value => {
  const date = datePart(value);
  if (!date) return 'No deadline set';
  const delta = Math.round((new Date(`${date}T12:00:00`).getTime() - new Date(`${today()}T12:00:00`).getTime()) / 86400000);
  return `${date}${delta < 0 ? ` · ${-delta} day${delta === -1 ? '' : 's'} overdue` : delta === 0 ? ' · today' : ''}`;
};

export function buildWorkQueues({ data, queue, can, user }) {
  const needsApproval = [], dueToday = [], blocked = [], returned = [];
  const name = String(user?.name || '').trim().toLowerCase();
  const day = today();
  const ownTask = task => String(task.assignee || '').trim().toLowerCase() === name
    || (task.assignees || []).some(person => String(person.name || '').trim().toLowerCase() === name);

  for (const task of data.tasks || []) {
    const item = { key: `task-${task.id}`, title: task.title, detail: task.project, owner: task.assignee || 'Project team', deadline: task.dueDate, createdAt: task.createdAt, risk: 'Project delivery may be delayed', escalation: 'Project manager', target: ['Tasks', null, task.id] };
    if (task.status === 'Completed' && can.has('projects.manage') && can.has('site.tasks')) needsApproval.push({ ...item, action: 'Approve completed task' });
    if (task.status === 'Blocked' && ownTask(task)) blocked.push({ ...item, action: 'Resolve blocker', risk: 'Assigned work cannot progress' });
    if ((datePart(task.dueDate) === day || (!task.dueDate && /^today\b/i.test(task.due || '')))
      && !['Approved', 'Completed', 'Rejected'].includes(task.status) && ownTask(task))
      dueToday.push({ ...item, action: 'Open task' });
    else if (task.dueDate && datePart(task.dueDate) < day && !['Approved', 'Completed', 'Rejected'].includes(task.status) && ownTask(task))
      dueToday.push({ ...item, action: 'Complete overdue task' });
  }
  for (const sheet of queue.sheets || []) {
    const base = { key: `sheet-${sheet.id}`, title: `Daily costs · ${sheet.project}`, detail: `${sheet.lineCount} cost line${sheet.lineCount === 1 ? '' : 's'}`, owner: sheet.status === 'Returned' ? sheet.submittedByName : 'Finance cost review', deadline: sheet.workDate, createdAt: sheet.createdAt, risk: 'Project cost cannot be posted', escalation: 'Finance management' };
    if (sheet.status === 'Submitted') {
      if (can.has('finance.costReview')) needsApproval.push({ ...base, action: 'Review cost sheet', target: ['Finance', 'Daily cost review', sheet.id] });
      else if (can.has('qs.costControl') && Number(sheet.submittedBy) === Number(user.id))
        blocked.push({ ...base, action: 'Awaiting Finance review', target: ['Quantity Surveying', 'Cost control', sheet.id, sheet.projectId] });
    } else if (sheet.status === 'Returned' && can.has('qs.costControl')) {
      returned.push({ ...base, detail: sheet.reviewNote || 'Finance requested a correction', action: 'Correct and resubmit', target: ['Quantity Surveying', 'Cost control', sheet.id, sheet.projectId] });
    }
  }
  if (can.has('hr.payroll')) for (const claim of queue.claims || []) {
    needsApproval.push({ key: `claim-${claim.id}`, title: `${claim.kind} · ${claim.employee}`,
      detail: `${claim.project || 'Office'} · ${claim.status}`,
      owner: 'HR payroll', action: claim.status === 'Confirmed' ? 'Approve claim' : 'Review and confirm',
      deadline: claim.workDate, createdAt: claim.createdAt, risk: 'Claim will not enter payroll', escalation: 'HR management',
      target: ['People', 'Payroll Inputs', claim.id] });
  }
  if (can.has('finance.view') || can.has('finance.invoice')) for (const invoice of queue.invoicesDue || []) {
    dueToday.push({ key: `invoice-${invoice.id}`, title: `${invoice.reference} · ${invoice.client}`,
      detail: `LKR ${Number(invoice.outstanding).toLocaleString('en-LK')} outstanding`,
      owner: 'Finance', action: 'Follow up collection', deadline: invoice.dueDate, createdAt: invoice.createdAt,
      risk: 'Cash collection is overdue', escalation: 'Finance management', target: ['Finance', 'Invoices', invoice.id] });
  }
  for (const item of queue.work || []) {
    const card = { ...item, key: `${item.kind}-${item.id}` };
    if (['purchase-request','order-approval','leave','overtime','attendance','integrity'].includes(item.kind)) needsApproval.push(card);
    else if (['approved-request','purchase-order','invoice-verification','offboarding-assets','offboarding-store','offboarding-vehicle','offboarding-access','offboarding-payroll','payroll-step','project-start','project-closeout','accepted-quotation','onboarding','daily-site-close','low-stock','client-followup','milestone','tender','tender-document','insurance','vehicle-renewal','returned-cheque','retention','bond','company-compliance'].includes(item.kind)) dueToday.push(card);
  }
  const urgency = (a, b) => {
    const left = datePart(a.deadline) || '9999-12-31';
    const right = datePart(b.deadline) || '9999-12-31';
    return left.localeCompare(right) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  };
  for (const group of [needsApproval, dueToday, blocked, returned]) group.sort(urgency);
  return { needsApproval, dueToday, blocked, returned };
}

const SECTIONS = [
  { key: 'needsApproval', title: 'Needs my approval', icon: ClipboardCheck, empty: 'No approvals waiting for your role.' },
  { key: 'dueToday', title: 'Due & upcoming', icon: CalendarClock, empty: 'No deadlines or follow-ups need attention.' },
  { key: 'blocked', title: 'Blocked by another team', icon: Handshake, empty: 'Nothing is waiting on another team.' },
  { key: 'returned', title: 'Recently returned for correction', icon: CornerDownLeft, empty: 'No work has been returned to you.' }
];

export default function MyWorkToday({ user, can, go, data, companyId }) {
  const [queue, setQueue] = useState({ sheets: [], claims: [], invoicesDue: [], work: [] });
  const [error, setError] = useState('');
  const [clearance, setClearance] = useState(null);
  const [clearanceNote, setClearanceNote] = useState('');
  const [clearanceError, setClearanceError] = useState('');
  const load = () => api(`/dashboard/queue?companyId=${companyId}`)
    .then(result => { setQueue(result); setError(''); })
    .catch(failure => setError(failure.message));
  useEffect(() => {
    setQueue({ sheets: [], claims: [], invoicesDue: [], work: [] });
    load();
    return onDataChanged(load);
  }, [companyId]);
  const groups = useMemo(() => buildWorkQueues({ data, queue, can, user }), [data, queue, can, user]);
  const open = item => {
    if (['offboarding-access','offboarding-payroll','offboarding-store','offboarding-vehicle'].includes(item.kind)) {
      api(`/employees/${item.target[2]}/offboarding`).then(result => {setClearance({item,result});setClearanceNote('');setClearanceError('');}).catch(failure => setClearanceError(failure.message));
      return;
    }
    if (item.kind === 'offboarding-assets') {
      window.location.assign(`/people/${item.target[2]}`);
      return;
    }
    if (item.kind === 'project-start' || item.kind === 'project-closeout') {
      window.location.assign(`/projects/${item.target[2]}`);
      return;
    }
    if (item.kind === 'daily-site-close') {
      window.location.assign(`/daily-reports?new=1&project=${item.target[2]}&workDate=${item.workDate}`);
      return;
    }
    const [page, tab, id, projectId] = item.target;
    go(page, tab);
    const params = new URLSearchParams({ record: String(id) });
    if (projectId) params.set('project', String(projectId));
    if (item.workDate) params.set('workDate', item.workDate);
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
  };

  return <section className="my-work-today" aria-labelledby="my-work-title">
    <div className="my-work-heading"><div><span className="my-work-kicker">Your starting point</span>
      <h2 id="my-work-title">My work today</h2><p>{user.role || 'Your role'} · live records you can act on</p></div></div>
    {error && <p className="form-error" role="alert">Some work queues could not load: {error}</p>}
    {clearanceError && !clearance && <p className="form-error" role="alert">{clearanceError}</p>}
    <div className="my-work-grid">{SECTIONS.map(section => {
      const Icon = section.icon;
      const items = groups[section.key];
      return <div className="my-work-queue" key={section.key}>
        <header><span className="my-work-icon"><Icon size={19} /></span><div><h3>{section.title}</h3><small>{items.length} item{items.length === 1 ? '' : 's'}</small></div></header>
        <div className="my-work-queue-items">{items.map(item => <button type="button" key={item.key} onClick={() => open(item)}>
          <strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}
          <small>Owner: {item.owner} · Deadline: {timing(item.deadline)}</small>
          <small>{waiting(item.createdAt)} · Escalate to: {item.escalation || 'Team lead'}</small>
          {item.risk && <small className="my-work-risk">Risk: {item.risk}</small>}
          <span>{item.action}<ArrowUpRight size={14} /></span>
        </button>)}{!items.length && <p>{section.empty}</p>}</div>
      </div>;
    })}</div>
    {clearance && <Modal title={clearance.item.title} close={() => setClearance(null)}>
      <div className="report-form"><p className="wide">{clearance.result.offboarding?.reason}</p>
        <p className="wide">Return status: {clearance.result.assets.length} HR assets, {clearance.result.store.length} store tools, {clearance.result.vehicles.length} vehicles and {clearance.result.tasks.length} open tasks.</p>
        {clearance.item.kind === 'offboarding-store' || clearance.item.kind === 'offboarding-vehicle'
          ? <div className="wide"><strong>Still assigned</strong><ul>{(clearance.item.kind === 'offboarding-store' ? clearance.result.store : clearance.result.vehicles)
            .map(row => <li key={row.id}>{row.name}{row.code ? ` · ${row.code}` : ''}</li>)}</ul>
            <p>Record the return or release in the authoritative register. This checklist updates automatically.</p></div>
          : <><p className="wide">{clearance.item.kind === 'offboarding-access'
            ? 'Verify system access has been removed (or that no account exists) before confirming.'
            : 'Verify final salary, deductions and advances before confirming.'}</p>
            <label className="wide">Clearance evidence / explanation<textarea value={clearanceNote} onChange={event => setClearanceNote(event.target.value)} rows={3} minLength={5} required /></label></>}
        {clearanceError && <p className="form-error wide" role="alert">{clearanceError}</p>}
        <div className="form-actions wide"><button type="button" className="secondary" onClick={() => setClearance(null)}>Cancel</button>
          {['offboarding-store','offboarding-vehicle'].includes(clearance.item.kind)
            ? <button type="button" className="primary" onClick={() => window.location.assign(clearance.item.kind === 'offboarding-store' ? '/stock-locations' : '/fleet')}>Open register</button>
            : <button type="button" className="primary" onClick={async () => {
            try {await patch(`/employees/${clearance.item.target[2]}/offboarding/clearance`,{
              area:clearance.item.kind === 'offboarding-access'?'access':'payroll',note:clearanceNote.trim()});
              setClearance(null);await load();}catch(failure){setClearanceError(failure.message);}
          }}>Confirm clearance</button>}</div>
      </div>
    </Modal>}
  </section>;
}
