import React, { useEffect, useState } from 'react';
import { Landmark, TriangleAlert, Wallet } from 'lucide-react';
import { api, openDocument, post, rupees, shortDate, slug, todayInput } from './api.js';
import {
  Badge, EmptyState, Field, FormModal, Modal, Row, SelectField, Summary, Table, TextArea, useLiveList
} from './ui.jsx';

/*
 * The money owed to the company, the guarantees the bank holds against it, and the cash
 * kept on site. Three separate ledgers that sit together because the same person keeps all
 * three, and because none of them can be read sensibly without the others.
 */

const TAX_LABELS = { Standard: 'Standard VAT', SVAT: 'SVAT — suspended', Exempt: 'Exempt' };

const INVOICE_COLUMNS = ['Reference', 'Project', 'Invoice', 'Net payable', 'Outstanding', 'Due', 'Status', ''];
const INVOICE_TEMPLATE = 'minmax(120px,1fr) minmax(140px,1.1fr) minmax(180px,1.5fr) 130px 130px 130px 110px 190px';

export function ClientInvoices({ data, can, companyId }) {
  const [invoices, setInvoices] = useState([]);
  const [ageing, setAgeing] = useState(null);
  const [raising, setRaising] = useState(false);
  const [receipting, setReceipting] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  const load = () => Promise.all([
    api(`/receivables/invoices?companyId=${companyId}`).then(setInvoices).catch(() => setInvoices([])),
    api(`/receivables/ageing?companyId=${companyId}`).then(setAgeing).catch(() => setAgeing(null))
  ]);
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);

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
    <p className="invoice-note">Create an invoice, check its PDF, then click Issue. Record each partial payment from that invoice; cheque payments are confirmed through Cheques.</p>

    <Table columns={INVOICE_COLUMNS} template={INVOICE_TEMPLATE} title="Invoices issued to clients"
      empty="No client invoices yet. Create one from an approved BOQ, an accepted quotation, or a manual line."
      tools={can.invoice
        ? <button className="primary" onClick={() => setRaising(true)}>Create invoice</button>
        : null}>
      {invoices.map(invoice => <Row template={INVOICE_TEMPLATE} key={invoice.id}>
        <div><strong>{invoice.reference}</strong><small>{invoice.kind}</small></div>
        <span>{invoice.project}</span>
        <div><strong>{invoice.title}</strong><small>{invoice.documentType || (invoice.taxTreatment === 'Exempt' ? 'Invoice' : 'Tax Invoice')}</small></div>
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
        <div className="row-actions">
          <button className="status-button" onClick={() => setSelected(invoice)}>Payments</button>
          <button className="status-button" onClick={() => openDocument(`/receivables/invoices/${invoice.id}/document`)}>View / PDF</button>
          {can.invoice && invoice.status === 'Draft'
            ? <button className="status-button" onClick={() => issue(invoice)}>Issue</button>
            : can.invoice && invoice.status !== 'Paid'
              ? <button className="status-button" onClick={() => setReceipting(invoice)}>Record payment</button>
              : null}
        </div>
      </Row>)}
    </Table>

    {ageing?.rows?.length ? <>
      <div style={{ height: '14px' }} />
      <AgeingTable rows={ageing.rows} />
    </> : null}

    {raising && <CertificateForm data={data} companyId={companyId} close={() => setRaising(false)} reload={load} />}
    {receipting && <ReceiptForm invoice={receipting} close={() => setReceipting(null)} reload={load} />}
    {selected && <InvoicePayments invoice={selected} close={() => setSelected(null)} onPayment={() => {
      setReceipting(selected); setSelected(null);
    }} canRecord={can.invoice} />}
  </>;
}

function InvoicePayments({ invoice, close, onPayment, canRecord }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/receivables/invoices/${invoice.id}`).then(setDetail).catch(failure => setError(failure.message)); }, [invoice.id]);
  return <Modal title={`${invoice.reference} — payments`} close={close} wide>
    {error && <p className="form-error">{error}</p>}
    <div className="attendance-summary">
      <Summary label="Invoice amount" value={rupees(invoice.netPayable)} icon={Wallet} />
      <Summary label="Received" value={rupees(invoice.paidAmount)} icon={Landmark} />
      <Summary label="Still due" value={invoice.status === 'Draft' ? 'Not issued' : rupees(invoice.outstanding)} icon={TriangleAlert} />
    </div>
    <h3>Payment history</h3>
    {!detail ? <p>Loading payments…</p> : detail.receipts.length ? <div className="table-wrap"><table>
      <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead>
      <tbody>{detail.receipts.map(receipt => <tr key={receipt.id}>
        <td>{shortDate(receipt.receivedDate)}</td><td>{receipt.method}</td>
        <td>{receipt.reference || '—'}</td><td>{rupees(receipt.amount)}</td>
      </tr>)}</tbody>
    </table></div> : <p>No payments recorded yet.</p>}
    {canRecord && invoice.status !== 'Draft' && invoice.status !== 'Paid' && <button className="primary" onClick={onPayment}>Record another payment</button>}
  </Modal>;
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
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="0.01" min="0.01" max={outstanding}
      defaultValue={outstanding} />
    <Field name="receivedDate" label="Received on" type="date" defaultValue={todayInput()} />
    <SelectField name="method" label="Method" options={['Bank transfer', 'Card', 'Cash']} />
    <Field name="reference" label="Bank reference" required={false} />
    <p className="invoice-note">For cheques, use Received cheques and link this invoice. Clearing the cheque records its receipt automatically.</p>
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
const BLANK_LINE = { description: '', unit: '', quantity: '', rate: '', quotationItemId: '', boqItemId: '' };

function CertificateForm({ data, companyId, close, reload }) {
  const [lines, setLines] = useState([{ ...BLANK_LINE }]);
  const [projectId,setProjectId]=useState('');
  const [clientId,setClientId]=useState('');
  const [clients,setClients]=useState([]);
  useEffect(() => { api('/clients').then(setClients).catch(() => setClients([])); }, []);
  const clientProjects = data.projects.filter(project => Number(project.companyId || project.company_id) === Number(companyId)
    && String(project.clientId || project.client_id) === String(clientId));
  const [quoteLines,setQuoteLines]=useState([]);
  const [boqLines,setBoqLines]=useState([]);
  useEffect(()=>{
    if (!projectId) { setQuoteLines([]); setBoqLines([]); return; }
    api(`/receivables/quote-lines?projectId=${projectId}`).then(setQuoteLines).catch(()=>setQuoteLines([]));
    api(`/receivables/boq-lines?projectId=${projectId}`).then(setBoqLines).catch(()=>setBoqLines([]));
  },[projectId]);
  const [documentType,setDocumentType]=useState('Tax Invoice');
  const [terms, setTerms] = useState({
    taxTreatment: 'Standard', vatRate: '18', retentionPercent: '0', advanceRecovery: '', otherDeductions: ''
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
      rate: Number(line.rate) || 0,
      quotationItemId:line.quotationItemId?Number(line.quotationItemId):undefined,
      boqItemId:line.boqItemId?Number(line.boqItemId):undefined
    }));

  const shape = {
    companyId,
    documentType,
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

  return <FormModal title="Create client invoice" close={close} label="Save invoice as draft" wide
    onSubmit={async values => {
      if (!items.length) throw new Error('Add at least one line with a description and a quantity');
      await post('/receivables/invoices', {
        projectId: values.projectId ? Number(values.projectId) : null,
        clientId: Number(values.clientId),
        kind: values.kind,
        title: values.title,
        invoiceDate: values.invoiceDate,
        deliveryDate: values.deliveryDate || undefined,
        placeOfSupply: values.placeOfSupply || undefined,
        paymentMode: values.paymentMode || undefined,
        dueDate: values.dueDate || undefined,
        svatVoucher: values.svatVoucher || undefined,
        notes: values.notes || undefined,
        ...shape
      });
      await reload();
    }}>
    <label>Client *<select name="clientId" value={clientId} required onChange={event=>{const chosen=event.target.value;setClientId(chosen);setProjectId('');setLines([{...BLANK_LINE}]);}}>
      <option value="">Choose saved client…</option>{clients.map(client=><option key={client.id} value={client.id}>{client.name}</option>)}
    </select></label>
    <label>Project (optional)<select name="projectId" value={projectId} onChange={event=>{setProjectId(event.target.value);setLines([{...BLANK_LINE}]);}}>
      <option value="">No project — company-level invoice</option>{clientProjects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>
    <label>Invoice format *<select value={documentType} onChange={event => {
      const chosen = event.target.value; setDocumentType(chosen);
      setTerms(current => ({ ...current, taxTreatment: chosen === 'Invoice' ? 'Exempt' : 'Standard' }));
    }}><option value="Tax Invoice">VAT tax invoice</option><option value="Invoice">Standard invoice — no VAT</option></select></label>
    <SelectField name="kind" label="Billing type" options={['Interim', 'Final', 'Advance', 'Variation', 'Other']} />
    <Field name="title" label="Title" wide placeholder="IPA No. 3 — works to 25 August" />
    <Field name="invoiceDate" label="Invoice date" type="date" defaultValue={todayInput()} />
    <Field name="deliveryDate" label="Date of delivery" type="date" required={false} />
    <Field name="placeOfSupply" label="Place of supply" required={false} placeholder="Defaults to the client's site or project site" />
    <SelectField name="paymentMode" label="Expected payment mode" options={['Bank transfer', 'Cheque', 'Cash', 'Card', 'Other']} />
    <Field name="dueDate" label="Payment due" type="date" required={false} />

    <div className="invoice-lines wide">
      <h3>What is being invoiced</h3>
      {lines.map((line, index) => <div className="invoice-line" key={index}>
        <select value={line.boqItemId ? `boq:${line.boqItemId}` : line.quotationItemId ? `quote:${line.quotationItemId}` : ''}
          aria-label="Invoice line source" onChange={event=>{
            const [type,id]=event.target.value.split(':');
            const source=type==='boq' ? boqLines.find(row=>String(row.id)===id) : quoteLines.find(row=>String(row.id)===id);
            setLines(current=>current.map((row,pos)=>pos===index ? {
              ...row,boqItemId:type==='boq'?id:'',quotationItemId:type==='quote'?id:'',
              description:source?.description||row.description,unit:source?.unit||row.unit,
              quantity:type==='boq' ? String(Math.max(0,Number(source?.remainingQuantity||0))) : row.quantity,
              rate:source?.rate??row.rate
            } : row));
          }}><option value="">Manual line</option>
          {boqLines.length > 0 && <optgroup label="Approved BOQ items">{boqLines.map(row=><option value={`boq:${row.id}`} key={`boq:${row.id}`} disabled={Number(row.remainingQuantity)<=0}>{row.reference} · {row.description} · {rupees(row.rate)}/{row.unit} · {row.remainingQuantity} left</option>)}</optgroup>}
          {quoteLines.length > 0 && <optgroup label="Accepted quotation lines">{quoteLines.map(row=><option value={`quote:${row.id}`} key={`quote:${row.id}`}>{row.reference} · {row.description} · {rupees(row.rate)}/{row.unit}</option>)}</optgroup>}
        </select>
        <input value={line.description} aria-label={`Line ${index + 1} description`} placeholder="Description of goods or work"
          onChange={event => setLine(index, 'description', event.target.value)} />
        <input value={line.unit} aria-label={`Line ${index + 1} unit`} placeholder="Unit"
          onChange={event => setLine(index, 'unit', event.target.value)} />
        <input value={line.quantity} aria-label={`Line ${index + 1} quantity`} type="number" step="any" min="0" max={line.boqItemId ? boqLines.find(row=>String(row.id)===String(line.boqItemId))?.remainingQuantity : undefined} placeholder="Qty"
          onChange={event => setLine(index, 'quantity', event.target.value)} />
        <input value={line.rate} aria-label={`Line ${index + 1} rate`} type="number" step="any" min="0" placeholder="Rate" readOnly={Boolean(line.quotationItemId || line.boqItemId)}
          onChange={event => setLine(index, 'rate', event.target.value)} />
        <span>{rupees((Number(line.quantity) || 0) * (Number(line.rate) || 0))}</span>
        <button type="button" className="icon-btn" aria-label="Remove line"
          disabled={lines.length === 1}
          onClick={() => setLines(current => current.filter((_, position) => position !== index))}>×</button>
      </div>)}
      <button type="button" className="secondary"
        onClick={() => setLines(current => [...current, { ...BLANK_LINE }])}>Add a line</button>
    </div>

    {documentType === 'Tax Invoice' && <label>Tax treatment
      <select value={terms.taxTreatment} onChange={event => setTerm('taxTreatment', event.target.value)}>
        {Object.entries(TAX_LABELS).filter(([value]) => value !== 'Exempt').map(([value, text]) => <option value={value} key={value}>{text}</option>)}
      </select>
    </label>}
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
    <TextArea name="notes" label="Additional information on the invoice" required={false} rows={2} />

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

const BOND_COLUMNS = ['Reference','Kind','In favour of','Bank','Amount','Margin held','Expires','Status',''];
const BOND_TEMPLATE = 'minmax(120px,1fr) 140px minmax(160px,1.2fr) minmax(130px,1fr) 130px 130px 140px 110px 100px';

export function Bonds({ data, can, companyId }) {
  const [bonds, setBonds] = useState([]);
  const [recording, setRecording] = useState(false);
  const [extending,setExtending]=useState(null);
  const load = () => api(`/receivables/bonds?companyId=${companyId}`).then(setBonds).catch(() => setBonds([]));
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);

  const tone = bond => (bond.status !== 'Live' ? slug(bond.status)
    : Number(bond.daysLeft) < 0 ? 'at-risk'
      : Number(bond.daysLeft) <= Number(bond.reminderDays) ? 'watch' : 'on-track');

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
          {bond.status === 'Live' && Number(bond.daysLeft) <= Number(bond.reminderDays) ? <small
            className={Number(bond.daysLeft) < 0 ? 'overdue' : ''}>
            {Number(bond.daysLeft) < 0
              ? `${Math.abs(Number(bond.daysLeft))} days ago`
              : `in ${bond.daysLeft} days`}
          </small> : null}
          <small>{Number(bond.extensions) > 0 ? `${bond.extensions} extension${Number(bond.extensions) === 1 ? '' : 's'} · ` : ''}remind {bond.reminderDays} days before</small>
        </div>
        <Badge tone={tone(bond)}>{bond.status}</Badge>
        {can.invoice&&bond.status==='Live'?<button className="status-button" onClick={()=>setExtending(bond)}>Extend</button>:<span>—</span>}
      </Row>)}
    </Table>
    {recording && <BondForm data={data} companyId={companyId} close={() => setRecording(false)} reload={load} />}
    {extending&&<BondExtensionForm bond={extending} close={()=>setExtending(null)} reload={load}/>}
  </>;
}

function BondForm({ data, companyId, close, reload }) {
  return <FormModal title="Record a bank guarantee" close={close} label="Save bond" onSubmit={async values => {
    await post('/receivables/bonds', {
      companyId,
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
      reminderDays:Number(values.reminderDays||30),
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
    <Field name="reminderDays" label="Remind before expiry (days)" type="number" min="0" max="180" defaultValue="30" />
    <TextArea name="notes" label="Notes" required={false} rows={2} />
  </FormModal>;
}

function BondExtensionForm({bond,close,reload}){return <FormModal title={`Extend ${bond.reference}`} close={close} label="Record extension" onSubmit={async values=>{
  await post(`/receivables/bonds/${bond.id}/extend`,{newExpiryDate:values.newExpiryDate,extendedOn:values.extendedOn,
    reminderDays:Number(values.reminderDays),additionalCommission:Number(values.additionalCommission||0),note:values.note||undefined});await reload();}}>
  <Field name="newExpiryDate" label="New expiry date" type="date"/><Field name="extendedOn" label="Extended on" type="date" defaultValue={todayInput()}/>
  <Field name="reminderDays" label="Remind before expiry (days)" type="number" min="0" max="180" defaultValue={bond.reminderDays||30}/>
  <Field name="additionalCommission" label="Additional bank commission" type="number" min="0" step="0.01" defaultValue="0" required={false}/>
  <TextArea name="note" label="Extension reference / note" required={false} rows={2}/></FormModal>}

/* ---- petty cash ----------------------------------------------------------- */

export function PettyCash({ data, can, companyId }) {
  const [floats, setFloats] = useState([]);
  const [opening, setOpening] = useState(false);
  const [open, setOpen] = useState(null);
  const load = () => api(`/receivables/petty-cash?companyId=${companyId}`).then(setFloats).catch(() => setFloats([]));
  useLiveList(load);
  useEffect(() => { setOpen(null); load(); }, [companyId]);

  /* The card the holder is looking at must follow the data, not the click that opened it. */
  const current = open ? floats.find(float => float.id === open) : null;
  const accountTypes = ['Office expenses', 'Salary advance', 'Fuel'];

  return <div className="petty-cash-management">
    <div className="toolbar">
      <div className="segments"><span className="segment-label">Three separate petty-cash accounts</span></div>
      {can.finance && <button className="secondary" onClick={() => setOpening(true)}>Open a float</button>}
    </div>

    <div className="petty-account-summary">
      {accountTypes.map(type => {
        const accounts = floats.filter(float => float.accountType === type);
        return <article key={type} className={`petty-account ${slug(type)}`}>
          <span>{type}</span>
          <strong>{rupees(accounts.reduce((sum, float) => sum + Number(float.balance), 0))}</strong>
          <small>{accounts.length} active float{accounts.length === 1 ? '' : 's'} · independently funded</small>
        </article>;
      })}
    </div>

    <div className="petty-grid">
      {floats.map(float => {
        const low = Number(float.balance) <= Number(float.lowAt);
        return <button type="button" className="petty-card" key={float.id} onClick={() => setOpen(float.id)}>
          <Badge tone={slug(float.accountType)}>{float.accountType}</Badge>
          <strong>{float.name}</strong>
          <small>{float.holderName}{float.project ? ` · ${float.project}` : ''}</small>
          <b className={low ? 'overdue' : ''}>{rupees(float.balance)}</b>
          <small>{low ? 'Running low — needs topping up' : `of a ${rupees(float.ceiling)} float`}</small>
        </button>;
      })}
      {!floats.length && <EmptyState>No petty cash floats have been opened.</EmptyState>}
    </div>

    {opening && <FloatForm data={data} companyId={companyId} close={() => setOpening(false)} reload={load} />}
    {current && <FloatLedger float={current} data={data} can={can} close={() => setOpen(null)} reload={load} />}
  </div>;
}

function FloatForm({ data, companyId, close, reload }) {
  return <FormModal title="Open a petty cash float" close={close} label="Open float" onSubmit={async values => {
    await post('/receivables/petty-cash', {
      companyId,
      name: values.name,
      accountType: values.accountType,
      holderName: values.holderName,
      projectId: values.projectId ? Number(values.projectId) : null,
      ceiling: Number(values.ceiling) || 0,
      lowAt: Number(values.lowAt) || 0
    });
    await reload();
  }}>
    <SelectField name="accountType" label="Petty cash account"
      options={['Office expenses', 'Salary advance', 'Fuel']} />
    <Field name="name" label="Float name" placeholder="Kandy site office" />
    <Field name="holderName" label="Held by" />
    <SelectField name="projectId" label="Project" required={false}
      options={[['', 'Not project specific'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="ceiling" label="Float ceiling (LKR)" type="number" step="any" min="0" />
    <Field name="lowAt" label="Warn when it falls below" type="number" step="any" min="0" />
  </FormModal>;
}

const ENTRY_TEMPLATE = '110px minmax(180px,1.6fr) 110px minmax(130px,1fr) 130px';

function FloatLedger({ float, data, can, close, reload }) {
  const [entries, setEntries] = useState([]);
  const [adding, setAdding] = useState(false);
  const load = () => api(`/receivables/petty-cash/${float.id}/entries`).then(setEntries).catch(() => setEntries([]));
  useLiveList(load);

  return <Modal title={`${float.name} — ${rupees(float.balance)} in hand`} close={close} wide>
    <div className="petty-ledger-heading"><Badge tone={slug(float.accountType)}>{float.accountType}</Badge>
      <span>{float.accountType === 'Fuel'
        ? 'Top up this float here. Record fuel against a vehicle in Fleet; its cost and vehicle appear below automatically.'
        : 'This balance is maintained independently from the other petty-cash accounts.'}</span></div>
    <Table columns={['Date', 'Description', 'Kind', 'Recorded by', 'Amount']} template={ENTRY_TEMPLATE}
      empty="Nothing has moved through this float yet."
      tools={can.finance ? <button className="secondary" onClick={() => setAdding(true)}>Record a movement</button> : null}>
      {entries.map(entry => <Row template={ENTRY_TEMPLATE} key={entry.id}>
        <span>{shortDate(entry.entryDate)}</span>
        <div><strong>{entry.description}</strong><small>{entry.vehicle
          ? `${entry.vehicle} · ${entry.registration}${entry.project ? ` · ${entry.project}` : ''}`
          : entry.employee
          ? `${entry.employee} · ${entry.employeeCode}${entry.outstandingAdvance > 0 ? ` · ${rupees(entry.outstandingAdvance)} awaiting payroll` : ' · recovered'}`
          : entry.project || entry.category || '—'}</small></div>
        <Badge tone={slug(entry.kind)}>{entry.kind}</Badge>
        <span>{entry.recordedBy}</span>
        <strong className={Number(entry.amount) < 0 ? 'overdue' : ''}>{rupees(entry.amount)}</strong>
      </Row>)}
    </Table>
    {adding && <EntryForm float={float} employees={data.employees} close={() => setAdding(false)}
      reload={async () => { await load(); await reload(); }} />}
  </Modal>;
}

function EntryForm({ float, employees, close, reload }) {
  const [kind, setKind] = useState(float.accountType === 'Fuel' ? 'Top up' : 'Spend');
  return <FormModal title={`Movement on ${float.name}`} close={close} label="Record it" onSubmit={async values => {
    await post(`/receivables/petty-cash/${float.id}/entries`, {
      kind: values.kind,
      amount: Number(values.amount),
      entryDate: values.entryDate,
      description: values.description,
      category: values.category || undefined,
      employeeId: values.employeeId ? Number(values.employeeId) : undefined
    });
    await reload();
  }}>
    <label>What happened <span aria-hidden="true">*</span><select name="kind" value={kind} onChange={event => setKind(event.target.value)} required>
      {(float.accountType === 'Fuel' ? ['Top up', 'Return', 'Adjustment'] : ['Spend', 'Top up', 'Return', 'Adjustment'])
        .map(option => <option key={option}>{option}</option>)}
    </select></label>
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="entryDate" label="Date" type="date" defaultValue={todayInput()} />
    {float.accountType === 'Salary advance' && kind === 'Spend' && <SelectField name="employeeId" label="Employee receiving the advance"
      options={employees.filter(employee => employee.status !== 'Left').map(employee => [employee.id, `${employee.name} — ${employee.code}`])} />}
    <Field name="category" label="Category" required={false} placeholder="Fuel, refreshments, courier" />
    <Field name="description" label="Description" wide placeholder="Diesel for the site generator" />
    {float.accountType === 'Salary advance' && <p className="form-note wide">Salary advances are recovered automatically from this employee's next available payroll, with any unpaid balance carried forward.</p>}
    {float.accountType === 'Fuel' && <p className="form-note wide">For fuel purchased for a vehicle, go to Fleet → Fuel & service → Record fuel. The float will be reduced automatically.</p>}
  </FormModal>;
}
