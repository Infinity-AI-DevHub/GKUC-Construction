import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, openDocument, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';

const TABS = ['Quotations', 'Tenders', 'Retention', 'Subcontractors'];

/** PID v3 §3.3 — one connected thread from first estimate to final account. */
export default function QuantitySurveying({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Quotations: can.quotation && 'Create quotation',
    Tenders: can.tender && 'File a tender',
    Retention: can.retention && 'Record retention',
    Subcontractors: can.subcontractors && 'Add subcontractor'
  };

  return <Page title="Quantity Surveying" subtitle="Quotations built from the BOQ, tender filing, retention and subcontractors."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Quotations' && <Quotations can={can} reload={reload} />}
    {tab === 'Tenders' && <Tenders can={can} />}
    {tab === 'Retention' && <Retention can={can} />}
    {tab === 'Subcontractors' && <Subcontractors can={can} data={data} />}

    {open === 'Quotations' && <QuotationForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Tenders' && <TenderForm close={() => setOpen('')} reload={reload} />}
    {open === 'Retention' && <RetentionForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Subcontractors' && <SubcontractorForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

const QUOTE_TEMPLATE = 'minmax(115px,.75fr) minmax(150px,1.2fr) minmax(120px,.9fr) 125px 100px 235px';

function Quotations({ can, reload }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('/qs/quotations').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const setStatus = async (id, status) => { await patch(`/qs/quotations/${id}`, { status }); await load(); await reload(); };

  return <>
    {error && <p className="form-error">{error}</p>}
    <Table columns={['Reference', 'Title', 'Client', 'Total', 'Status', '']} template={QUOTE_TEMPLATE}
      title="Client quotations" empty="No quotations yet. Create one from an approved BOQ.">
      {rows.map(row => <Row template={QUOTE_TEMPLATE} key={row.id}>
        <div><strong>{row.reference}</strong><small>{row.boqReference || '—'}</small></div>
        <span>{row.title}</span>
        <span>{row.client}</span>
        <strong>{rupees(row.total)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <span style={{ display: 'flex', gap: '6px' }}>
          <button className="status-button" onClick={async () => setDetail(await api(`/qs/quotations/${row.id}`))}>Open</button>
          <button className="status-button" title="Open the client-ready document"
            onClick={() => openDocument(`/qs/quotations/${row.id}/document`).catch(failure => setError(failure.message))}>
            <FileText size={13} />PDF
          </button>
          {can.quotation && row.status !== 'Accepted' && (
            <button className="status-button" title="Change the wording on the document"
              onClick={() => setEditing(row)}>Edit</button>
          )}
          {can.quotation && row.status !== 'Accepted' && (
            <button className="status-button" onClick={() => setStatus(row.id, 'Accepted')}>Accept</button>
          )}
        </span>
      </Row>)}
    </Table>
    {detail && <QuotationDetail quotation={detail} close={() => setDetail(null)} />}
    {editing && <QuotationWording quotation={editing} close={() => setEditing(null)} reload={async () => { await load(); await reload(); }} />}
  </>;
}

function QuotationDetail({ quotation, close }) {
  const template = 'minmax(90px,.6fr) minmax(160px,1.6fr) 100px 110px 120px';
  const download = () => {
    const lines = [
      ['GKUC Construction — Quotation'], [quotation.reference], [],
      ['Client', quotation.client], ['Title', quotation.title], ['Date', shortDate(quotation.quoteDate)],
      ['Valid until', quotation.validUntil ? shortDate(quotation.validUntil) : '—'], [],
      ['Category', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount'],
      ...quotation.items.map(item => [item.category, item.description, item.quantity, item.unit, item.rate, item.amount]),
      [],
      ['Subtotal', quotation.subtotal],
      [`Markup ${quotation.markupPercent}%`, (quotation.subtotal * quotation.markupPercent) / 100],
      [`VAT ${quotation.vatPercent}%`, ''],
      ['Total', quotation.total]
    ];
    const csv = lines.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${quotation.reference}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return <Modal title={`${quotation.reference} — ${quotation.title}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Client</span><strong>{quotation.client}</strong></div>
        <div><span>Status</span><strong>{quotation.status}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Built from</span><strong>{quotation.boqReference || 'Manual'}</strong></div>
        <div><span>Quoted</span><strong>{shortDate(quotation.quoteDate)}</strong></div>
      </div>
      <div className="wide">
        <Table columns={['Category', 'Description', 'Quantity', 'Rate', 'Amount']} template={template}
          title="Priced from the BOQ — nothing retyped">
          {quotation.items.map(item => <Row template={template} key={item.id}>
            <Badge tone={slug(item.category)}>{item.category}</Badge>
            <span>{item.description}</span>
            <span>{item.quantity} {item.unit}</span>
            <span>{rupees(item.rate)}</span>
            <strong>{rupees(item.amount)}</strong>
          </Row>)}
        </Table>
      </div>
      <div className="project-stats wide">
        <div><span>Subtotal</span><strong>{rupees(quotation.subtotal)}</strong></div>
        <div><span>Total incl. markup and VAT</span><strong>{rupees(quotation.total)}</strong></div>
      </div>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={close}>Close</button>
        <button type="button" className="primary" onClick={download}><Download size={16} />Download quotation</button>
      </div>
    </div>
  </Modal>;
}

const TENDER_TEMPLATE = 'minmax(120px,.8fr) minmax(200px,1.6fr) minmax(140px,1fr) 120px 130px 130px';
const TENDER_STATUSES = ['Identified', 'Preparing', 'Submitted', 'Won', 'Lost', 'Withdrawn'];

function Tenders({ can }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/qs/tenders').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const setStatus = async (id, status) => { await patch(`/qs/tenders/${id}`, { status }); await load(); };
  const days = value => Math.ceil((new Date(value) - new Date()) / 86400000);

  return <Table columns={['Reference', 'Tender', 'Client', 'Closes', 'Value', 'Status']} template={TENDER_TEMPLATE}
    title="Our tender submissions" empty="No tenders filed.">
    {rows.map(row => <Row template={TENDER_TEMPLATE} key={row.id}>
      <strong>{row.reference}</strong>
      <div><strong>{row.title}</strong><small>{row.source || '—'}</small></div>
      <span>{row.client}</span>
      <span className={days(row.closingDate) < 3 && !['Submitted', 'Won', 'Lost'].includes(row.status) ? 'overdue' : ''}>
        {shortDate(row.closingDate)}
      </span>
      <span>{rupees(row.bidValue || row.estimatedValue)}</span>
      {can.tender
        ? <select className="status-button" value={row.status} onChange={event => setStatus(row.id, event.target.value)}>
          {TENDER_STATUSES.map(status => <option key={status}>{status}</option>)}
        </select>
        : <Badge tone={slug(row.status)}>{row.status}</Badge>}
    </Row>)}
  </Table>;
}

const RETENTION_TEMPLATE = 'minmax(180px,1.4fr) minmax(140px,1fr) 130px 130px 130px 120px';

function Retention({ can }) {
  const [rows, setRows] = useState([]);
  const [releasing, setReleasing] = useState(null);
  const load = () => api('/qs/retentions').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const held = rows.reduce((sum, row) => sum + (Number(row.amount) - Number(row.releasedAmount)), 0);

  return <>
    <div className="attendance-summary">
      <Summary label="Still held" value={rupees(held)} icon={Download} />
      <Summary label="Retentions" value={rows.length} icon={Download} />
      <Summary label="Due in 30 days" value={rows.filter(row =>
        row.status !== 'Released' && (new Date(row.releaseDate) - new Date()) / 86400000 <= 30).length} icon={Download} />
      <Summary label="Released" value={rows.filter(row => row.status === 'Released').length} icon={Download} />
    </div>
    <Table columns={['Retention', 'Project', 'Held', 'Release date', 'Status', '']} template={RETENTION_TEMPLATE}
      title="Retention held against projects" empty="No retention recorded.">
      {rows.map(row => <Row template={RETENTION_TEMPLATE} key={row.id}>
        <div><strong>{row.description}</strong><small>{row.percent}%</small></div>
        <span>{row.project}</span>
        <strong>{rupees(Number(row.amount) - Number(row.releasedAmount))}</strong>
        <span className={row.status !== 'Released' && new Date(row.releaseDate) < new Date() ? 'overdue' : ''}>
          {shortDate(row.releaseDate)}
        </span>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.retention && row.status !== 'Released'
          ? <button className="status-button" onClick={() => setReleasing(row)}>Release</button>
          : <span>—</span>}
      </Row>)}
    </Table>
    {releasing && <ReleaseForm retention={releasing} close={() => setReleasing(null)} reload={load} />}
  </>;
}

function Subcontractors({ can, data }) {
  const [rows, setRows] = useState([]);
  const [bills, setBills] = useState([]);
  const [billing, setBilling] = useState(false);
  const load = () => {
    api('/qs/subcontractors').then(setRows).catch(() => setRows([]));
    api('/qs/subcontractor-bills').then(setBills).catch(() => setBills([]));
  };
  useLiveList(load);
  const template = 'minmax(180px,1.4fr) minmax(140px,1fr) 140px 120px 140px';
  const billTemplate = 'minmax(130px,.9fr) minmax(170px,1.3fr) minmax(140px,1fr) 130px 120px';

  return <>
    <Table columns={['Subcontractor', 'Trade', 'Phone', 'Bills', 'Outstanding']} template={template}
      title="Subcontractors" empty="No subcontractors on file.">
      {rows.map(row => <Row template={template} key={row.id}>
        <strong>{row.name}</strong>
        <span>{row.trade}</span>
        <span>{row.phone || '—'}</span>
        <span>{row.bills}</span>
        <span className={Number(row.outstanding) > 0 ? 'overdue' : ''}>{rupees(row.outstanding)}</span>
      </Row>)}
    </Table>
    <div style={{ height: '14px' }} />
    <Table columns={['Reference', 'Subcontractor', 'Project', 'Amount', 'Status']} template={billTemplate}
      title="Subcontractor bills"
      tools={can.subcontractors ? <button className="secondary" onClick={() => setBilling(true)}>Record bill</button> : null}
      empty="No bills recorded.">
      {bills.map(row => <Row template={billTemplate} key={row.id}>
        <strong>{row.reference}</strong>
        <span>{row.subcontractor}</span>
        <span>{row.project}</span>
        <strong>{rupees(row.amount)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
      </Row>)}
    </Table>
    {billing && <BillForm data={data} subcontractors={rows} close={() => setBilling(false)} reload={load} />}
  </>;
}

/* ----------------------------------------------------------------- forms */

function QuotationForm({ data, close, reload }) {
  const [boqs, setBoqs] = useState([]);
  useEffect(() => { api('/boq').then(setBoqs).catch(() => setBoqs([])); }, []);
  return <FormModal title="Create quotation from a BOQ" close={close} label="Build quotation" onSubmit={async values => {
    await post('/qs/quotations', {
      boqId: Number(values.boqId),
      clientName: values.clientName || undefined,
      title: values.title || undefined,
      quoteDate: values.quoteDate,
      validUntil: values.validUntil || undefined,
      markupPercent: Number(values.markupPercent || 0),
      vatPercent: Number(values.vatPercent || 0),
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="boqId" label="Bill of quantities" wide
      options={boqs.map(boq => [boq.id, `${boq.reference} — ${boq.title} (${rupees(boq.total)})`])} />
    <Field name="clientName" label="Client (leave blank to use the project's)" required={false} />
    <Field name="title" label="Quotation title" required={false} />
    <Field name="quoteDate" label="Quotation date" type="date" defaultValue={todayInput()} />
    <Field name="validUntil" label="Valid until" type="date" required={false} />
    <Field name="markupPercent" label="Markup %" type="number" step="0.01" min="0" defaultValue="10" required={false} />
    <Field name="vatPercent" label="VAT %" type="number" step="0.01" min="0" defaultValue="18" required={false} />
    <TextArea name="notes" label="Notes to the client" required={false} placeholder="Optional" />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Every priced line is copied from the BOQ, so nothing is retyped. If the client accepts,
      the quoted total becomes the project budget.
    </p>
  </FormModal>;
}

/**
 * The wording that appears on one quotation's document — not the figures, which come from
 * the BOQ, and not the standing terms every other document carries.
 */
function QuotationWording({ quotation, close, reload }) {
  return <FormModal title={`Edit ${quotation.reference}`} close={close} label="Save wording" onSubmit={async values => {
    await patch(`/qs/quotations/${quotation.id}`, {
      title: values.title,
      clientName: values.clientName,
      validUntil: values.validUntil || null,
      notes: values.notes || null,
      terms: values.terms || null
    });
    await reload();
  }}>
    <Field name="title" label="Quotation title" wide defaultValue={quotation.title} />
    <Field name="clientName" label="Client, as it should appear" defaultValue={quotation.client} />
    <Field name="validUntil" label="Valid until" type="date" required={false}
      defaultValue={quotation.validUntil ? quotation.validUntil.slice(0, 10) : ''} />
    <TextArea name="notes" label="Note to the client" rows={3} required={false} defaultValue={quotation.notes || ''} />
    <TextArea name="terms" label="Terms for this quotation only (leave blank to use the standing terms)"
      rows={3} required={false} defaultValue={quotation.terms || ''} />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      The priced lines come from the BOQ and are not edited here. An accepted quotation can no
      longer be reworded — raise a new one instead.
    </p>
  </FormModal>;
}

function TenderForm({ close, reload }) {
  return <FormModal title="File a tender" close={close} label="File tender" onSubmit={async values => {
    await post('/qs/tenders', {
      title: values.title,
      client: values.client,
      source: values.source || undefined,
      closingDate: values.closingDate,
      estimatedValue: Number(values.estimatedValue || 0),
      documentsNote: values.documentsNote || undefined
    });
    await reload();
  }}>
    <Field name="title" label="Tender title" wide />
    <Field name="client" label="Client / authority" />
    <Field name="source" label="Where it was found" required={false} placeholder="Daily News, direct invitation" />
    <Field name="closingDate" label="Closing date" type="date" defaultValue={todayInput()} />
    <Field name="estimatedValue" label="Estimated value (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <TextArea name="documentsNote" label="Documents required" required={false} placeholder="Optional" />
  </FormModal>;
}

function RetentionForm({ data, close, reload }) {
  return <FormModal title="Record retention" close={close} label="Record retention" onSubmit={async values => {
    await post('/qs/retentions', {
      projectId: Number(values.projectId),
      description: values.description,
      amount: Number(values.amount),
      percent: Number(values.percent || 0),
      heldFrom: values.heldFrom,
      releaseDate: values.releaseDate,
      defectLiabilityEnds: values.defectLiabilityEnds || undefined,
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="description" label="Description" />
    <Field name="amount" label="Amount held (LKR)" type="number" step="any" min="0" />
    <Field name="percent" label="Percent" type="number" step="0.01" min="0" defaultValue="5" required={false} />
    <Field name="heldFrom" label="Held from" type="date" defaultValue={todayInput()} />
    <Field name="releaseDate" label="Release date" type="date" />
    <Field name="defectLiabilityEnds" label="Defect liability ends" type="date" required={false} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}

function ReleaseForm({ retention, close, reload }) {
  const outstanding = Number(retention.amount) - Number(retention.releasedAmount);
  return <FormModal title={`Release retention — ${retention.project}`} close={close} label="Record release"
    onSubmit={async values => {
      await post(`/qs/retentions/${retention.id}/release`, { amount: Number(values.amount), notes: values.notes || undefined });
      await reload();
    }}>
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="any" min="0"
      defaultValue={outstanding} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}

function SubcontractorForm({ close, reload }) {
  return <FormModal title="Add subcontractor" close={close} label="Add subcontractor" onSubmit={async values => {
    await post('/qs/subcontractors', {
      name: values.name, trade: values.trade,
      contact: values.contact || undefined, phone: values.phone || undefined,
      email: values.email || undefined, notes: values.notes || undefined
    });
    await reload();
  }}>
    <Field name="name" label="Subcontractor" />
    <Field name="trade" label="Trade" placeholder="Waterproofing, electrical" />
    <Field name="contact" label="Contact person" required={false} />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}

function BillForm({ data, subcontractors, close, reload }) {
  return <FormModal title="Record subcontractor bill" close={close} label="Record bill" onSubmit={async values => {
    await post('/qs/subcontractor-bills', {
      subcontractorId: Number(values.subcontractorId),
      projectId: Number(values.projectId),
      reference: values.reference,
      description: values.description || undefined,
      amount: Number(values.amount),
      billDate: values.billDate,
      dueDate: values.dueDate || undefined
    });
    await reload();
  }}>
    <SelectField name="subcontractorId" label="Subcontractor" options={subcontractors.map(row => [row.id, row.name])} />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="reference" label="Bill reference" />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="billDate" label="Bill date" type="date" defaultValue={todayInput()} />
    <Field name="dueDate" label="Due date" type="date" required={false} />
    <TextArea name="description" label="Work covered" required={false} placeholder="Optional" />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      The bill posts against the project budget automatically, so subcontractor spend shows
      up in cost monitoring without a second entry.
    </p>
  </FormModal>;
}
