import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CalendarClock, ClipboardCheck, CornerDownLeft, Handshake } from 'lucide-react';
import { api, onDataChanged } from './api.js';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const datePart = value => String(value || '').slice(0, 10);

export function buildWorkQueues({ data, queue, can, user }) {
  const needsApproval = [], dueToday = [], blocked = [], returned = [];
  const name = String(user?.name || '').trim().toLowerCase();
  const day = today();
  const ownTask = task => String(task.assignee || '').trim().toLowerCase() === name
    || (task.assignees || []).some(person => String(person.name || '').trim().toLowerCase() === name);

  for (const task of data.tasks || []) {
    const item = { key: `task-${task.id}`, title: task.title, detail: `${task.project} · ${task.due || task.dueDate || ''}`, owner: task.assignee || 'Project team', target: ['Tasks', null, task.id] };
    if (task.status === 'Completed' && can.has('projects.manage') && can.has('site.tasks')) needsApproval.push({ ...item, action: 'Approve completed task' });
    if ((datePart(task.dueDate) === day || (!task.dueDate && /^today\b/i.test(task.due || '')))
      && !['Approved', 'Completed', 'Rejected'].includes(task.status) && ownTask(task))
      dueToday.push({ ...item, action: 'Open task' });
  }
  for (const sheet of queue.sheets || []) {
    const base = { key: `sheet-${sheet.id}`, title: `Daily costs · ${sheet.project}`, detail: `${sheet.workDate} · ${sheet.lineCount} cost line${sheet.lineCount === 1 ? '' : 's'}`, owner: 'QS → Finance' };
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
      detail: `${claim.workDate} · ${claim.project || 'Office'} · ${claim.status}`,
      owner: 'HR payroll', action: claim.status === 'Confirmed' ? 'Approve claim' : 'Review and confirm',
      target: ['People', 'Payroll Inputs', claim.id] });
  }
  if (can.has('finance.view') || can.has('finance.invoice')) for (const invoice of queue.invoicesDue || []) {
    dueToday.push({ key: `invoice-${invoice.id}`, title: `${invoice.reference} · ${invoice.client}`,
      detail: `Client payment due today · LKR ${Number(invoice.outstanding).toLocaleString('en-LK')}`,
      owner: 'Finance', action: 'Open invoice and payments', target: ['Finance', 'Invoices', invoice.id] });
  }
  return { needsApproval, dueToday, blocked, returned };
}

const SECTIONS = [
  { key: 'needsApproval', title: 'Needs my approval', icon: ClipboardCheck, empty: 'No approvals waiting for your role.' },
  { key: 'dueToday', title: 'Due today', icon: CalendarClock, empty: 'No assigned tasks due today.' },
  { key: 'blocked', title: 'Blocked by another team', icon: Handshake, empty: 'Nothing is waiting on another team.' },
  { key: 'returned', title: 'Recently returned for correction', icon: CornerDownLeft, empty: 'No work has been returned to you.' }
];

export default function MyWorkToday({ user, can, go, data, companyId }) {
  const [queue, setQueue] = useState({ sheets: [], claims: [], invoicesDue: [] });
  const [error, setError] = useState('');
  const load = () => api(`/dashboard/queue?companyId=${companyId}`)
    .then(result => { setQueue(result); setError(''); })
    .catch(failure => setError(failure.message));
  useEffect(() => {
    setQueue({ sheets: [], claims: [], invoicesDue: [] });
    load();
    return onDataChanged(load);
  }, [companyId]);
  const groups = useMemo(() => buildWorkQueues({ data, queue, can, user }), [data, queue, can, user]);
  const open = item => {
    const [page, tab, id, projectId] = item.target;
    go(page, tab);
    const params = new URLSearchParams({ record: String(id) });
    if (projectId) params.set('project', String(projectId));
    window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
  };

  return <section className="my-work-today" aria-labelledby="my-work-title">
    <div className="my-work-heading"><div><span className="my-work-kicker">Your starting point</span>
      <h2 id="my-work-title">My work today</h2><p>{user.role || 'Your role'} · live records you can act on</p></div></div>
    {error && <p className="form-error" role="alert">Some work queues could not load: {error}</p>}
    <div className="my-work-grid">{SECTIONS.map(section => {
      const Icon = section.icon;
      const items = groups[section.key];
      return <div className="my-work-queue" key={section.key}>
        <header><span className="my-work-icon"><Icon size={19} /></span><div><h3>{section.title}</h3><small>{items.length} item{items.length === 1 ? '' : 's'}</small></div></header>
        <div className="my-work-queue-items">{items.map(item => <button type="button" key={item.key} onClick={() => open(item)}>
          <strong>{item.title}</strong><small>{item.detail}</small><span>{item.owner} · {item.action}<ArrowUpRight size={14} /></span>
        </button>)}{!items.length && <p>{section.empty}</p>}</div>
      </div>;
    })}</div>
  </section>;
}
