import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, openDocument, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import BoqImport from '../BoqImport.jsx';
import BoqChanges from '../BoqChanges.jsx';

/* The bills already on the system, so this tab shows what exists as well as how to add. */
function BoqList() {
  const [boqs, setBoqs] = useState([]);
  useLiveList(() => api('/boq').then(setBoqs).catch(() => setBoqs([])));
  if (!boqs.length) return null;
  return <Table title="Bills of quantities" columns={['Reference', 'Project', 'Title', 'Total', 'Status']}
    rows={boqs.map(boq => [boq.reference, boq.project, boq.title, rupees(boq.total),
      <Badge key="s" tone={boq.status === 'Approved' ? 'on-track' : 'watch'}>{boq.status}</Badge>])} />;
}
import { BoqForm } from './Projects.jsx';

const TABS = ['Quotations', 'Bills of quantities', 'Tenders', 'Retention', 'Subcontractors'];

/** PID v3 §3.3 — one connected thread from first estimate to final account. */
export default function QuantitySurveying({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Quotations: can.quotation && 'Create quotation',
    Tenders: can.tender && 'Track a tender',
    Retention: can.retention && 'Record retention',
    Subcontractors: can.subcontractors && 'Add subcontractor'
  };

  return <Page title="Quantity Surveying" subtitle="Quotations built from the BOQ, tender filing, retention and subcontractors."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Quotations' && <Quotations can={can} reload={reload} />}
    {tab === 'Bills of quantities' && <>
      <BoqImport projects={data.projects} onDone={reload} onCreate={() => setOpen('Create BOQ')} />
      <BoqList />
      <BoqChanges can={can} reload={reload} />
    </>}
    {tab === 'Tenders' && <Tenders can={can} />}
    {tab === 'Retention' && <Retention can={can} />}
    {tab === 'Subcontractors' && <Subcontractors can={can} data={data} />}

    {open === 'Create BOQ' && <BoqForm data={data} close={() => setOpen('')} reload={reload} />}
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

  /* A refused status change has to say so; it used to reject into nothing. */
  const setStatus = async (id, status) => {
    setError('');
    try {
      await patch(`/qs/quotations/${id}`, { status });
      await load();
      await reload();
    } catch (failure) { setError(failure.message); }
  };
  const openQuotation = async id => {
    setError('');
    try { setDetail(await api(`/qs/quotations/${id}`)); }
    catch (failure) { setError(failure.message); }
  };

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
        <span className="row-actions">
          <button className="status-button" onClick={() => openQuotation(row.id)}>Open</button>
          <button className="status-button" title="Open the client-ready document"
            onClick={() => openDocument(`/qs/quotations/${row.id}/document`)}>
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

/* Modest flex weights: the row sizes to its content so that it keeps its backgrounds when
   it scrolls, and a heavy fr on the title track inflates the whole table past the panel. */
const TENDER_TEMPLATE = 'minmax(140px,.85fr) minmax(210px,1.2fr) minmax(120px,.8fr) 140px 125px 118px';
const TENDER_STATUSES = ['Identified', 'Document purchased', 'Preparing', 'Submitted', 'Opened', 'Won', 'Lost', 'Withdrawn', 'Cancelled'];
const OPEN_STATUSES = ['Identified', 'Document purchased', 'Preparing'];

const daysUntil = value => (value ? Math.ceil((new Date(value) - new Date(new Date().toDateString())) / 86400000) : null);

/**
 * "in 6 days", "today", "closed 2 days ago" — the phrasing a person would use.
 *
 * `past` names what happened when the date went by, because a tender closes and a price
 * lapses, and the two should not be described with the same word.
 */
function Countdown({ date, time, live, past = 'closed' }) {
  const left = daysUntil(date);
  if (left === null) return <span>—</span>;
  const at = time ? String(time).slice(0, 5) : '';
  const urgent = live && left <= 3;
  const wording = left < 0 ? `${past} ${Math.abs(left)} day${Math.abs(left) === 1 ? '' : 's'} ago`
    : left === 0 ? `today${at ? ` at ${at}` : ''}`
      : `in ${left} day${left === 1 ? '' : 's'}${at ? ` at ${at}` : ''}`;
  return <div>
    <strong className={urgent || left < 0 ? 'overdue' : undefined}>{shortDate(date)}</strong>
    <small className={urgent || left < 0 ? 'overdue' : undefined}>{wording}</small>
  </div>;
}

function Tenders({ can }) {
  const [rows, setRows] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const load = () => api('/qs/tenders').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  const live = rows.filter(row => OPEN_STATUSES.includes(row.status));
  const awaiting = rows.filter(row => ['Submitted', 'Opened'].includes(row.status));
  const won = rows.filter(row => row.status === 'Won');

  return <>
    <div className="attendance-summary">
      <Summary label="Being prepared" value={live.length} icon={FileText} />
      <Summary label="Awaiting the outcome" value={awaiting.length} icon={FileText} />
      <Summary label="Won" value={won.length} icon={FileText} />
      <Summary label="Closing within a week"
        value={live.filter(row => { const d = daysUntil(row.closingDate); return d !== null && d <= 7; }).length}
        icon={FileText} />
    </div>

    <div className="toolbar" style={{ marginBottom: '14px' }}>
      <button className="secondary" onClick={() => openDocument('/qs/tenders/blank/commitments/document')}>
        <FileText size={15} />Contract commitments declaration
      </button>
    </div>

    <Table columns={['Reference', 'Tender', 'Employer', 'Closes', 'Our bid', 'Papers']} template={TENDER_TEMPLATE}
      title="Tenders" empty="No tenders being tracked.">
      {rows.map(row => <Row template={TENDER_TEMPLATE} key={row.id} onClick={() => setDetailId(row.id)}>
        <div>
          <strong>{row.reference}</strong>
          <small>{row.contractNo || row.procurementMethod}</small>
        </div>
        <div>
          <strong>{row.title}</strong>
          <small>{[row.specialty, row.cidaGrade && `Grade ${row.cidaGrade}`, row.biddingEntity]
            .filter(Boolean).join(' · ')}</small>
        </div>
        <span>{row.client}</span>
        <Countdown date={row.closingDate} time={row.closingTime} live={OPEN_STATUSES.includes(row.status)} />
        <div>
          {/* Once it is decided, the figure that matters is what it was awarded at. */}
          <strong>{rupees(row.awardValue || row.bidValue || row.estimatedValue)}</strong>
          <small>{row.awardValue > 0 ? 'awarded' : row.bidValue > 0 ? 'bid' : 'estimate'}</small>
        </div>
        <div>
          <Badge tone={slug(row.status)}>{row.status}</Badge>
          {row.checklistTotal > 0 && <small className={row.checklistOutstanding > 0 ? 'overdue' : undefined}>
            {row.checklistDone}/{row.checklistTotal} documents
          </small>}
        </div>
      </Row>)}
    </Table>

    {detailId && <TenderDetail tenderId={detailId} can={can} close={() => setDetailId(null)} reload={load} />}
  </>;
}

const DETAIL_TABS = ['Bid', 'Documents required', 'Outcome'];

/** Everything one bid turns on, in the order the QS works through it. */
function TenderDetail({ tenderId, can, close, reload }) {
  const [tab, setTab] = useState(DETAIL_TABS[0]);
  const [tender, setTender] = useState(null);
  const [error, setError] = useState('');

  const load = () => api(`/qs/tenders/${tenderId}`).then(setTender).catch(failure => setError(failure.message));
  useEffect(() => { load(); }, [tenderId]);

  if (!tender) return <Modal title="Loading tender…" close={close}><div className="report-form" /></Modal>;

  /* Clearing the error here matters: the usual reason for one is a document that was
     missing, and it is confusing to still be told so after it has been ticked off. */
  const refresh = async () => { setError(''); await load(); await reload(); };

  const setStatus = async status => {
    setError('');
    try { await patch(`/qs/tenders/${tender.id}`, { status }); await refresh(); }
    catch (failure) { setError(failure.message); }
  };

  const validityEnds = tender.closingDate
    ? new Date(new Date(tender.closingDate).getTime() + tender.validityDays * 86400000).toISOString().slice(0, 10)
    : null;

  return <Modal title={`${tender.reference} — ${tender.title}`} close={close}>
    <div className="report-form">
      <div className="wide"><Tabs tabs={DETAIL_TABS} active={tab} onChange={setTab} /></div>
      {error && <p className="wide form-error">{error}</p>}

      {tab === 'Bid' && <>
        <Detail label="Employer" value={tender.client} />
        <Detail label="Contract number" value={tender.contractNo} />
        <Detail label="Bidding as" value={tender.biddingEntity} />
        <Detail label="Procurement" value={tender.procurementMethod} />
        <Detail label="Specialty" value={tender.specialty} />
        <Detail label="CIDA grade required" value={tender.cidaGrade} />
        <Detail label="Employer's office" value={tender.employerOffice} wide />
        <Detail label="Contact" value={tender.employerContact} wide />

        <div className="wide"><h3 className="detail-heading">The clocks</h3></div>
        <Detail label="Documents on sale"
          value={tender.docsFrom ? `${shortDate(tender.docsFrom)} — ${shortDate(tender.docsUntil)}` : null}
          note={tender.documentFee > 0 ? `Fee ${rupees(tender.documentFee)}` : null} />
        <Detail label="Document bought"
          value={tender.purchasedDate ? shortDate(tender.purchasedDate) : 'Not yet'}
          note={tender.receiptNo ? `Receipt ${tender.receiptNo}` : null} />
        <Detail label="Bids close"
          value={`${shortDate(tender.closingDate)}${tender.closingTime ? ` at ${String(tender.closingTime).slice(0, 5)}` : ''}`} />
        <Detail label="Our offer stands until" value={validityEnds ? shortDate(validityEnds) : null}
          note={`${tender.validityDays} days from closing`} />

        <div className="wide"><h3 className="detail-heading">Bid security</h3></div>
        <Detail label="Amount" value={tender.securityAmount > 0 ? rupees(tender.securityAmount) : 'Not required'} />
        <Detail label="Form" value={tender.securityForm} />
        <Detail label="In favour of" value={tender.securityInFavourOf} />
        <Detail label="Valid until" value={tender.securityValidUntil ? shortDate(tender.securityValidUntil) : null}
          note={tender.securityReleasedOn ? `Released ${shortDate(tender.securityReleasedOn)}` : null} />

        <div className="wide"><h3 className="detail-heading">Money</h3></div>
        <Detail label="Employer's ceiling" value={tender.maxContractValue > 0 ? rupees(tender.maxContractValue) : null} />
        <Detail label="Our estimate" value={rupees(tender.estimatedValue)} />
        <Detail label="Our bid (excluding VAT)" value={tender.bidValue > 0 ? rupees(tender.bidValue) : 'Not priced yet'} />
        <Detail label="VAT" value={tender.vatAmount > 0 ? rupees(tender.vatAmount) : '—'} />
        {tender.documentsNote && <Detail label="Notes" value={tender.documentsNote} wide />}
      </>}

      {tab === 'Documents required' && <div className="wide">
        <Checklist tender={tender} can={can} refresh={refresh} />
      </div>}

      {tab === 'Outcome' && <div className="wide">
        <Outcome tender={tender} can={can} refresh={refresh} onDone={close} />
      </div>}

      <div className="form-actions">
        {can.tender && <select className="status-button" value={tender.status}
          onChange={event => setStatus(event.target.value)}>
          {TENDER_STATUSES.map(status => <option key={status}>{status}</option>)}
        </select>}
        <button type="button" className="secondary"
          onClick={() => openDocument(`/qs/tenders/${tender.id}/commitments/document`)}>
          <FileText size={15} />Commitments declaration
        </button>
        <button type="button" className="secondary" onClick={close}>Close</button>
      </div>
    </div>
  </Modal>;
}

function Detail({ label, value, note, wide }) {
  return <label className={wide ? 'wide' : undefined}>
    {label}
    <div className="detail-value">
      <strong>{value || '—'}</strong>
      {note && <small>{note}</small>}
    </div>
  </label>;
}

/**
 * The envelope contents, item by item.
 *
 * A bid short of its PCA-03 certificate cannot be awarded however good the price, and a
 * missing commitments affidavit makes the bid non-responsive outright — so the system
 * refuses to mark a tender submitted while anything mandatory is still outstanding.
 */
function Checklist({ tender, can, refresh }) {
  const [adding, setAdding] = useState('');
  const outstanding = tender.checklist.filter(row => !row.done && row.mandatory).length;

  const toggle = async row => { await patch(`/qs/tenders/checklist/${row.id}`, { done: !row.done }); await refresh(); };
  /* Standing a requirement down is the honest way past something this employer does not
     ask for; ticking it would claim a certificate is in the envelope when it is not. */
  const setRequired = async (row, mandatory) => {
    await patch(`/qs/tenders/checklist/${row.id}`, { mandatory });
    await refresh();
  };
  const add = async event => {
    event.preventDefault();
    if (!adding.trim()) return;
    await post(`/qs/tenders/${tender.id}/checklist`, { item: adding.trim() });
    setAdding('');
    await refresh();
  };

  return <>
    <p className={outstanding ? 'form-error' : 'form-success'}>
      {outstanding
        ? `${outstanding} required document(s) still outstanding. The bid cannot be marked submitted until they are in.`
        : 'Every required document is accounted for. The bid can be submitted.'}
    </p>
    <div className="tender-checklist">
      {tender.checklist.map(row => <label key={row.id} className={row.done ? 'done' : undefined}>
        <input type="checkbox" checked={Boolean(row.done)} disabled={!can.tender} onChange={() => toggle(row)} />
        <span>
          {row.item}
          {!row.mandatory && <em> — not required by this employer</em>}
          {/* MySQL hands booleans back as 0 and 1, and React renders a leading 0 quite
              happily — so the guard is made an explicit boolean. */}
          {Boolean(row.done) && row.doneBy ? <small>Confirmed by {row.doneBy}</small> : null}
        </span>
        {can.tender && <button type="button" className="link-button"
          title={row.mandatory ? 'This employer does not ask for it' : 'Require it again'}
          onClick={event => { event.preventDefault(); setRequired(row, !row.mandatory); }}>
          {row.mandatory ? 'Not required' : 'Require'}
        </button>}
      </label>)}
    </div>
    {can.tender && <form className="checklist-add" onSubmit={add}>
      <input value={adding} onChange={event => setAdding(event.target.value)}
        placeholder="Anything else this employer asks for" />
      <button className="secondary" type="submit">Add</button>
    </form>}
  </>;
}

/** Recording what the opening produced, and turning a win into a live project. */
function Outcome({ tender, can, refresh, onDone }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (tender.projectId) {
    return <p className="form-success">
      Awarded and registered as the project “{tender.project}”.
      {tender.awardValue > 0 && ` Award value ${rupees(tender.awardValue)}.`}
    </p>;
  }
  if (!can.tender) return <p>Only the QS team can record a tender outcome.</p>;

  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await post(`/qs/tenders/${tender.id}/outcome`, {
        status: form.get('status'),
        awardValue: Number(form.get('awardValue') || 0),
        awardedTo: form.get('awardedTo') || undefined,
        ourRank: form.get('ourRank') ? Number(form.get('ourRank')) : undefined,
        biddersCount: form.get('biddersCount') ? Number(form.get('biddersCount')) : undefined,
        openedDate: form.get('openedDate') || undefined,
        outcomeNote: form.get('outcomeNote') || undefined,
        registerProject: form.get('registerProject') === 'on',
        manager: form.get('manager') || undefined
      });
      await refresh();
      onDone();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };

  return <form className="report-form" style={{ padding: 0 }} onSubmit={submit}>
    <SelectField name="status" label="What happened" options={['Won', 'Lost', 'Withdrawn', 'Cancelled']} />
    <Field name="openedDate" label="Opened on" type="date" defaultValue={todayInput()} required={false} />
    <Field name="awardValue" label="Award value (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <Field name="awardedTo" label="Awarded to" required={false} placeholder="Leave blank if it was us" />
    <Field name="ourRank" label="Our position" type="number" min="1" required={false} placeholder="1 = lowest bid" />
    <Field name="biddersCount" label="Bidders" type="number" min="1" required={false} />
    <Field name="manager" label="Project manager, if we won" required={false} />
    <label className="checkbox-line">
      <input type="checkbox" name="registerProject" defaultChecked />
      Register this as a live project if we won
    </label>
    <TextArea name="outcomeNote" label="Notes" required={false} placeholder="Why it went the way it did" />
    {error && <p className="wide form-error">{error}</p>}
    <div className="form-actions">
      <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Record outcome'}</button>
    </div>
  </form>;
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
    <div style={{ height: '14px' }} />
    <SubcontractQuotations can={can} data={data} subcontractors={rows} />
    {billing && <BillForm data={data} subcontractors={rows} close={() => setBilling(false)} reload={load} />}
  </>;
}

const SUBQUOTE_TEMPLATE = 'minmax(130px,.9fr) minmax(180px,1.3fr) minmax(170px,1.2fr) 130px 130px 130px';

/**
 * Prices asked of subcontractors, and what became of them.
 *
 * GKUC keep no standing panel: when a job needs a subcontractor they ask for a price, and
 * whichever they take is carried into their own quotation to the client. So this is really
 * a comparison sheet — several prices for one package, one of them chosen — and the record
 * of where a figure in GKUC's own pricing came from.
 */
function SubcontractQuotations({ can, data, subcontractors }) {
  const [rows, setRows] = useState([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const load = () => api('/qs/subcontract-quotations').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  const decide = async (row, status) => {
    setError('');
    const note = status === 'Accepted'
      ? window.prompt('Why this price? (optional)') ?? ''
      : window.prompt('Why is it being turned down? (optional)') ?? '';
    try {
      await post(`/qs/subcontract-quotations/${row.id}/decision`, { status, note: note || undefined });
      await load();
    } catch (failure) { setError(failure.message); }
  };

  return <>
    {error && <p className="form-error">{error}</p>}
    <Table columns={['Reference', 'Subcontractor', 'Package', 'Quoted', 'Stands until', 'Status']}
      template={SUBQUOTE_TEMPLATE} title="Prices from subcontractors"
      tools={can.subcontractors
        ? <button className="secondary" onClick={() => setRecording(true)}>Record a quotation</button>
        : null}
      empty="No subcontract prices recorded.">
      {rows.map(row => {
        const left = row.validUntil ? daysUntil(row.validUntil) : null;
        const live = row.status === 'Received';
        return <Row template={SUBQUOTE_TEMPLATE} key={row.id}>
          <div>
            <strong>{row.reference}</strong>
            <small>{row.theirReference ? `their ref ${row.theirReference}` : '—'}</small>
          </div>
          <div>
            <strong>{row.subcontractor}</strong>
            <small>{row.trade}</small>
          </div>
          <div>
            <strong>{row.package}</strong>
            <small>{row.project || 'No project yet'}</small>
          </div>
          <div>
            <strong>{rupees(row.total)}</strong>
            {row.usedInQuotations > 0 && <small>used in our pricing</small>}
          </div>
          <Countdown date={row.validUntil} live={live} past="lapsed" />
          <div>
            <Badge tone={slug(row.status)}>{row.status}</Badge>
            {can.subcontractors && live && <span className="row-actions" style={{ marginTop: '6px' }}>
              <button className="status-button" onClick={() => decide(row, 'Accepted')}>Take</button>
              <button className="status-button" onClick={() => decide(row, 'Rejected')}>Decline</button>
            </span>}
          </div>
        </Row>;
      })}
    </Table>
    {recording && <SubcontractQuotationForm data={data} subcontractors={subcontractors}
      close={() => setRecording(false)} reload={load} />}
  </>;
}

/** Follows the shape of the quotations subcontractors actually send: their reference, a
    delivery address that is the site, per-line discounts, and a short validity. */
function SubcontractQuotationForm({ data, subcontractors, close, reload }) {
  const [lines, setLines] = useState([{ description: '', unit: '', quantity: '', rate: '', discount: '0' }]);
  const total = lines.reduce((sum, line) =>
    sum + Math.max(0, (Number(line.quantity) || 0) * (Number(line.rate) || 0) - (Number(line.discount) || 0)), 0);

  const change = (index, field, value) => setLines(current =>
    current.map((line, position) => (position === index ? { ...line, [field]: value } : line)));

  return <FormModal title="Record a subcontractor's quotation" close={close} label="Record quotation" wide
    onSubmit={async values => {
      await post('/qs/subcontract-quotations', {
        subcontractorId: Number(values.subcontractorId),
        projectId: values.projectId ? Number(values.projectId) : undefined,
        theirReference: values.theirReference || undefined,
        package: values.package,
        quoteDate: values.quoteDate,
        validityDays: Number(values.validityDays || 7),
        siteAddress: values.siteAddress || undefined,
        contactPerson: values.contactPerson || undefined,
        contactPhone: values.contactPhone || undefined,
        notes: values.notes || undefined,
        items: lines.filter(line => line.description.trim()).map(line => ({
          description: line.description,
          unit: line.unit || undefined,
          quantity: Number(line.quantity) || 1,
          rate: Number(line.rate) || 0,
          discount: Number(line.discount) || 0
        }))
      });
      await reload();
    }}>
    <SelectField name="subcontractorId" label="Who quoted"
      options={subcontractors.map(row => [row.id, `${row.name} — ${row.trade}`])} />
    <Field name="theirReference" label="Their quotation number" required={false} placeholder="00243-3" />
    <Field name="package" label="What it covers" wide placeholder="Interlock paving blocks — SLS 1425:2011" />
    <SelectField name="projectId" label="For which project"
      options={[['', 'Not tied to a project yet'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="quoteDate" label="Dated" type="date" defaultValue={todayInput()} />
    <Field name="validityDays" label="Stands for (days)" type="number" min="1" max="365" defaultValue="7" required={false} />
    <Field name="siteAddress" label="Delivery / site address" wide required={false}
      placeholder="Hemas Manufactures, Industrial Zone, Dankotuwa" />
    <Field name="contactPerson" label="Their contact" required={false} />
    <Field name="contactPhone" label="Telephone" required={false} />

    <div className="wide">
      <h3 className="detail-heading">What they quoted</h3>
      {lines.map((line, index) => <div className="subquote-line" key={index}>
        <input placeholder="Description" value={line.description}
          onChange={event => change(index, 'description', event.target.value)} />
        <input placeholder="Unit" value={line.unit} onChange={event => change(index, 'unit', event.target.value)} />
        <input placeholder="Qty" type="number" step="any" value={line.quantity}
          onChange={event => change(index, 'quantity', event.target.value)} />
        <input placeholder="Rate" type="number" step="any" value={line.rate}
          onChange={event => change(index, 'rate', event.target.value)} />
        <input placeholder="Discount" type="number" step="any" value={line.discount}
          onChange={event => change(index, 'discount', event.target.value)} />
      </div>)}
      <div className="subquote-foot">
        <button type="button" className="secondary"
          onClick={() => setLines(current => [...current, { description: '', unit: '', quantity: '', rate: '', discount: '0' }])}>
          Add line
        </button>
        <strong>Total {rupees(total)}</strong>
      </div>
    </div>
    <TextArea name="notes" label="Anything they noted" required={false}
      placeholder="Price includes transport & unloading" />
  </FormModal>;
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
    <Field name="markupPercent" label="Markup %" type="number" step="0.01" min="0" max="100" defaultValue="10" required={false} />
    <Field name="vatPercent" label="VAT %" type="number" step="0.01" min="0" max="100" defaultValue="18" required={false} />
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
  return <FormModal title="Track a tender" close={close} label="Track tender" wide onSubmit={async values => {
    await post('/qs/tenders', {
      contractNo: values.contractNo || undefined,
      title: values.title,
      client: values.client,
      source: values.source || undefined,
      biddingEntity: values.biddingEntity || undefined,
      procurementMethod: values.procurementMethod,
      specialty: values.specialty,
      cidaGrade: values.cidaGrade || undefined,
      employerOffice: values.employerOffice || undefined,
      employerContact: values.employerContact || undefined,
      maxContractValue: Number(values.maxContractValue || 0),
      documentFee: Number(values.documentFee || 0),
      docsFrom: values.docsFrom || undefined,
      docsUntil: values.docsUntil || undefined,
      closingDate: values.closingDate,
      closingTime: values.closingTime || '10:00',
      validityDays: Number(values.validityDays || 91),
      securityAmount: Number(values.securityAmount || 0),
      securityForm: values.securityForm,
      securityInFavourOf: values.securityInFavourOf || undefined,
      securityValidUntil: values.securityValidUntil || undefined,
      estimatedValue: Number(values.estimatedValue || 0),
      documentsNote: values.documentsNote || undefined
    });
    await reload();
  }}>
    <Field name="title" label="Works as named in the bidding document" wide />
    <Field name="client" label="Employer" placeholder="Department of Buildings" />
    <Field name="contractNo" label="Employer's contract number" required={false} placeholder="04-03-10-CT008/2026" />
    <SelectField name="biddingEntity" label="We bid as"
      options={['G.K.U.C. Construction (Pvt) Ltd', 'G.K.U.C. Ready Mix (Pvt) Ltd']} />
    <SelectField name="procurementMethod" label="Procurement method"
      options={['National Competitive Bidding', 'International Competitive Bidding', 'Shopping', 'Direct']} />
    <SelectField name="specialty" label="Specialty"
      options={['Highways', 'Bridges', 'Buildings', 'Irrigation', 'Water Supply', 'Other']} />
    <Field name="cidaGrade" label="CIDA grade required" required={false} placeholder="C6, C5 or C4" />
    <Field name="employerOffice" label="Issuing office" wide required={false}
      placeholder="Chief Engineer's Office (Western South), Colombo 07" />
    <Field name="employerContact" label="Contact" wide required={false} placeholder="Telephone / engineer" />

    <Field name="docsFrom" label="Documents on sale from" type="date" required={false} />
    <Field name="docsUntil" label="…until" type="date" required={false} />
    <Field name="documentFee" label="Document fee (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <Field name="closingDate" label="Bids close on" type="date" defaultValue={todayInput()} />
    <Field name="closingTime" label="…at" type="time" defaultValue="10:00" required={false} />
    <Field name="validityDays" label="Bid valid for (days)" type="number" min="1" max="365" defaultValue="91" required={false} />

    <Field name="securityAmount" label="Bid security (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <SelectField name="securityForm" label="Security form"
      options={['Bank guarantee', 'Insurance bond', 'Cash deposit', 'Not required']} />
    <Field name="securityInFavourOf" label="Security in favour of" required={false}
      placeholder="Director General of Buildings" />
    <Field name="securityValidUntil" label="Security valid until" type="date" required={false} />

    <Field name="maxContractValue" label="Employer's ceiling (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <Field name="estimatedValue" label="Our estimate (LKR)" type="number" min="0" defaultValue="0" required={false} />
    <Field name="source" label="Where it was advertised" required={false} placeholder="Daily News, e-procurement, invitation" />
    <TextArea name="documentsNote" label="Notes" required={false} placeholder="Optional" />
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
