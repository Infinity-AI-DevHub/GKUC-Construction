import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, money, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Modal, Progress, Row, SelectField, Table, Tabs, Field, FormModal } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import ProjectGallery from '../ProjectGallery.jsx';

const TABS = ['Overview', 'Timeline', 'Team', 'Gallery', 'Documents', 'Completion report'];

/** Everything known about one project, gathered from the modules that feed it. */
export default function ProjectDetail({ projectId, data, close, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [project, setProject] = useState(null);
  const [adding, setAdding] = useState('');

  const load = () => api(`/projects/${projectId}`).then(setProject).catch(() => setProject(null));
  useEffect(() => { load(); }, [projectId]);

  if (!project) return <Modal title="Loading project…" close={close}><div className="report-form" /></Modal>;

  const refresh = async () => { await load(); await reload(); };

  /* Wider than a form dialog: this holds a photo grid and a timeline. */
  return <Modal title={project.name} close={close} wide>
    <div className="report-form">
      <div className="wide"><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>

      {tab === 'Overview' && <Overview project={project} />}
      {tab === 'Timeline' && <Timeline project={project} can={can} refresh={refresh} onAdd={() => setAdding('milestone')} />}
      {tab === 'Team' && <Team project={project} can={can} onAdd={() => setAdding('team')} />}
      {tab === 'Gallery' && <div className="wide">
        <ProjectGallery projectId={project.id} canManage={can.gallery} />
      </div>}
      {tab === 'Documents' && <div className="wide">
        <Attachments ownerType="project" ownerId={project.id} title="Project documents"
          canUpload={can.projects} canDelete={can.projects} withCategory />
      </div>}
      {tab === 'Completion report' && <CompletionReport projectId={project.id} />}

      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>

    {adding === 'milestone' && <MilestoneForm projectId={project.id} close={() => setAdding('')} reload={refresh} />}
    {adding === 'team' && <TeamForm projectId={project.id} employees={data.employees} close={() => setAdding('')} reload={refresh} />}
  </Modal>;
}

function Overview({ project }) {
  const spent = Number(project.finance.expenses);
  const budget = Number(project.finance.budget);
  return <>
    <div className="project-stats wide">
      <div><span>Client</span><strong>{project.client}</strong></div>
      <div><span>Site</span><strong>{project.site}</strong></div>
    </div>
    <div className="project-stats wide">
      <div><span>Manager</span><strong>{project.manager}</strong></div>
      <div><span>Stage</span><strong>{project.stage}</strong></div>
    </div>
    <div className="project-stats wide">
      <div><span>Starts</span><strong>{shortDate(project.start_date)}</strong></div>
      <div><span>Target completion</span><strong>{shortDate(project.end_date)}</strong></div>
    </div>
    <div className="wide">
      <div className="card-progress">
        <span>Overall progress</span><b>{project.progress}%</b>
        <Progress value={project.progress} />
      </div>
    </div>
    <div className="project-stats wide">
      <div><span>Approved budget</span><strong>{rupees(budget)}</strong></div>
      <div><span>Recorded cost</span><strong className={spent > budget ? 'overdue' : ''}>{rupees(spent)}</strong></div>
    </div>
    <div className="wide">
      <Table columns={['Bill of quantities', 'Status', 'Total']} template="minmax(200px,2fr) 130px 150px" title="Estimates"
        empty="No BOQ prepared for this project.">
        {project.boqs.map(boq => <Row template="minmax(200px,2fr) 130px 150px" key={boq.id}>
          <div><strong>{boq.title}</strong><small>{boq.reference}</small></div>
          <Badge tone={slug(boq.status)}>{boq.status}</Badge>
          <strong>{rupees(boq.total)}</strong>
        </Row>)}
      </Table>
    </div>
  </>;
}

/** PID 2.4 "Project Timeline" — milestones on the calendar they belong to. */
function Timeline({ project, can, refresh, onAdd }) {
  const advance = async milestone => {
    const next = { Pending: 'In progress', 'In progress': 'Completed', Delayed: 'In progress', Completed: 'Pending' }[milestone.status];
    await patch(`/projects/milestones/${milestone.id}`, { status: next });
    await refresh();
  };

  const dates = [project.start_date, project.end_date, ...project.milestones.map(m => m.dueDate)]
    .filter(Boolean).map(value => new Date(value).getTime());
  const start = Math.min(...dates);
  const end = Math.max(...dates);
  const span = Math.max(1, end - start);
  const position = value => ((new Date(value).getTime() - start) / span) * 100;

  return <>
    <div className="wide timeline-head">
      <span>{shortDate(project.start_date)}</span>
      <strong>Project timeline</strong>
      <span>{shortDate(project.end_date)}</span>
    </div>
    <div className="wide project-timeline">
      <div className="timeline-track">
        <i className="timeline-progress" style={{ width: `${project.progress}%` }} />
        {project.milestones.map(milestone => (
          <span key={milestone.id} className={`timeline-pin ${slug(milestone.status)}`}
            style={{ left: `${Math.min(98, Math.max(0, position(milestone.dueDate)))}%` }}
            title={`${milestone.title} — ${shortDate(milestone.dueDate)}`} />
        ))}
      </div>
      <small>Today marks {project.progress}% complete</small>
    </div>

    <div className="wide">
      <Table columns={['Milestone', 'Due', 'Status', '']} template="minmax(200px,2fr) 130px 120px 120px"
        title="Milestones" tools={can.projects ? <button className="secondary" onClick={onAdd}>Add milestone</button> : null}
        empty="No milestones planned.">
        {project.milestones.map(milestone => <Row template="minmax(200px,2fr) 130px 120px 120px" key={milestone.id}>
          <strong>{milestone.title}</strong>
          <span className={milestone.status !== 'Completed' && new Date(milestone.dueDate) < new Date() ? 'overdue' : ''}>
            {shortDate(milestone.dueDate)}
          </span>
          <Badge tone={slug(milestone.status)}>{milestone.status}</Badge>
          {can.projects ? <button className="status-button" onClick={() => advance(milestone)}>Advance</button> : <span>—</span>}
        </Row>)}
      </Table>
    </div>
  </>;
}

function Team({ project, can, onAdd }) {
  const template = 'minmax(180px,1.4fr) minmax(140px,1fr) minmax(140px,1fr)';
  return <div className="wide">
    <Table columns={['Member', 'Designation', 'Role on project']} template={template} title="Assigned team"
      tools={can.projects ? <button className="secondary" onClick={onAdd}>Assign member</button> : null}
      empty="Nobody assigned to this project yet.">
      {project.team.map(member => <Row template={template} key={member.id}>
        <div className="person"><Avatar name={member.name} /><div><strong>{member.name}</strong><small>{member.code}</small></div></div>
        <span>{member.designation}</span>
        <span>{member.projectRole}</span>
      </Row>)}
    </Table>
  </div>;
}

/** PID 2.4 "Completion Reports" — the close-out pack, built from live data. */
function CompletionReport({ projectId }) {
  const [report, setReport] = useState(null);
  useEffect(() => { api(`/projects/${projectId}/completion`).then(setReport).catch(() => setReport(null)); }, [projectId]);
  if (!report) return <p className="wide empty-state">Compiling completion report…</p>;

  const download = () => {
    const lines = [
      ['GKUC Construction — project completion report'], [],
      ['Project', report.project.name], ['Client', report.project.client], ['Site', report.project.site],
      ['Manager', report.project.manager], ['Progress', `${report.project.progress}%`], [],
      ['Approved budget', report.financial.budget], ['Estimated (approved BOQ)', report.financial.estimated],
      ['Recorded cost', report.financial.spent], ['Income received', report.financial.income],
      ['Margin', report.financial.margin], ['Margin %', report.financial.marginPercent], [],
      ['Cost category', 'Total'], ...report.financial.byCategory.map(row => [row.source, row.total]), [],
      ['Tasks completed', `${report.delivery.tasks.completed}/${report.delivery.tasks.total}`],
      ['Milestones completed', `${report.delivery.milestones.completed}/${report.delivery.milestones.total}`],
      ['Daily reports filed', report.delivery.reports], ['Issues raised', report.delivery.issuesRaised],
      ['Delay hours recorded', report.delivery.delayHours], [],
      ['Material', 'Quantity issued'], ...report.resources.materials.map(row => [row.name, `${row.quantity} ${row.unit}`])
    ];
    const csv = lines.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `completion-${slug(report.project.name)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return <>
    <div className="project-stats wide">
      <div><span>Approved budget</span><strong>{money(report.financial.budget)}</strong></div>
      <div><span>Recorded cost</span><strong>{money(report.financial.spent)}</strong></div>
    </div>
    <div className="project-stats wide">
      <div><span>Income received</span><strong>{money(report.financial.income)}</strong></div>
      <div><span>Margin</span><strong className={report.financial.margin < 0 ? 'overdue' : ''}>
        {money(report.financial.margin)} ({report.financial.marginPercent}%)
      </strong></div>
    </div>

    <div className="wide">
      <Table columns={['Delivery', 'Result']} template="minmax(200px,1fr) 200px" title="Delivery summary">
        <Row template="minmax(200px,1fr) 200px"><span>Tasks completed</span>
          <strong>{report.delivery.tasks.completed} of {report.delivery.tasks.total}</strong></Row>
        <Row template="minmax(200px,1fr) 200px"><span>Milestones completed</span>
          <strong>{report.delivery.milestones.completed} of {report.delivery.milestones.total}</strong></Row>
        <Row template="minmax(200px,1fr) 200px"><span>Daily reports filed</span><strong>{report.delivery.reports}</strong></Row>
        <Row template="minmax(200px,1fr) 200px"><span>Issues raised</span><strong>{report.delivery.issuesRaised}</strong></Row>
        <Row template="minmax(200px,1fr) 200px"><span>Delay hours recorded</span><strong>{report.delivery.delayHours} h</strong></Row>
        <Row template="minmax(200px,1fr) 200px"><span>Labour shifts worked</span>
          <strong>{report.resources.labour.shifts} ({report.resources.labour.people} people)</strong></Row>
      </Table>
    </div>

    <div className="wide">
      <Table columns={['Cost category', 'Total']} template="minmax(200px,1fr) 200px" title="Where the money went"
        empty="No costs recorded.">
        {report.financial.byCategory.map(row => <Row template="minmax(200px,1fr) 200px" key={row.source}>
          <Badge tone={slug(row.source)}>{row.source}</Badge><strong>{rupees(row.total)}</strong>
        </Row>)}
      </Table>
    </div>

    <div className="wide">
      <Table columns={['Material consumed', 'Quantity']} template="minmax(200px,1fr) 200px" title="Material consumption"
        empty="No material issued to this project.">
        {report.resources.materials.map(row => <Row template="minmax(200px,1fr) 200px" key={row.name}>
          <span>{row.name}</span><strong>{row.quantity} {row.unit}</strong>
        </Row>)}
      </Table>
    </div>

    <div className="wide" style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <button type="button" className="primary" onClick={download}><Download size={16} />Export completion report</button>
    </div>
  </>;
}

function MilestoneForm({ projectId, close, reload }) {
  return <FormModal title="Add milestone" close={close} label="Add milestone" onSubmit={async values => {
    await post(`/projects/${projectId}/milestones`, {
      title: values.title, dueDate: values.dueDate, status: values.status
    });
    await reload();
  }}>
    <Field name="title" label="Milestone" wide />
    <Field name="dueDate" label="Due date" type="date" defaultValue={todayInput()} />
    <SelectField name="status" label="Status" options={['Pending', 'In progress', 'Completed', 'Delayed']} />
  </FormModal>;
}

function TeamForm({ projectId, employees, close, reload }) {
  return <FormModal title="Assign team member" close={close} label="Assign member" onSubmit={async values => {
    await post(`/projects/${projectId}/team`, {
      employeeId: Number(values.employeeId), projectRole: values.projectRole
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={employees.map(employee => [employee.id, `${employee.name} — ${employee.designation}`])} />
    <Field name="projectRole" label="Role on this project" placeholder="Site engineer, foreman" />
  </FormModal>;
}
