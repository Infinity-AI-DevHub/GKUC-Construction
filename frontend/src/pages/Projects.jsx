import React, { useEffect, useState } from 'react';
import { BriefcaseBusiness, Building2, Check, FileText } from 'lucide-react';
import { api, money, openDocument, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Page, Progress, Row, SelectField, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import ProjectDetail from './ProjectDetail.jsx';
import { useOptions } from '../options.js';

const TABS = ['Projects', 'Milestones', 'BOQ & estimates', 'Variations', 'Inquiries'];
const healthTone = health => (health === 'On track' ? 'on-track' : health === 'At risk' ? 'at-risk' : 'watch');

/** PID 2.4 / 2.5 — projects, their milestones, and the estimates the budget comes from. */
export default function Projects({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');

  const [detailId, setDetailId] = useState(null);
  const actionFor = {
    Projects: 'New project', Milestones: 'Add milestone', 'BOQ & estimates': 'Create BOQ',
    Variations: null, Inquiries: 'Log inquiry'
  }[tab];

  return <Page title="Projects" subtitle="Monitor progress, cost, and site health across active work."
    action={can.projects ? actionFor : null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Projects' && <ProjectCards data={data} onOpen={setDetailId} />}
    {tab === 'Milestones' && <Milestones data={data} reload={reload} can={can} />}
    {tab === 'BOQ & estimates' && <BoqList data={data} reload={reload} can={can} />}
    {tab === 'Variations' && <Variations can={can} reload={reload} />}
    {tab === 'Inquiries' && <Inquiries data={data} can={can} reload={reload} />}

    {open === 'Projects' && <ProjectForm close={() => setOpen('')} reload={reload} />}
    {open === 'Milestones' && <MilestoneForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'BOQ & estimates' && <BoqForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Inquiries' && <InquiryForm close={() => setOpen('')} reload={reload} />}
    {detailId && <ProjectDetail projectId={detailId} data={data} can={can} reload={reload} close={() => setDetailId(null)} />}
  </Page>;
}

function ProjectCards({ data, onOpen }) {
  const finance = Object.fromEntries(data.finance.map(row => [row.projectId, row]));
  return <div className="project-cards">
    {data.projects.map(project => {
      const spend = Number(finance[project.id]?.expenses || project.actual);
      return <article className="project-card" key={project.id} onClick={() => onOpen(project.id)} style={{ cursor: 'pointer' }}>
        <div className="card-top">
          <span className="project-mark"><Building2 size={20} /></span>
          <Badge tone={healthTone(project.health)}>{project.health}</Badge>
        </div>
        <h3>{project.name}</h3>
        <p>{project.client} · {project.site}</p>
        <div className="card-progress">
          <span>Overall progress</span><b>{project.progress}%</b>
          <Progress value={project.progress} />
        </div>
        <div className="project-stats">
          <div><span>Approved budget</span><strong>{money(project.budget)}</strong></div>
          <div><span>Recorded cost</span><strong>{money(spend)}</strong></div>
        </div>
        <div className="card-footer">
          <span><BriefcaseBusiness size={15} />{project.stage}</span>
          <span><Avatar name={project.manager} />{project.manager}</span>
        </div>
      </article>;
    })}
  </div>;
}

const MILESTONE_COLUMNS = ['Milestone', 'Project', 'Due date', 'Status', ''];
const MILESTONE_TEMPLATE = 'minmax(220px,1.6fr) minmax(160px,1fr) 130px 120px 120px';

function Milestones({ data, reload, can }) {
  const advance = async milestone => {
    const next = { Pending: 'In progress', 'In progress': 'Completed', Delayed: 'In progress', Completed: 'Pending' }[milestone.status];
    await patch(`/projects/milestones/${milestone.id}`, { status: next });
    await reload();
  };
  return <Table columns={MILESTONE_COLUMNS} template={MILESTONE_TEMPLATE} title="Project milestones"
    empty="No milestones planned yet.">
    {data.milestones.map(milestone => <Row template={MILESTONE_TEMPLATE} key={milestone.id}>
      <strong>{milestone.title}</strong>
      <span>{milestone.project}</span>
      <span>{shortDate(milestone.dueDate)}</span>
      <Badge tone={slug(milestone.status)}>{milestone.status}</Badge>
      {can.projects
        ? <button className="status-button" onClick={() => advance(milestone)}>Advance</button>
        : <span>—</span>}
    </Row>)}
  </Table>;
}

const BOQ_COLUMNS = ['Reference', 'Project', 'Title', 'Estimated total', 'Status', ''];
const BOQ_TEMPLATE = 'minmax(130px,.8fr) minmax(140px,1fr) minmax(180px,1.3fr) 140px 105px 165px';

function BoqList({ data, reload, can }) {
  const [detail, setDetail] = useState(null);
  const [wording, setWording] = useState(null);
  const [error, setError] = useState('');
  const openDetail = async id => setDetail(await api(`/boq/${id}`));
  const decide = async (id, status) => { await patch(`/boq/${id}`, { status }); await reload(); setDetail(null); };

  return <>
    {error && <p className="form-error">{error}</p>}
    <Table columns={BOQ_COLUMNS} template={BOQ_TEMPLATE} title="Bills of quantities"
      empty="No BOQ prepared yet. Create one to set a project budget.">
      {data.boqs.map(boq => <Row template={BOQ_TEMPLATE} key={boq.id}>
        <div><strong>{boq.reference}</strong><small>v{boq.version}</small></div>
        <span>{boq.project}</span>
        <span>{boq.title}</span>
        <strong>{rupees(boq.total)}</strong>
        <Badge tone={slug(boq.status)}>{boq.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={() => openDetail(boq.id)}>Open</button>
          <button className="status-button" title="Open the printable bill of quantities"
            onClick={() => openDocument(`/boq/${boq.id}/document`).catch(failure => setError(failure.message))}>
            <FileText size={13} />PDF
          </button>
        </span>
      </Row>)}
    </Table>
    {detail && <BoqDetail boq={detail} close={() => setDetail(null)} decide={decide} can={can}
      edit={() => { setWording(detail); setDetail(null); }} />}
    {wording && <BoqWording boq={wording} close={() => setWording(null)}
      reload={async () => { await reload(); setWording(null); }} />}
  </>;
}

/** The wording on the printed bill — the priced lines are not touched here. */
function BoqWording({ boq, close, reload }) {
  return <FormModal title={`Edit ${boq.reference}`} close={close} label="Save wording" onSubmit={async values => {
    await patch(`/boq/${boq.id}/wording`, {
      title: values.title,
      notes: values.notes || null,
      terms: values.terms || null
    });
    await reload();
  }}>
    <Field name="title" label="Title" wide defaultValue={boq.title} />
    <TextArea name="notes" label="Notes printed under the bill" rows={3} required={false} defaultValue={boq.notes || ''} />
    <TextArea name="terms" label="Terms for this bill only (leave blank to use the standing terms)"
      rows={3} required={false} defaultValue={boq.terms || ''} />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      An approved BOQ cannot be reworded — raise a revision instead.
    </p>
  </FormModal>;
}

function BoqDetail({ boq, close, decide, can, edit }) {
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <div className="modal">
      <div className="modal-title"><h2>{boq.reference} — {boq.title}</h2><button className="icon-btn" onClick={close}>✕</button></div>
      <div className="report-form">
        <div className="project-stats wide">
          <div><span>Estimated total</span><strong>{rupees(boq.total)}</strong></div>
          <div><span>Status</span><strong>{boq.status}</strong></div>
        </div>
        <div className="wide">
          <Table columns={['Category', 'Description', 'Quantity', 'Rate', 'Amount']} template="minmax(90px,.7fr) minmax(120px,1.5fr) minmax(70px,.7fr) minmax(70px,.8fr) minmax(80px,.9fr)">
            {boq.items.map(item => <Row template="minmax(90px,.7fr) minmax(120px,1.5fr) minmax(70px,.7fr) minmax(70px,.8fr) minmax(80px,.9fr)" key={item.id}>
              <Badge tone={slug(item.category)}>{item.category}</Badge>
              <span>{item.description}</span>
              <span>{item.quantity} {item.unit}</span>
              <span>{rupees(item.rate)}</span>
              <strong>{rupees(item.amount)}</strong>
            </Row>)}
          </Table>
        </div>
        <div className="wide">
          <Table columns={['Category', 'Estimated', 'Actual to date', 'Variance']} template="repeat(4,1fr)" title="Estimate against actual">
            {boq.comparison.map(row => <Row template="repeat(4,1fr)" key={row.category}>
              <span>{row.category}</span>
              <span>{rupees(row.estimated)}</span>
              <span>{rupees(row.actual)}</span>
              <strong className={row.actual > row.estimated ? 'overdue' : ''}>{rupees(row.estimated - row.actual)}</strong>
            </Row>)}
          </Table>
        </div>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>Close</button>
          <button type="button" className="secondary"
            onClick={() => openDocument(`/boq/${boq.id}/document`)}><FileText size={16} />Print / PDF</button>
          {can.qs && boq.status !== 'Approved' && (
            <button type="button" className="secondary" onClick={edit}>Edit wording</button>
          )}
          {can.manage && boq.status !== 'Approved' && (
            <button type="button" className="primary" onClick={() => decide(boq.id, 'Approved')}><Check size={17} />Approve BOQ</button>
          )}
        </div>
      </div>
    </div>
  </div>;
}

const VARIATION_TEMPLATE = 'minmax(120px,.8fr) minmax(150px,1fr) minmax(220px,2fr) 140px 110px 130px';

/** PID 2.5 "Variation Orders" — approved changes move the approved budget. */
function Variations({ can, reload }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/boq/variations/all').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const decide = async (id, status) => { await patch(`/boq/variations/${id}`, { status }); await load(); await reload(); };

  return <Table columns={['Reference', 'Project', 'Description', 'Amount', 'Status', '']} template={VARIATION_TEMPLATE}
    title="Variation orders" empty="No variations raised. Open a BOQ to raise one.">
    {rows.map(row => <Row template={VARIATION_TEMPLATE} key={row.id}>
      <div><strong>{row.reference}</strong><small>{row.raisedBy}</small></div>
      <span>{row.project}</span>
      <span>{row.description}</span>
      <strong>{rupees(row.amount)}</strong>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      {can.manage && row.status === 'Pending'
        ? <span className="row-actions">
          <button className="status-button" onClick={() => decide(row.id, 'Approved')}>Approve</button>
          <button className="status-button" onClick={() => decide(row.id, 'Rejected')}>Reject</button>
        </span>
        : <span>—</span>}
    </Row>)}
  </Table>;
}

const INQUIRY_TEMPLATE = 'minmax(120px,.8fr) minmax(170px,1.3fr) minmax(130px,1fr) 140px 130px 150px';
const INQUIRY_STATUSES = ['New', 'In discussion', 'Quoted', 'Won', 'Lost'];

/** PID section 3 step 1 — the customer inquiry that starts the project lifecycle. */
function Inquiries({ data, can, reload }) {
  const [rows, setRows] = useState([]);
  const [converting, setConverting] = useState(null);
  const load = () => api('/inquiries').then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, [data.inquiries]);
  const setStatus = async (id, status) => { await patch(`/inquiries/${id}`, { status }); await load(); };

  return <>
    <Table columns={['Reference', 'Customer', 'Location', 'Expected value', 'Status', '']} template={INQUIRY_TEMPLATE}
      title="Customer inquiries" empty="No inquiries logged yet.">
      {rows.map(row => <Row template={INQUIRY_TEMPLATE} key={row.id}>
        <strong>{row.reference}</strong>
        <div><strong>{row.customer}</strong><small>{row.contact || '—'}</small></div>
        <span>{row.location}</span>
        <span>{rupees(row.expectedValue)}</span>
        {can.projects
          ? <select className="status-button" value={row.status} onChange={event => setStatus(row.id, event.target.value)}>
            {INQUIRY_STATUSES.map(status => <option key={status}>{status}</option>)}
          </select>
          : <Badge tone={slug(row.status)}>{row.status}</Badge>}
        {row.projectId
          ? <span>{row.project}</span>
          : can.projects && row.status !== 'Lost'
            ? <button className="status-button" onClick={() => setConverting(row)}>Register project</button>
            : <span>—</span>}
      </Row>)}
    </Table>
    {converting && <ConvertForm inquiry={converting} close={() => setConverting(null)}
      reload={async () => { await load(); await reload(); }} />}
  </>;
}

function InquiryForm({ close, reload }) {
  return <FormModal title="Log customer inquiry" close={close} label="Log inquiry" onSubmit={async values => {
    await post('/inquiries', {
      customer: values.customer,
      contact: values.contact || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
      location: values.location,
      description: values.description,
      expectedValue: Number(values.expectedValue || 0),
      expectedStart: values.expectedStart || undefined,
      source: values.source || undefined
    });
    await reload();
  }}>
    <Field name="customer" label="Customer" />
    <Field name="contact" label="Contact person" required={false} />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <Field name="location" label="Location" />
    <Field name="expectedValue" label="Expected value (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <Field name="expectedStart" label="Expected start" type="date" required={false} />
    <Field name="source" label="How they found us" required={false} placeholder="Referral, website" />
    <TextArea name="description" label="What the customer wants" />
  </FormModal>;
}

function ConvertForm({ inquiry, close, reload }) {
  return <FormModal title={`Register project from ${inquiry.reference}`} close={close} label="Register project" onSubmit={async values => {
    await post(`/inquiries/${inquiry.id}/convert`, {
      name: values.name,
      manager: values.manager,
      stage: values.stage,
      budget: Number(values.budget || 0),
      startDate: values.startDate || undefined,
      endDate: values.endDate || undefined
    });
    await reload();
  }}>
    <Field name="name" label="Project name" wide defaultValue={`${inquiry.customer} — ${inquiry.location}`} />
    <Field name="manager" label="Project manager" />
    <Field name="stage" label="Starting stage" defaultValue="Pre-construction" />
    <Field name="budget" label="Opening budget (LKR)" type="number" min="0" defaultValue={inquiry.expectedValue} />
    <Field name="startDate" label="Start date" type="date" defaultValue={todayInput()} required={false} />
    <Field name="endDate" label="Target completion" type="date" required={false} />
  </FormModal>;
}

function ProjectForm({ close, reload }) {
  return <FormModal title="Create project" close={close} label="Create project" onSubmit={async values => {
    await post('/projects', {
      name: values.name,
      client: values.client,
      manager: values.manager,
      site: values.site,
      stage: values.stage,
      budget: Number(values.budget),
      startDate: values.startDate,
      endDate: values.endDate
    });
    await reload();
  }}>
    <Field name="name" label="Project name" />
    <Field name="client" label="Client" />
    <Field name="manager" label="Project manager" />
    <Field name="site" label="Site location" />
    <Field name="stage" label="Current stage" />
    <Field name="budget" label="Opening budget (LKR)" type="number" min="0" />
    <Field name="startDate" label="Start date" type="date" defaultValue={todayInput()} />
    <Field name="endDate" label="Target completion" type="date" defaultValue={todayInput()} />
  </FormModal>;
}

function MilestoneForm({ data, close, reload }) {
  return <FormModal title="Add milestone" close={close} label="Add milestone" onSubmit={async values => {
    await post(`/projects/${values.projectId}/milestones`, {
      title: values.title,
      dueDate: values.dueDate,
      status: values.status,
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="title" label="Milestone" />
    <Field name="dueDate" label="Due date" type="date" defaultValue={todayInput()} />
    <SelectField name="status" label="Status" options={['Pending', 'In progress', 'Completed', 'Delayed']} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}

const CATEGORIES = ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead'];

/** A BOQ is created with its first priced line; further lines are added from the detail view. */
export function BoqForm({ data, close, reload }) {
  const boqCategories = useOptions('boq.category');
  const units = useOptions('boq.unit');
  const [lines, setLines] = useState([{ category: '', description: '', unit: '', quantity: '', rate: '' }]);
  const update = (index, key, value) => setLines(current => current.map((line, position) => (position === index ? { ...line, [key]: value } : line)));
  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.rate) || 0), 0);

  return <FormModal title="Create BOQ" close={close} label="Create BOQ" onSubmit={async values => {
    await post('/boq', {
      projectId: Number(values.projectId),
      title: values.title,
      notes: values.notes || undefined,
      items: lines.filter(line => line.description && line.quantity).map(line => ({
        category: line.category,
        description: line.description,
        unit: line.unit || 'item',
        quantity: Number(line.quantity),
        rate: Number(line.rate) || 0
      }))
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="title" label="BOQ title" />
    {lines.map((line, index) => <div className="wide" key={index} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 80px 90px 110px', gap: '8px' }}>
      <label>Category
        <select value={line.category} onChange={event => update(index, 'category', event.target.value)}>
          {boqCategories.map(category => <option key={category}>{category}</option>)}
        </select>
      </label>
      <label>Description<input value={line.description} onChange={event => update(index, 'description', event.target.value)} /></label>
      <label>Unit<input value={line.unit} onChange={event => update(index, 'unit', event.target.value)} placeholder="m³" /></label>
      <label>Quantity<input type="number" step="any" value={line.quantity} onChange={event => update(index, 'quantity', event.target.value)} /></label>
      <label>Rate<input type="number" step="any" value={line.rate} onChange={event => update(index, 'rate', event.target.value)} /></label>
    </div>)}
    <div className="wide" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <button type="button" className="secondary" onClick={() => setLines(current => [...current, { category: 'Material', description: '', unit: '', quantity: '', rate: '' }])}>Add line</button>
      <strong>Estimated total {rupees(total)}</strong>
    </div>
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}
