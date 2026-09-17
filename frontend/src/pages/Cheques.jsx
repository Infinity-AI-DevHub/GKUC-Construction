import React, { useEffect, useState } from 'react';
import { Banknote, CalendarClock, CircleAlert, CircleCheck } from 'lucide-react';
import { api, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Row, SelectField, Summary, Table, TextArea, useLiveList } from '../ui.jsx';

const OPEN = ['Prepared', 'Issued'];
const TEMPLATE = 'minmax(130px,.8fr) minmax(180px,1.2fr) minmax(140px,1fr) 120px 130px 110px 110px';

export default function Cheques({ can, data, companyId }) {
  const [rows, setRows] = useState([]);
  const [received, setReceived] = useState([]);
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [confirmingReceived, setConfirmingReceived] = useState(null);
  const load = () => Promise.all([
    api(`/purchasing/cheques?companyId=${companyId}`).then(setRows).catch(() => setRows([])),
    api(`/receivables/cheques?companyId=${companyId}`).then(setReceived).catch(() => setReceived([]))
  ]);
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);
  const pending = rows.filter(row => OPEN.includes(row.status));
  const incomingOpen = received.filter(row => ['On hand','Deposited','Re-deposited'].includes(row.status));
  return <>
    <div className="cheque-section-heading"><div><span>Money coming in</span><h2>Cheques received from clients</h2></div>
      {can.invoice && <button className="secondary" onClick={() => setReceiving(true)}>Receive cheque</button>}</div>
    <div className="attendance-summary cheque-summary">
      <Summary label="Held for deposit" value={received.filter(row => row.status === 'On hand').length} icon={CalendarClock} />
      <Summary label="At the bank" value={received.filter(row => ['Deposited','Re-deposited'].includes(row.status)).length} icon={Banknote} />
      <Summary label="Follow-up overdue" value={incomingOpen.filter(row => row.status === 'On hand' ? row.daysToDeposit < 0 : row.daysToCheque < 0).length} icon={CircleAlert} />
      <Summary label="Awaiting clearance" value={rupees(incomingOpen.reduce((sum,row)=>sum+Number(row.amount),0))} icon={CircleCheck} />
    </div>
    <Table columns={['Cheque','Payer / purpose','Project','Cheque date','Amount','Status','Follow-up']} template={TEMPLATE}
      title="Received cheque register" empty="No client cheques received.">
      {received.map(row=><Row template={TEMPLATE} key={row.id}>
        <div><strong>{row.chequeNumber}</strong><small>{row.bank}</small></div><div><strong>{row.payer}</strong><small>{row.purpose}</small></div>
        <div><span>{row.project}</span><small>{row.invoiceReference||'Not invoice-linked'}</small></div><span>{shortDate(row.chequeDate)}</span>
        <strong>{rupees(row.amount)}</strong><Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.invoice&&['On hand','Deposited','Re-deposited'].includes(row.status)?<button className="status-button" onClick={()=>setConfirmingReceived(row)}>{row.status==='On hand'?'Deposit':'Confirm'}</button>:<span>{row.confirmedBy||'—'}</span>}
      </Row>)}
    </Table>
    <div className="cheque-section-heading outgoing"><div><span>Money going out</span><h2>Cheques issued by Finance</h2></div></div>
    <div className="attendance-summary cheque-summary">
      <Summary label="Awaiting confirmation" value={pending.length} icon={CalendarClock} />
      <Summary label="Due in seven days" value={pending.filter(row => row.daysUntil >= 0 && row.daysUntil <= 7).length} icon={Banknote} />
      <Summary label="Past cheque date" value={pending.filter(row => row.daysUntil < 0).length} icon={CircleAlert} />
      <Summary label="Pending value" value={rupees(pending.reduce((sum, row) => sum + Number(row.amount), 0))} icon={CircleCheck} />
    </div>
    <Table columns={['Cheque', 'Payee / purpose', 'Bank', 'Cheque date', 'Amount', 'Status', 'Follow-up']}
      template={TEMPLATE} title="Issued cheque register" empty="No issued cheques recorded."
      tools={can.finance ? <button className="secondary" onClick={() => setAdding(true)}>Issue cheque</button> : null}>
      {rows.map(row => <Row template={TEMPLATE} key={row.id}>
        <div><strong>{row.chequeNumber}</strong><small>{row.invoiceNo || row.supplier || 'General payment'}</small></div>
        <div><strong>{row.payee}</strong><small>{row.purpose}</small></div>
        <span>{row.bank}</span>
        <div><span className={OPEN.includes(row.status) && row.daysUntil < 0 ? 'overdue' : ''}>{shortDate(row.chequeDate)}</span>
          {OPEN.includes(row.status) && <small>{row.daysUntil < 0 ? `${Math.abs(row.daysUntil)} days awaiting confirmation` : row.daysUntil === 0 ? 'Due today' : `In ${row.daysUntil} days`}</small>}</div>
        <strong>{rupees(row.amount)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.finance && OPEN.includes(row.status) ? <button className="status-button" onClick={() => setConfirming(row)}>Confirm</button> : <span>{row.confirmedBy || '—'}</span>}
      </Row>)}
    </Table>
    {adding && <ChequeForm companyId={companyId} close={() => setAdding(false)} reload={load} />}
    {confirming && <ChequeStatusForm cheque={confirming} close={() => setConfirming(null)} reload={load} />}
    {receiving && <ReceivedChequeForm data={data} companyId={companyId} close={() => setReceiving(false)} reload={load} />}
    {confirmingReceived && <ReceivedStatusForm cheque={confirmingReceived} close={() => setConfirmingReceived(null)} reload={load} />}
  </>;
}

function ReceivedChequeForm({ data, companyId, close, reload }) {
  const [invoices,setInvoices]=useState([]);
  useLiveList(()=>api(`/receivables/invoices?companyId=${companyId}`).then(setInvoices));
  return <FormModal title="Receive a client cheque" close={close} label="Record received cheque" onSubmit={async values=>{
    await post('/receivables/cheques',{companyId,projectId:Number(values.projectId),invoiceId:values.invoiceId?Number(values.invoiceId):undefined,
      chequeNumber:values.chequeNumber,bank:values.bank,payer:values.payer,purpose:values.purpose,amount:Number(values.amount),
      receivedDate:values.receivedDate,chequeDate:values.chequeDate,depositBy:values.depositBy,
      reminderDays:Number(values.reminderDays),notes:values.notes||undefined});await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(row=>[row.id,row.name])}/>
    <SelectField name="invoiceId" label="Client invoice" required={false} options={[["",'Not linked to an invoice'],...invoices.filter(row=>!['Paid','Cancelled','Draft'].includes(row.status)).map(row=>[row.id,`${row.reference} — ${row.client}`])]}/>
    <Field name="chequeNumber" label="Cheque number"/><Field name="bank" label="Drawer bank"/>
    <Field name="payer" label="Received from"/><Field name="amount" label="Amount (LKR)" type="number" min="0" step="any"/>
    <Field name="receivedDate" label="Received on" type="date" defaultValue={todayInput()}/><Field name="chequeDate" label="Cheque date" type="date" defaultValue={todayInput()}/>
    <Field name="depositBy" label="Deposit by" type="date" defaultValue={todayInput()}/><Field name="reminderDays" label="Remind before (days)" type="number" min="0" max="30" defaultValue="2"/>
    <Field name="purpose" label="Payment purpose" wide/><TextArea name="notes" label="Notes" required={false} rows={2}/>
  </FormModal>;
}

function ReceivedStatusForm({ cheque, close, reload }) {
  const options=cheque.status==='On hand'?['Deposited','Returned','Cancelled']:['Cleared','Returned','Re-deposited','Cancelled'];
  return <FormModal title={`Update received cheque ${cheque.chequeNumber}`} close={close} label="Save update" onSubmit={async values=>{
    await patch(`/receivables/cheques/${cheque.id}`,{status:values.status,notes:values.notes||undefined});await reload();
  }}><SelectField name="status" label="What happened" options={options}/><TextArea name="notes" label="Bank or follow-up note" rows={3}/></FormModal>;
}

function ChequeForm({ companyId, close, reload }) {
  const [suppliers, setSuppliers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  useLiveList(() => Promise.all([
    api(`/purchasing/suppliers?companyId=${companyId}`).then(setSuppliers), api(`/purchasing/invoices?companyId=${companyId}`).then(setInvoices)
  ]));
  return <FormModal title="Issue a future cheque" close={close} label="Record cheque" onSubmit={async values => {
    await post('/purchasing/cheques', {
      companyId,
      supplierId: values.supplierId ? Number(values.supplierId) : undefined,
      invoiceId: values.invoiceId ? Number(values.invoiceId) : undefined,
      chequeNumber: values.chequeNumber, bank: values.bank, payee: values.payee,
      purpose: values.purpose, amount: Number(values.amount), issueDate: values.issueDate,
      chequeDate: values.chequeDate, reminderDays: Number(values.reminderDays), notes: values.notes || undefined
    }); await reload();
  }}>
    <SelectField name="supplierId" label="Supplier" required={false} options={[["",'Not supplier-specific'],...suppliers.map(row => [row.id,row.name])]} />
    <SelectField name="invoiceId" label="Supplier invoice" required={false} options={[["",'Not linked to an invoice'],...invoices.filter(row => row.status !== 'Paid').map(row => [row.id,`${row.invoiceNo} — ${row.supplier}`])]} />
    <Field name="chequeNumber" label="Cheque number" />
    <Field name="bank" label="Bank and account" />
    <Field name="payee" label="Payee" />
    <Field name="amount" label="Amount (LKR)" type="number" min="0" step="any" />
    <Field name="issueDate" label="Issued on" type="date" defaultValue={todayInput()} />
    <Field name="chequeDate" label="Cheque date" type="date" defaultValue={todayInput()} />
    <Field name="reminderDays" label="Remind before (days)" type="number" min="0" max="30" defaultValue="3" />
    <Field name="purpose" label="Payment purpose" wide />
    <TextArea name="notes" label="Notes" required={false} rows={2} />
  </FormModal>;
}

function ChequeStatusForm({ cheque, close, reload }) {
  return <FormModal title={`Confirm cheque ${cheque.chequeNumber}`} close={close} label="Save outcome" onSubmit={async values => {
    await patch(`/purchasing/cheques/${cheque.id}`, { status: values.status, notes: values.notes || undefined });
    await reload();
  }}>
    <SelectField name="status" label="What happened" options={['Cleared','Returned','Replaced','Cancelled']} />
    <TextArea name="notes" label="Confirmation note" placeholder="Bank confirmation, return reason or replacement cheque number" rows={3} />
  </FormModal>;
}
