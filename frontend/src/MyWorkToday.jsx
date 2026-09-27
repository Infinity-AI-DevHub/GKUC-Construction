import React from 'react';
import { ArrowUpRight, CalendarCheck2, ClipboardCheck, FileText, HardHat, ReceiptText, ShieldCheck, Truck, Users, Warehouse } from 'lucide-react';

const WORK = [
  { title: 'Attendance & leave', detail: 'Record time and review people who are away.', page: 'People', icon: CalendarCheck2, permissions: ['hr.attendance', 'hr.leave', 'hr.manage'] },
  { title: 'Payroll review', detail: 'Check payroll inputs and prepare the next run.', page: 'People', icon: Users, permissions: ['hr.payroll'] },
  { title: 'Invoices & receipts', detail: 'Follow client invoices and incoming payments.', page: 'Finance', icon: ReceiptText, permissions: ['finance.invoice', 'finance.pay'] },
  { title: 'Daily cost review', detail: 'Review site cost sheets awaiting Finance.', page: 'Finance', icon: ShieldCheck, permissions: ['finance.costReview'] },
  { title: 'Quotes & cost control', detail: 'Prepare quotations and track project costs.', page: 'Quantity Surveying', icon: FileText, permissions: ['qs.quotation', 'qs.costControl'] },
  { title: 'Project overview', detail: 'Open site workspaces and follow delivery.', page: 'Projects', icon: HardHat, permissions: ['projects.view'] },
  { title: 'Sites & assignments', detail: 'See where people and resources are needed.', page: 'Coordination', icon: HardHat, permissions: ['projects.view'] },
  { title: 'Stock & purchasing', detail: 'Review stock, movements and requests.', page: 'Materials', icon: Warehouse, permissions: ['store.view', 'store.manage'] },
  { title: 'Vehicles & renewals', detail: 'Check fleet assignments and due dates.', page: 'Fleet', icon: Truck, permissions: ['transport.view', 'transport.manage'] },
  { title: 'Project tasks', detail: 'Follow work assigned across active projects.', page: 'Tasks', icon: ClipboardCheck, permissions: ['projects.view'] }
];

export default function MyWorkToday({ user, can, go }) {
  const available = WORK.filter(item => item.permissions.some(permission => can.has(permission)));
  const featured = available.length > 4
    ? available.filter((item, index) => available.findIndex(other => other.page === item.page) === index).slice(0, 4)
    : available;
  if (!featured.length) return null;

  return <section className="my-work-today" aria-labelledby="my-work-title">
    <div className="my-work-heading">
      <div><span className="my-work-kicker">Your starting point</span><h2 id="my-work-title">My work today</h2><p>Shortcuts for {user.role || 'your access'} · choose a workspace to continue.</p></div>
    </div>
    <div className="my-work-grid">
      {featured.map(({ title, detail, page, icon: Icon }) => <button type="button" key={title} onClick={() => go(page)}>
        <span className="my-work-icon"><Icon size={21} /></span>
        <strong>{title}</strong><small>{detail}</small><span className="my-work-open">Open workspace <ArrowUpRight size={15} /></span>
      </button>)}
    </div>
  </section>;
}
