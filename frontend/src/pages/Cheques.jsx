import React, { useEffect, useState } from 'react';
import { Banknote, CalendarClock, CircleAlert, CircleCheck } from 'lucide-react';
import { api, patch, post, rupees, rupeesExact, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Row, SelectField, Summary, Table, TextArea, Required, useLiveList } from '../ui.jsx';

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
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && received.some(row => Number(row.id) === id)) document.getElementById(`received-cheque-${id}`)?.scrollIntoView({ block: 'center' }); }, [received]);
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
      {received.map(row=><Row template={TEMPLATE} key={row.id} id={`received-cheque-${row.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(row.id) ? 'linked-record' : ''}>
        <div><strong>{row.chequeNumber}</strong><small>{row.bank}</small></div><div><strong>{row.payer}</strong><small>{row.purpose}</small></div>
        <div><span>{row.project}</span><small>{row.invoiceReference||'Not invoice-linked'}</small></div><span>{shortDate(row.chequeDate)}</span>
        <strong>{rupees(row.amount)}</strong><Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.invoice&&['On hand','Deposited','Re-deposited','Returned'].includes(row.status)?<button className="status-button" onClick={()=>setConfirmingReceived(row)}>{row.status==='On hand'?'Deposit':row.status==='Returned'?'Follow up':'Confirm'}</button>:<span>{row.confirmedBy||'—'}</span>}
      </Row>)}
    </Table>
    <div className="cheque-section-heading outgoing"><div><span>Money going out</span><h2>Cheques issued by Finance</h2></div>
      {can.finance && <button type="button" className="secondary" onClick={() => setAdding(true)}>Issue cheque</button>}</div>
    <div className="attendance-summary cheque-summary">
      <Summary label="Awaiting confirmation" value={pending.length} icon={CalendarClock} />
      <Summary label="Due in seven days" value={pending.filter(row => row.daysUntil >= 0 && row.daysUntil <= 7).length} icon={Banknote} />
      <Summary label="Past cheque date" value={pending.filter(row => row.daysUntil < 0).length} icon={CircleAlert} />
      <Summary label="Pending value" value={rupees(pending.reduce((sum, row) => sum + Number(row.amount), 0))} icon={CircleCheck} />
    </div>
    <Table columns={['Cheque', 'Payee / purpose', 'Bank', 'Cheque date', 'Amount', 'Status', 'Follow-up']}
      template={TEMPLATE} title="Issued cheque register" empty="No issued cheques recorded.">
      {rows.map(row => <Row template={TEMPLATE} key={row.id}>
        <div><strong>{row.chequeNumber}</strong><small>{row.supplier || 'General payment'}</small>{row.invoices?.length ? row.invoices.map(invoice=><small key={invoice.invoiceId}>{invoice.invoiceNo} · {rupeesExact(invoice.amount)}</small>) : <small>{row.invoiceNo || 'Not invoice-linked'}</small>}</div>
        <div><strong>{row.payee}</strong><small>{row.purpose}</small></div>
        <span>{row.bank}</span>
        <div><span className={OPEN.includes(row.status) && row.daysUntil < 0 ? 'overdue' : ''}>{shortDate(row.chequeDate)}</span>
          {OPEN.includes(row.status) && <small>{row.daysUntil < 0 ? `${Math.abs(row.daysUntil)} days awaiting confirmation` : row.daysUntil === 0 ? 'Due today' : `In ${row.daysUntil} days`}</small>}</div>
        <div><strong>{rupeesExact(row.amount)}</strong>{row.amountOverrideReason&&<small>Adjusted from {rupeesExact(row.invoiceTotal)}: {row.amountOverrideReason}</small>}</div>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.finance && OPEN.includes(row.status) ? <button className="status-button" onClick={() => setConfirming(row)}>Confirm</button> : <span>{row.confirmedBy || '—'}</span>}
      </Row>)}
    </Table>
    {adding && <ChequeForm key={companyId} companyId={companyId} close={() => setAdding(false)} reload={load} />}
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
  const options=cheque.status==='On hand'?['Deposited','Returned','Cancelled']:cheque.status==='Returned'?['Re-deposited','Cancelled']:['Cleared','Returned','Re-deposited','Cancelled'];
  return <FormModal title={`Update received cheque ${cheque.chequeNumber}`} close={close} label="Save update" onSubmit={async values=>{
    await patch(`/receivables/cheques/${cheque.id}`,{status:values.status,notes:values.notes||undefined});await reload();
  }}><SelectField name="status" label="What happened" options={options}/><TextArea name="notes" label="Bank or follow-up note" rows={3}/></FormModal>;
}

const invoiceAvailable = invoice => Math.max(0,Number(invoice.availableForCheque ?? (Number(invoice.amount)-Number(invoice.paidAmount||0))));

function ChequeForm({companyId,close,reload}) {
  const [suppliers,setSuppliers]=useState([]),[invoices,setInvoices]=useState([]),[error,setError]=useState('');
  const [supplierId,setSupplierId]=useState(''),[selectedIds,setSelectedIds]=useState([]),[search,setSearch]=useState('');
  const [amount,setAmount]=useState(''),[amountEdited,setAmountEdited]=useState(false),[overrideReason,setOverrideReason]=useState('');
  const load=()=>{setError('');return Promise.all([api(`/purchasing/suppliers?companyId=${companyId}`).then(setSuppliers),api(`/purchasing/invoices?companyId=${companyId}`).then(setInvoices)]).catch(failure=>setError(failure.message));};
  useLiveList(load);
  const selected=invoices.filter(row=>selectedIds.includes(Number(row.id))).sort((a,b)=>String(a.invoiceDate).localeCompare(String(b.invoiceDate))||Number(a.id)-Number(b.id));
  const totalCents=selected.reduce((sum,row)=>sum+Math.round(invoiceAvailable(row)*100),0);
  const overridden=selectedIds.length>0&&amount!==''&&Math.round(Number(amount)*100)!==totalCents;
  useEffect(()=>{if(!amountEdited&&selectedIds.length)setAmount((totalCents/100).toFixed(2));},[totalCents,amountEdited,selectedIds.length]);
  const options=invoices.filter(row=>String(row.supplierId)===supplierId&&Number(row.companyId)===Number(companyId)
    &&(row.status!=='Paid'||selectedIds.includes(Number(row.id)))
    &&[row.invoiceNo,row.orderReference].some(value=>String(value||'').toLowerCase().includes(search.toLowerCase())));
  let remaining=Math.round(Number(amount||0)*100);
  const split=selected.map(row=>{const paid=Math.min(Math.max(0,remaining),Math.round(invoiceAvailable(row)*100));remaining-=paid;return {...row,allocated:paid/100};});
  return <FormModal title="Issue a future cheque" close={close} label="Record cheque" wide onSubmit={async values=>{
    if(overridden&&overrideReason.trim().length<3)throw new Error('Enter a reason for changing the calculated invoice total.');
    await post('/purchasing/cheques',{
      companyId,supplierId:supplierId?Number(supplierId):undefined,invoiceIds:selectedIds,
      ...(selectedIds.length?{expectedInvoiceTotal:totalCents/100}:{}),
      amountOverrideReason:overridden?overrideReason.trim():undefined,
      chequeNumber:values.chequeNumber,bank:values.bank,payee:values.payee,purpose:values.purpose,
      amount:Number(amount),issueDate:values.issueDate,chequeDate:values.chequeDate,
      reminderDays:Number(values.reminderDays),notes:values.notes||undefined
    });await reload();
  }}>
    {error&&<p className="form-error wide" role="alert">{error}</p>}
    <label className="wide">Supplier<select name="supplierId" value={supplierId} onChange={event=>{
      setSupplierId(event.target.value);setSelectedIds([]);setAmount('');setAmountEdited(false);setOverrideReason('');setSearch('');
    }}><option value="">Not supplier-specific</option>{suppliers.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
    <fieldset className="cheque-invoice-picker wide"><legend>Supplier invoices — select one or more</legend>
      {!supplierId?<p className="form-note">Choose a supplier to select their invoices. Leave invoices unselected for a payment that is not invoice-linked.</p>:<>
        <input aria-label="Search supplier invoices" placeholder="Find invoice or order reference" value={search} onChange={event=>setSearch(event.target.value)}/>
        <div className="cheque-invoice-options">{options.map(row=>{
          const chosen=selectedIds.includes(Number(row.id)),available=invoiceAvailable(row);
          return <label className="cheque-invoice-option" key={row.id}><input type="checkbox" checked={chosen} disabled={!chosen&&available<=0} onChange={event=>{
            const checked=event.target.checked;setSelectedIds(current=>checked?[...new Set([...current,Number(row.id)])]:current.filter(id=>id!==Number(row.id)));
            setAmountEdited(false);setOverrideReason('');if(chosen&&selectedIds.length===1)setAmount('');
          }}/><span><strong>{row.invoiceNo}</strong><small>{shortDate(row.invoiceDate)}{row.orderReference?` · ${row.orderReference}`:''}</small>{Number(row.pendingChequeAmount)>0&&<small>{rupeesExact(row.pendingChequeAmount)} already covered by pending cheques</small>}</span><b>{rupeesExact(available)}</b></label>;
        })}</div>
        {!options.length&&<p className="form-note">No matching unpaid invoices for this supplier.</p>}
      </>}
      <div className="cheque-invoice-total"><span>{selectedIds.length} invoice{selectedIds.length===1?'':'s'} selected · available balance</span><strong>{rupeesExact(totalCents/100)}</strong></div>
      <button type="button" className="status-button" onClick={load}>Refresh invoice balances</button>
    </fieldset>
    <Field name="chequeNumber" label="Cheque number"/>
    <Field name="bank" label="Bank and account"/>
    <Field name="payee" label="Payee"/>
    <label>Amount (LKR)<Required/><input name="amount" type="number" min="0.01" step="0.01" required max={selectedIds.length?totalCents/100:undefined} value={amount} onChange={event=>{setAmount(event.target.value);setAmountEdited(true);}}/></label>
    {overridden&&<label className="wide">Reason for changing the total<Required/><textarea name="amountOverrideReason" required minLength={3} maxLength={600} rows={2} value={overrideReason} onChange={event=>setOverrideReason(event.target.value)}/></label>}
    {selectedIds.length>0&&<div className="cheque-allocation-preview wide"><strong>This cheque will pay</strong>{split.map(row=><div key={row.id}><span>{row.invoiceNo}</span><b>{rupeesExact(row.allocated)}</b></div>)}
      <p className="form-note">The amount fills from the selected available balances. A reduced amount pays the oldest invoice first. It cannot exceed those balances. Invoices are updated only after the cheque clears.</p>
      {amountEdited&&<button type="button" className="status-button" onClick={()=>{setAmountEdited(false);setOverrideReason('');}}>Use calculated total</button>}
    </div>}
    <Field name="issueDate" label="Issued on" type="date" defaultValue={todayInput()}/>
    <Field name="chequeDate" label="Cheque date" type="date" defaultValue={todayInput()}/>
    <Field name="reminderDays" label="Remind before (days)" type="number" min="0" max="30" defaultValue="3"/>
    <Field name="purpose" label="Payment purpose" wide/>
    <TextArea name="notes" label="Notes" required={false} rows={2}/>
  </FormModal>;
}

function ChequeStatusForm({ cheque, close, reload }) {
  return <FormModal title={`Confirm cheque ${cheque.chequeNumber}`} close={close} label="Save outcome" onSubmit={async values => {
    await patch(`/purchasing/cheques/${cheque.id}`, { status: values.status, notes: values.notes || undefined });
    await reload();
  }}>
    {cheque.invoices?.length>0&&<div className="cheque-allocation-preview wide"><strong>Invoice settlement split</strong>{cheque.invoices.map(row=><div key={row.invoiceId}><span>{row.invoiceNo}</span><b>{rupeesExact(row.amount)}</b></div>)}{cheque.amountOverrideReason&&<p className="form-note">Amount changed from {rupeesExact(cheque.invoiceTotal)}: {cheque.amountOverrideReason}</p>}</div>}
    <SelectField name="status" label="What happened" options={['Cleared','Returned','Replaced','Cancelled']} />
    <TextArea name="notes" label="Confirmation note" placeholder="Bank confirmation, return reason or replacement cheque number" rows={3} />
  </FormModal>;
}
