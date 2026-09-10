import React, { useEffect, useState } from 'react';
import { Landmark, TriangleAlert, Wallet } from 'lucide-react';
import { api, post, rupees, shortDate, slug, todayInput } from './api.js';
import {
  Badge, EmptyState, Field, FormModal, Modal, Row, SelectField, Summary, Table, TextArea, useLiveList
} from './ui.jsx';

/*
 * The money owed to the company, the guarantees the bank holds against it, and the cash
 * kept on site. Three separate ledgers that sit together because the same person keeps all
 * three, and because none of them can be read sensibly without the others.
 */

const TAX_LABELS = { Standard: 'Standard VAT', SVAT: 'SVAT — suspended', Exempt: 'Exempt' };

const INVOICE_COLUMNS = ['Reference', 'Project', 'Certificate', 'Net payable', 'Outstanding', 'Due', 'Status', ''];
const INVOICE_TEMPLATE = 'minmax(120px,1fr) minmax(140px,1.1fr) minmax(180px,1.5fr) 130px 130px 130px 110px 130px';

export function ClientInvoices({ data, can }) {
  const [invoices, setInvoices] = useState([]);
  const [ageing, setAgeing] = useState(null);
  const [raising, setRaising] = useState(false);
  const [receipting, setReceipting] = useState(null);
  const [error, setError] = useState('');

  const load = () => Promise.all([
    api('/receivables/invoices').then(setInvoices).catch(() => setInvoices([])),
    api('/receivables/ageing').then(setAgeing).catch(() => setAgeing(null))
  ]);
  useLiveList(load);

  const issue = async invoice => {
    setError('');
    try {
      await post(`/receivables/invoices/${invoice.id}/issue`);
      await load();
    } catch (failure) { setError(failure.message); }
  };

  return <>
    {ageing && <div className="attendance-summary">
      <Summary label="Owed by clients" value={rupees(ageing.totals.outstanding)} icon={Wallet} />
      <Summary label="Past its due date" value={rupees(ageing.totals.overdue)} icon={TriangleAlert} />
      <Summary label="Retention the client holds" value={rupees(ageing.totals.retentionHeld)} icon={Landmark} />
    </div>}

    {error && <p className="form-error">{error}</p>}

    <Table columns={INVOICE_COLUMNS} template={INVOICE_TEMPLATE} title="Client invoices"
      empty="No certificates raised yet."
      tools={can.invoice
        ? <button className="secondary" onClick={() => setRaising(true)}>Raise a certificate</button>
        : null}>
      {invoices.map(invoice => <Row template={INVOICE_TEMPLATE} key={invoice.id}>
        <div><strong>{invoice.reference}</strong><small>{invoice.kind}</small></div>
        <span>{invoice.project}</span>
        <div><strong>{invoice.title}</strong><small>{TAX_LABELS[invoice.taxTreatment]}</small></div>
        <span>{rupees(invoice.netPayable)}</span>
        {/* A draft is not owed by anybody yet, and the totals above exclude it. Showing a
            figure here would put it back into the reader's head. */}
        <strong>{invoice.status === 'Draft' ? '—' : rupees(invoice.outstanding)}</strong>
        <div>
          <span className={Number(invoice.daysOverdue) > 0 && invoice.status !== 'Paid' ? 'overdue' : ''}>
            {shortDate(invoice.dueDate)}
          </span>
          {Number(invoice.daysOverdue) > 0 && invoice.status !== 'Paid' && invoice.status !== 'Draft'
            ? <small className="overdue">{invoice.daysOverdue} days late</small> : null}
        </div>
        <Badge tone={slug(invoice.status)}>{invoice.status}</Badge>
        {can.invoice && invoice.status === 'Draft'
          ? <button className="status-button" onClick={() => issue(invoice)}>Issue</button>
          : can.invoice && invoice.status !== 'Paid'
            ? <button className="status-button" onClick={() => setReceipting(invoice)}>Record payment</button>
            : <span>—</span>}
      </Row>)}
    </Table>

    {ageing?.rows?.length ? <>
      <div style={{ height: '14px' }} />
      <AgeingTable rows={ageing.rows} />
    </> : null}

    {raising && <CertificateForm data={data} close={() => setRaising(false)} reload={load} />}
    {receipting && <ReceiptForm invoice={receipting} close={() => setReceipting(null)} reload={load} />}
  </>;
}

const AGEING_COLUMNS = ['Client', 'Project', 'Not yet due', '1–30 days', '31–60 days', 'Over 60 days', 'Outstanding'];
const AGEING_TEMPLATE = 'minmax(160px,1.2fr) minmax(150px,1fr) 130px 130px 130px 130px 140px';

/** How long the money has been owed. The right-hand columns are the ones that need chasing. */
function AgeingTable({ rows }) {
  return <Table columns={AGEING_COLUMNS} template={AGEING_TEMPLATE} title="How long it has been owed">
    {rows.map(row => <Row template={AGEING_TEMPLATE} key={`${row.client}-${row.project}`}>
      <strong>{row.client}</strong>
      <span>{row.project}</span>
      <span>{rupees(row.current)}</span>
      <span>{rupees(row.upTo30)}</span>
      <span className={Number(row.upTo60) > 0 ? 'overdue' : ''}>{rupees(row.upTo60)}</span>
      <span className={Number(row.over60) > 0 ? 'overdue' : ''}>{rupees(row.over60)}</span>
      <strong>{rupees(row.outstanding)}</strong>
    </Row>)}
  </Table>;
}

function ReceiptForm({ invoice, close, reload }) {
  const outstanding = Number(invoice.outstanding);
  return <FormModal title={`Payment against ${invoice.reference}`} close={close} label="Record payment"
    onSubmit={async values => {
      await post(`/receivables/invoices/${invoice.id}/receipts`, {
        amount: Number(values.amount),
        receivedDate: values.receivedDate,
        method: values.method,
        reference: values.reference || undefined
      });
      await reload();
    }}>
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="any" min="0"
      defaultValue={outstanding} />
    <Field name="receivedDate" label="Received on" type="date" defaultValue={todayInput()} />
    <SelectField name="method" label="Method" options={['Bank transfer', 'Cheque', 'Cash']} />
    <Field name="reference" label="Bank reference" required={false} />
  </FormModal>;
}

/*
 * Raising a certificate.
 *
 * The working is shown as the lines are typed. The figure a client is asked for is arrived
 * at in four steps — work done, VAT, retention withheld, advance recovered — and the person
 * signing it should see all four rather than one total to take on trust. The server does the
 * same arithmetic again on submit and keeps its own answer; this preview is for the person.
 */
const BLANK_LINE = { description: '', unit: '', quantity: '', rate: '' };

function CertificateForm({ data, close, reload }) {
  const [lines, setLines] = useState([{ ...BLANK_LINE }]);
  const [terms, setTerms] = useState({
    taxTreatment: 'Standard', vatRate: '18', retentionPercent: '10', advanceRecovery: '', otherDeductions: ''
  });
  const [preview, setPreview] = useState(null);

  const setTerm = (key, value) => setTerms(current => ({ ...current, [key]: value }));
  const setLine = (index, key, value) => setLines(current =>
    current.map((line, position) => (position === index ? { ...line, [key]: value } : line)));

  const items = lines
    .filter(line => line.description.trim() && Number(line.quantity) > 0)
    .map(line => ({
      description: line.description.trim(),
      unit: line.unit.trim() || undefined,
      quantity: Number(line.quantity),
      rate: Number(line.rate) || 0
    }));

  const shape = {
    items,
    taxTreatment: terms.taxTreatment,
    vatRate: Number(terms.vatRate) || 0,
    retentionPercent: Number(terms.retentionPercent) || 0,
    advanceRecovery: Number(terms.advanceRecovery) || 0,
    otherDeductions: Number(terms.otherDeductions) || 0
  };
  const signature = JSON.stringify(shape);

  /* Debounced, because it fires on every keystroke in a rate field. */
  useEffect(() => {
    if (!items.length) { setPreview(null); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      post('/receivables/preview', shape)
        .then(result => { if (live) setPreview(result); })
        .catch(() => { if (live) setPreview(null); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [signature]);

  return <FormModal title="Raise a certificate" close={close} label="Save as draft" wide
    onSubmit={async values => {
      if (!items.length) throw new Error('Add at least one line with a description and a quantity');
      await post('/receivables/invoices', {
        projectId: Number(values.projectId),
        kind: values.kind,
        title: values.title,
        invoiceDate: values.invoiceDate,
        dueDate: values.dueDate || undefined,
        svatVoucher: values.svatVoucher || undefined,
        notes: values.notes || undefined,
        ...shape
      });
      await reload();
    }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="kind" label="Kind" options={['Interim', 'Final', 'Advance', 'Variation', 'Other']} />
    <Field name="title" label="Title" wide placeholder="IPA No. 3 — works to 25 August" />
    <Field name="invoiceDate" label="Invoice date" type="date" defaultValue={todayInput()} />
    <Field name="dueDate" label="Payment due" type="date" required={false} />

    <div className="invoice-lines wide">
      <h3>What is being certified</h3>
      {lines.map((line, index) => <div className="invoice-line" key={index}>
        <input value={line.description} placeholder="Description of work"
          onChange={event => setLine(index, 'description', event.target.value)} />
        <input value={line.unit} placeholder="Unit"
          onChange={event => setLine(index, 'unit', event.target.value)} />
        <input value={line.quantity} type="number" step="any" min="0" placeholder="Qty"
          onChange={event => setLine(index, 'quantity', event.target.value)} />
        <input value={line.rate} type="number" step="any" min="0" placeholder="Rate"
          onChange={event => setLine(index, 'rate', event.target.value)} />
        <span>{rupees((Number(line.quantity) || 0) * (Number(line.rate) || 0))}</span>
        <button type="button" className="icon-btn" aria-label="Remove line"
          disabled={lines.length === 1}
          onClick={() => setLines(current => current.filter((_, position) => position !== index))}>×</button>
      </div>)}
      <button type="button" className="secondary"
        onClick={() => setLines(current => [...current, { ...BLANK_LINE }])}>Add a line</button>
    </div>

    <label>Tax treatment
      <select value={terms.taxTreatment} onChange={event => setTerm('taxTreatment', event.target.value)}>
        {Object.entries(TAX_LABELS).map(([value, text]) => <option value={value} key={value}>{text}</option>)}
      </select>
    </label>
    {terms.taxTreatment !== 'Exempt' && <label>VAT rate (%)
      <input type="number" step="any" min="0" max="100" value={terms.vatRate}
        onChange={event => setTerm('vatRate', event.target.value)} />
    </label>}
    {terms.taxTreatment === 'SVAT' && <Field name="svatVoucher" label="SVAT voucher number" required={false} />}
    <label>Retention withheld (%)
      <input type="number" step="any" min="0" max="50" value={terms.retentionPercent}
        onChange={event => setTerm('retentionPercent', event.target.value)} />
    </label>
    <label>Advance recovered (LKR)
      <input type="number" step="any" min="0" value={terms.advanceRecovery}
        onChange={event => setTerm('advanceRecovery', event.target.value)} />
    </label>
    <label>Other deductions (LKR)
      <input type="number" step="any" min="0" value={terms.otherDeductions}
        onChange={event => setTerm('otherDeductions', event.target.value)} />
    </label>
    <TextArea name="notes" label="Notes" required={false} rows={2} />

    {preview && <div className="invoice-working wide">
      <h3>What the client will be asked for</h3>
      {preview.workings.map(step => <div key={step.label} className={step.amount < 0 ? 'is-deduction' : ''}>
        <span>{step.label}</span>
        <b>{step.amount < 0 ? `− ${rupees(Math.abs(step.amount))}` : rupees(step.amount)}</b>
      </div>)}
      <div className="invoice-total"><span>Net payable</span><b>{rupees(preview.netPayable)}</b></div>
      {terms.taxTreatment === 'SVAT' && <p className="invoice-note">
        <TriangleAlert size={14} /> Under SVAT the VAT is shown but not collected — a credit voucher
        passes instead, so it is not part of what the client pays.
      </p>}
    </div>}
  </FormModal>;
}

/* ---- bank guarantees ------------------------------------------------------ */

const BOND_COLUMNS = ['Reference', 'Kind', 'In favour of', 'Bank', 'Amount', 'Margin held', 'Expires', 'Status'];
const BOND_TEMPLATE = 'minmax(120px,1fr) 140px minmax(160px,1.2fr) minmax(130px,1fr) 130px 130px 140px 110px';

export function Bonds({ data, can }) {
  const [bonds, setBonds] = useState([]);
  const [recording, setRecording] = useState(false);
  const load = () => api('/receivables/bonds').then(setBonds).catch(() => setBonds([]));
  useLiveList(load);

  const tone = bond => (bond.status !== 'Live' ? slug(bond.status)
    : Number(bond.daysLeft) < 0 ? 'at-risk' : Number(bond.daysLeft) <= 30 ? 'watch' : 'on-track');

  return <>
    <Table columns={BOND_COLUMNS} template={BOND_TEMPLATE} title="Bank guarantees"
      empty="No bonds recorded."
      tools={can.invoice
        ? <button className="secondary" onClick={() => setRecording(true)}>Record a bond</button>
        : null}>
      {bonds.map(bond => <Row template={BOND_TEMPLATE} key={bond.id}>
        <div><strong>{bond.reference}</strong><small>{bond.bond_number || bond.project || '—'}</small></div>
        <span>{bond.kind}</span>
        <span>{bond.beneficiary}</span>
        <span>{bond.bank}</span>
        <span>{rupees(bond.amount)}</span>
        <span>{Number(bond.margin_held) > 0 ? rupees(bond.margin_held) : '—'}</span>
        <div>
          <span className={bond.status === 'Live' && Number(bond.daysLeft) < 0 ? 'overdue' : ''}>
            {shortDate(bond.expiry_date)}
          </span>
          {bond.status === 'Live' && Number(bond.daysLeft) <= 30 ? <small
            className={Number(bond.daysLeft) < 0 ? 'overdue' : ''}>
            {Number(bond.daysLeft) < 0
              ? `${Math.abs(Number(bond.daysLeft))} days ago`
              : `in ${bond.daysLeft} days`}
          </small> : null}
        </div>
        <Badge tone={tone(bond)}>{bond.status}</Badge>
      </Row>)}
    </Table>
    {recording && <BondForm data={data} close={() => setRecording(false)} reload={load} />}
  </>;
}

function BondForm({ data, close, reload }) {
  return <FormModal title="Record a bank guarantee" close={close} label="Save bond" onSubmit={async values => {
    await post('/receivables/bonds', {
      projectId: values.projectId ? Number(values.projectId) : null,
      kind: values.kind,
      beneficiary: values.beneficiary,
      bank: values.bank,
      bondNumber: values.bondNumber || undefined,
      amount: Number(values.amount),
      marginHeld: Number(values.marginHeld) || 0,
      commission: Number(values.commission) || 0,
      issuedDate: values.issuedDate,
      expiryDate: values.expiryDate,
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="kind" label="Kind"
      options={['Advance payment', 'Performance', 'Retention', 'Bid', 'Other']} />
    <SelectField name="projectId" label="Project" required={false}
      options={[['', 'Not project specific'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="beneficiary" label="In favour of" wide placeholder="Road Development Authority" />
    <Field name="bank" label="Issuing bank" />
    <Field name="bondNumber" label="Bond number" required={false} />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="marginHeld" label="Margin held by the bank" type="number" step="any" min="0" required={false} />
    <Field name="commission" label="Commission paid" type="number" step="any" min="0" required={false} />
    <Field name="issuedDate" label="Issued on" type="date" defaultValue={todayInput()} />
    <Field name="expiryDate" label="Expires on" type="date" />
    <TextArea name="notes" label="Notes" required={false} rows={2} />
  </FormModal>;
}

/* ---- petty cash ----------------------------------------------------------- */

export function PettyCash({ data, can }) {
  const [floats, setFloats] = useState([]);
  const [opening, setOpening] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => api('/receivables/petty-cash').then(setFloats).catch(() => setFloats([]));
  useLiveList(load);

  /* The card the holder is looking at must follow the data, not the click that opened it. */
  const current = open ? floats.find(float => float.id === open) : null;

  return <>
    <div className="toolbar">
      <div className="segments"><span className="segment-label">Cash held on site</span></div>
      {can.finance && <button className="secondary" onClick={() => setOpening(true)}>Open a float</button>}
    </div>

    <div className="petty-grid">
      {floats.map(float => {
        const low = Number(float.balance) <= Number(float.lowAt);
        return <button type="button" className="petty-card" key={float.id} onClick={() => setOpen(float.id)}>
          <strong>{float.name}</strong>
          <small>{float.holderName}{float.project ? ` · ${float.project}` : ''}</small>
          <b className={low ? 'overdue' : ''}>{rupees(float.balance)}</b>
          <small>{low ? 'Running low — needs topping up' : `of a ${rupees(float.ceiling)} float`}</small>
        </button>;
      })}
      {!floats.length && <EmptyState>No petty cash floats have been opened.</EmptyState>}
    </div>

    {opening && <FloatForm data={data} close={() => setOpening(false)} reload={load} />}
    {current && <FloatLedger float={current} can={can} close={() => setOpen(null)} reload={load} />}
  </>;
}

function FloatForm({ data, close, reload }) {
  return <FormModal title="Open a petty cash float" close={close} label="Open float" onSubmit={async values => {
    await post('/receivables/petty-cash', {
      name: values.name,
      holderName: values.holderName,
      projectId: values.projectId ? Number(values.projectId) : null,
      ceiling: Number(values.ceiling) || 0,
      lowAt: Number(values.lowAt) || 0
    });
    await reload();
  }}>
    <Field name="name" label="Float name" placeholder="Kandy site office" />
    <Field name="holderName" label="Held by" />
    <SelectField name="projectId" label="Project" required={false}
      options={[['', 'Not project specific'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="ceiling" label="Float ceiling (LKR)" type="number" step="any" min="0" />
    <Field name="lowAt" label="Warn when it falls below" type="number" step="any" min="0" />
  </FormModal>;
}

const ENTRY_TEMPLATE = '110px minmax(180px,1.6fr) 110px minmax(130px,1fr) 130px';

function FloatLedger({ float, can, close, reload }) {
  const [entries, setEntries] = useState([]);
  const [adding, setAdding] = useState(false);
  const load = () => api(`/receivables/petty-cash/${float.id}/entries`).then(setEntries).catch(() => setEntries([]));
  useLiveList(load);

  return <Modal title={`${float.name} — ${rupees(float.balance)} in hand`} close={close} wide>
    <Table columns={['Date', 'Description', 'Kind', 'Recorded by', 'Amount']} template={ENTRY_TEMPLATE}
      empty="Nothing has moved through this float yet."
      tools={can.finance ? <button className="secondary" onClick={() => setAdding(true)}>Record a movement</button> : null}>
      {entries.map(entry => <Row template={ENTRY_TEMPLATE} key={entry.id}>
        <span>{shortDate(entry.entryDate)}</span>
        <div><strong>{entry.description}</strong><small>{entry.project || entry.category || '—'}</small></div>
        <Badge tone={slug(entry.kind)}>{entry.kind}</Badge>
        <span>{entry.recordedBy}</span>
        <strong className={Number(entry.amount) < 0 ? 'overdue' : ''}>{rupees(entry.amount)}</strong>
      </Row>)}
    </Table>
    {adding && <EntryForm float={float} close={() => setAdding(false)}
      reload={async () => { await load(); await reload(); }} />}
  </Modal>;
}

function EntryForm({ float, close, reload }) {
  return <FormModal title={`Movement on ${float.name}`} close={close} label="Record it" onSubmit={async values => {
    await post(`/receivables/petty-cash/${float.id}/entries`, {
      kind: values.kind,
      amount: Number(values.amount),
      entryDate: values.entryDate,
      description: values.description,
      category: values.category || undefined
    });
    await reload();
  }}>
    <SelectField name="kind" label="What happened" options={['Spend', 'Top up', 'Return', 'Adjustment']} />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="entryDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="category" label="Category" required={false} placeholder="Fuel, refreshments, courier" />
    <Field name="description" label="Description" wide placeholder="Diesel for the site generator" />
  </FormModal>;
}
