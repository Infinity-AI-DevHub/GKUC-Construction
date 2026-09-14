import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Building2, CalendarDays, CheckCircle2, CircleDollarSign,
  Download, FileText, HardHat, MapPin, TrendingUp, Users, WalletCards
} from 'lucide-react';
import { api, money, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Progress, Row, SelectField, Table, Tabs, Field, FormModal } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import ProjectGallery from '../ProjectGallery.jsx';
import ProjectReports from './ProjectReports.jsx';

const TABS = ['Command centre', 'Reports', 'Programme', 'Commercial', 'Team', 'Gallery', 'Documents', 'Close-out'];

/** A project is a workspace, not a form dialog: every operational record converges here. */
export default function ProjectDetail({ projectId, data, close, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [project, setProject] = useState(null);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const load = () => api(`/projects/${projectId}`).then(setProject).catch(failure => setError(failure.message));
  useEffect(() => { load(); }, [projectId]);
  const refresh = async () => { await load(); await reload(); };

  if (error) return <div className="project-workspace-state"><AlertTriangle /><h2>Project unavailable</h2><p>{error}</p><button className="secondary" onClick={close}>Back to projects</button></div>;
  if (!project) return <div className="project-workspace-state"><span className="workspace-loader" /><h2>Preparing project workspace</h2><p>Gathering programme, commercial and site records…</p></div>;

  return <div className="project-workspace">
    <ProjectHero project={project} close={close} />
    <ProjectMetrics project={project} />
    <div className="project-workspace-tabs"><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
    {tab === 'Command centre' && <CommandCentre project={project} />}
    {tab === 'Reports' && <ProjectReports project={project} />}
    {tab === 'Programme' && <Programme project={project} can={can} refresh={refresh} onAdd={() => setAdding('milestone')} />}
    {tab === 'Commercial' && <Commercial project={project} />}
    {tab === 'Team' && <Team project={project} can={can} onAdd={() => setAdding('team')} />}
    {tab === 'Gallery' && <section className="workspace-surface"><ProjectGallery projectId={project.id} canManage={can.gallery} /></section>}
    {tab === 'Documents' && <Attachments ownerType="project" ownerId={project.id} title="Project document library" canUpload={can.projects} canDelete={can.projects} withCategory />}
    {tab === 'Close-out' && <CompletionReport projectId={project.id} />}
    {adding === 'milestone' && <MilestoneForm projectId={project.id} close={() => setAdding('')} reload={refresh} />}
    {adding === 'team' && <TeamForm projectId={project.id} employees={data.employees} close={() => setAdding('')} reload={refresh} />}
  </div>;
}

function ProjectHero({ project, close }) {
  return <section className="project-hero">
    <img src="/construction-site.jpg" alt="" className="project-hero-image" /><div className="project-hero-shade" />
    <button className="project-back" onClick={close}><ArrowLeft size={17} />All projects</button>
    <div className="project-hero-content">
      <div className="project-kicker"><Badge tone={project.health === 'On track' ? 'on-track' : project.health === 'At risk' ? 'at-risk' : 'watch'}>{project.health}</Badge><span>{project.stage}</span></div>
      <h1>{project.name}</h1><p><MapPin size={16} />{project.site}<span /><Building2 size={16} />{project.client}</p>
    </div>
    <div className="project-hero-progress"><span>Overall delivery</span><strong>{project.progress}%</strong><Progress value={project.progress} /></div>
  </section>;
}

function ProjectMetrics({ project }) {
  const budget = Number(project.finance.budget || 0); const spent = Number(project.finance.expenses || 0); const income = Number(project.finance.income || 0);
  const completed = project.tasks.filter(task => ['Completed', 'Approved'].includes(task.status)).length;
  const overdue = project.tasks.filter(task => !['Completed', 'Approved'].includes(task.status) && task.due && new Date(task.due) < new Date()).length;
  const items = [
    [CircleDollarSign, 'Approved budget', money(budget), `${budget ? Math.round((spent / budget) * 100) : 0}% utilised`, 'navy'],
    [TrendingUp, 'Recorded cost', money(spent), `${money(Math.max(0, budget - spent))} remaining`, spent > budget ? 'red' : 'blue'],
    [WalletCards, 'Income received', money(income), `${project.invoices.length} client invoice${project.invoices.length === 1 ? '' : 's'}`, 'cherry'],
    [CheckCircle2, 'Delivery', `${completed}/${project.tasks.length}`, overdue ? `${overdue} overdue task${overdue === 1 ? '' : 's'}` : 'No overdue tasks', overdue ? 'red' : 'navy']
  ];
  return <div className="project-metric-strip">{items.map(([Icon, label, value, detail, tone]) => <article key={label} className={`project-metric ${tone}`}><span><Icon size={20} /></span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>)}</div>;
}

function CommandCentre({ project }) {
  const latest = project.reports[0]; const openTasks = project.tasks.filter(task => !['Completed', 'Approved'].includes(task.status));
  const completedMilestones = project.milestones.filter(item => item.status === 'Completed').length;
  const spent = Number(project.finance.expenses || 0); const budget = Number(project.finance.budget || 0);
  const burn = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  return <div className="project-command-grid">
    <section className="workspace-surface project-insight-main">
      <SectionHeading kicker="Today on site" title="Daily intelligence" icon={HardHat} />
      {latest ? <><div className="site-insight-lead"><div><strong>{latest.workforce}</strong><span>people on site</span></div><div><strong>{latest.delayHours || 0}h</strong><span>delay recorded</span></div><div><strong>{latest.weather || '—'}</strong><span>weather</span></div></div><blockquote>{latest.workCompleted}</blockquote><p className={latest.issue ? 'insight-alert' : 'insight-clear'}><AlertTriangle size={15} />{latest.issue || 'No site issues were recorded in the latest report.'}</p><footer>Reported by {latest.supervisor} · {shortDate(latest.reportDate)}</footer></> : <EmptyVisual icon={FileText} title="No site report yet" text="The latest report will become the project’s live operational briefing." />}
    </section>
    <section className="workspace-surface health-visual"><SectionHeading kicker="Financial control" title="Budget position" /><div className="budget-ring" style={{ '--budget': `${burn * 3.6}deg` }}><div><strong>{burn}%</strong><span>utilised</span></div></div><div className="budget-legend"><span><i />Spent <b>{money(spent)}</b></span><span><i />Available <b>{money(Math.max(0, budget - spent))}</b></span></div></section>
    <section className="workspace-surface"><div className="workspace-section-heading"><div><span className="section-kicker">Action queue</span><h2>Priority work</h2></div><span className="section-count">{openTasks.length} open</span></div><div className="project-task-list">{openTasks.slice(0, 5).map(task => <div key={task.id}><i className={slug(task.priority)} /><div><strong>{task.title}</strong><span>{task.assignee} · {task.due}</span></div><Badge tone={slug(task.status)}>{task.status}</Badge></div>)}</div>{!openTasks.length && <EmptyVisual icon={CheckCircle2} title="Work queue clear" text="All project tasks have been completed or approved." />}</section>
    <section className="workspace-surface"><SectionHeading kicker="Programme pulse" title="Milestone status" icon={CalendarDays} /><div className="milestone-score"><strong>{completedMilestones}</strong><span>of {project.milestones.length} milestones complete</span></div><Progress value={project.milestones.length ? completedMilestones / project.milestones.length * 100 : 0} /><div className="next-milestones">{project.milestones.filter(item => item.status !== 'Completed').slice(0, 3).map(item => <div key={item.id}><span>{shortDate(item.dueDate)}</span><strong>{item.title}</strong><Badge tone={slug(item.status)}>{item.status}</Badge></div>)}</div></section>
  </div>;
}

function Programme({ project, can, refresh, onAdd }) {
  const advance = async milestone => { const next = { Pending: 'In progress', 'In progress': 'Completed', Delayed: 'In progress', Completed: 'Pending' }[milestone.status]; await patch(`/projects/milestones/${milestone.id}`, { status: next }); await refresh(); };
  return <div className="project-section-stack"><section className="workspace-surface programme-visual"><div className="workspace-section-heading"><div><span className="section-kicker">Master programme</span><h2>{shortDate(project.start_date)} — {shortDate(project.end_date)}</h2></div>{can.projects && <button className="secondary" onClick={onAdd}>Add milestone</button>}</div><div className="programme-track"><span style={{ width: `${project.progress}%` }} /><i style={{ left: `${project.progress}%` }} /></div><div className="programme-labels"><span>Mobilisation</span><strong>{project.progress}% delivered</strong><span>Target handover</span></div></section>
    <Table columns={['Milestone', 'Due', 'Status', '']} template="minmax(220px,2fr) 150px 130px 130px" title="Milestone register" empty="No milestones planned.">{project.milestones.map(item => <Row template="minmax(220px,2fr) 150px 130px 130px" key={item.id}><div><strong>{item.title}</strong><small>{item.notes || 'Project programme milestone'}</small></div><span>{shortDate(item.dueDate)}</span><Badge tone={slug(item.status)}>{item.status}</Badge>{can.projects ? <button className="status-button" onClick={() => advance(item)}>Advance</button> : <span>—</span>}</Row>)}</Table>
    <Table columns={['Task', 'Owner', 'Due', 'Priority', 'Status']} template="minmax(220px,2fr) 160px 140px 110px 130px" title="Delivery workstream" empty="No tasks assigned.">{project.tasks.map(task => <Row template="minmax(220px,2fr) 160px 140px 110px 130px" key={task.id}><strong>{task.title}</strong><span>{task.assignee}</span><span>{task.due}</span><Badge tone={slug(task.priority)}>{task.priority}</Badge><Badge tone={slug(task.status)}>{task.status}</Badge></Row>)}</Table></div>;
}

function Commercial({ project }) {
  const maxCost = Math.max(1, ...project.costBreakdown.map(row => Number(row.total)));
  const documents = [...project.boqs.map(row => ({ ...row, type: 'BOQ' })), ...project.quotations.map(row => ({ ...row, type: 'Quotation' }))];
  return <div className="project-section-stack"><section className="commercial-overview"><div className="workspace-surface"><SectionHeading kicker="Cost intelligence" title="Where the money is going" /><div className="cost-bars">{project.costBreakdown.map(row => <div key={row.source}><span>{row.source}</span><i><b style={{ width: `${Number(row.total) / maxCost * 100}%` }} /></i><strong>{money(row.total)}</strong></div>)}</div>{!project.costBreakdown.length && <EmptyVisual icon={CircleDollarSign} title="No costs recorded" text="Cost categories will appear here as the project starts spending." />}</div><div className="workspace-surface commercial-summary"><span className="section-kicker">Commercial position</span><div><small>BOQ value</small><strong>{money(project.boqs.reduce((sum, row) => sum + Number(row.total), 0))}</strong></div><div><small>Quoted value</small><strong>{money(project.quotations.reduce((sum, row) => sum + Number(row.total), 0))}</strong></div><div><small>Client outstanding</small><strong>{money(project.invoices.reduce((sum, row) => sum + Number(row.netPayable) - Number(row.paidAmount), 0))}</strong></div></div></section>
    <Table columns={['Document', 'Type', 'Value', 'Status']} template="minmax(220px,2fr) 150px 160px 130px" title="BOQs and client quotations" empty="No estimates or quotations linked to this project.">{documents.map(row => <Row template="minmax(220px,2fr) 150px 160px 130px" key={`${row.type}-${row.id}`}><div><strong>{row.title}</strong><small>{row.reference}</small></div><span>{row.type}</span><strong>{rupees(row.total)}</strong><Badge tone={slug(row.status)}>{row.status}</Badge></Row>)}</Table>
    <Table columns={['Invoice', 'Type', 'Net value', 'Paid', 'Status']} template="minmax(210px,1.7fr) 120px 150px 150px 120px" title="Client invoices" empty="No client invoices linked to this project.">{project.invoices.map(row => <Row template="minmax(210px,1.7fr) 120px 150px 150px 120px" key={row.id}><div><strong>{row.title}</strong><small>{row.reference}</small></div><span>{row.kind}</span><strong>{rupees(row.netPayable)}</strong><span>{rupees(row.paidAmount)}</span><Badge tone={slug(row.status)}>{row.status}</Badge></Row>)}</Table>
    <Table columns={['Purchase order', 'Supplier', 'Date', 'Value', 'Status']} template="minmax(170px,1.3fr) minmax(180px,1.5fr) 140px 150px 130px" title="Project procurement" empty="No purchase orders linked to this project.">{project.purchaseOrders.map(row => <Row template="minmax(170px,1.3fr) minmax(180px,1.5fr) 140px 150px 130px" key={row.id}><strong>{row.reference}</strong><span>{row.supplier}</span><span>{shortDate(row.orderDate)}</span><strong>{rupees(row.total)}</strong><Badge tone={slug(row.status)}>{row.status}</Badge></Row>)}</Table></div>;
}

function Team({ project, can, onAdd }) { return <section className="workspace-surface"><div className="workspace-section-heading"><div><span className="section-kicker">People on the project</span><h2>Delivery team</h2></div>{can.projects && <button className="secondary" onClick={onAdd}>Assign member</button>}</div><div className="team-card-grid">{project.team.map(member => <article key={member.id}><Avatar name={member.name} /><div><strong>{member.name}</strong><span>{member.projectRole}</span><small>{member.designation} · {member.code}</small></div></article>)}</div>{!project.team.length && <EmptyVisual icon={Users} title="No team assigned" text="Assign project members to make ownership visible here." />}</section>; }

function CompletionReport({ projectId }) {
  const [report, setReport] = useState(null); useEffect(() => { api(`/projects/${projectId}/completion`).then(setReport).catch(() => setReport(null)); }, [projectId]);
  if (!report) return <div className="project-workspace-state compact"><span className="workspace-loader" /><h2>Compiling close-out intelligence</h2></div>;
  const download = () => { const lines = [['GKUC Construction — project completion report'], [], ['Project', report.project.name], ['Client', report.project.client], ['Site', report.project.site], ['Manager', report.project.manager], ['Progress', `${report.project.progress}%`], [], ['Approved budget', report.financial.budget], ['Recorded cost', report.financial.spent], ['Income received', report.financial.income], ['Margin', report.financial.margin], [], ['Tasks completed', `${report.delivery.tasks.completed}/${report.delivery.tasks.total}`], ['Milestones completed', `${report.delivery.milestones.completed}/${report.delivery.milestones.total}`], ['Daily reports', report.delivery.reports]]; const csv = lines.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const link = document.createElement('a'); link.href = url; link.download = `completion-${slug(report.project.name)}.csv`; link.click(); URL.revokeObjectURL(url); };
  return <div className="project-section-stack"><section className="closeout-hero"><div><span className="section-kicker">Project close-out</span><h2>{report.project.progress === 100 ? 'Ready for handover' : `${100 - report.project.progress}% of delivery remains`}</h2><p>The live completion pack combines commercial, delivery and resource records.</p></div><button className="primary" onClick={download}><Download size={16} />Export report</button></section><div className="closeout-grid"><article><CheckCircle2 /><strong>{report.delivery.tasks.completed}/{report.delivery.tasks.total}</strong><span>tasks delivered</span></article><article><CalendarDays /><strong>{report.delivery.milestones.completed}/{report.delivery.milestones.total}</strong><span>milestones complete</span></article><article><FileText /><strong>{report.delivery.reports}</strong><span>daily reports</span></article><article><HardHat /><strong>{report.resources.labour.people}</strong><span>people recorded</span></article></div><Table columns={['Cost category', 'Total']} template="minmax(220px,1fr) 180px" title="Final cost position">{report.financial.byCategory.map(row => <Row template="minmax(220px,1fr) 180px" key={row.source}><span>{row.source}</span><strong>{rupees(row.total)}</strong></Row>)}</Table></div>;
}

function SectionHeading({ kicker, title, icon: Icon }) { return <div className="workspace-section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div>{Icon && <Icon size={22} />}</div>; }
function EmptyVisual({ icon: Icon, title, text }) { return <div className="empty-visual"><span><Icon size={22} /></span><strong>{title}</strong><p>{text}</p></div>; }
function MilestoneForm({ projectId, close, reload }) { return <FormModal title="Add milestone" close={close} label="Add milestone" onSubmit={async values => { await post(`/projects/${projectId}/milestones`, { title: values.title, dueDate: values.dueDate, status: values.status }); await reload(); }}><Field name="title" label="Milestone" wide /><Field name="dueDate" label="Due date" type="date" defaultValue={todayInput()} /><SelectField name="status" label="Status" options={['Pending', 'In progress', 'Completed', 'Delayed']} /></FormModal>; }
function TeamForm({ projectId, employees, close, reload }) { return <FormModal title="Assign team member" close={close} label="Assign member" onSubmit={async values => { await post(`/projects/${projectId}/team`, { employeeId: Number(values.employeeId), projectRole: values.projectRole }); await reload(); }}><SelectField name="employeeId" label="Employee" options={employees.map(employee => [employee.id, `${employee.name} — ${employee.designation}`])} /><Field name="projectRole" label="Role on this project" placeholder="Site engineer, foreman" /></FormModal>; }
