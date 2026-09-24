import React, { useEffect, useState } from 'react';
import { CircleDollarSign, TrendingUp, Wallet } from 'lucide-react';
import { api, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Page, Progress, Row, SelectField, Summary, Table, Tabs, useLiveList } from '../ui.jsx';
import { useOptions } from '../options.js';
import { Bonds, ClientInvoices, PettyCash } from '../Receivables.jsx';
import FinanceReports from './FinanceReports.jsx';
import Cheques from './Cheques.jsx';
import { DailySheetDetail } from './CostControl.jsx';

const TABS = ['Financial reports','Invoices','Daily cost review','Budget monitoring','Bills','Credit cards','VAT ledger','Cheques','Bonds','Petty cash','Expenses','Income','Supplier invoices','Categories'];

/** PID 2.10 — costs, payments and profitability in one view, watched continuously. */
export default function Finance({ data, reload, can, companyId, company }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');
  const [summary, setSummary] = useState(null);

  const load = () => api(`/finance/summary?companyId=${companyId}`).then(setSummary).catch(() => setSummary(null));
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);

  const actions = {
    'Financial reports': null,
    'Budget monitoring': null,
    'Daily cost review': null,
    Bills: can.finance&&'Record bill',
    'Credit cards': null,
    'VAT ledger': null,
    Invoices: null,
    Cheques: null,
    Bonds: null,
    'Petty cash': null,
    Expenses: can.finance && 'Record expense',
    Income: can.finance && 'Record income',
    'Supplier invoices': can.finance && 'Record invoice',
    Categories: can.finance && 'Add category'
  };

  const refresh = async () => { await load(); await reload(); };

  return <Page title="Finance" subtitle={`Project costs, payments and profitability for ${company?.name || 'the selected company'}.`}
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Financial reports' && <FinanceReports projects={data.projects} companyId={companyId} company={company} />}
    {tab === 'Budget monitoring' && <BudgetMonitoring summary={summary} />}
    {tab === 'Daily cost review' && <DailyCostReview companyId={companyId} can={can} />}
    {tab === 'Bills' && <Bills data={data} can={can} companyId={companyId} open={open==='Bills'} close={()=>setOpen('')} />}
    {tab === 'Credit cards' && <CreditCards can={can} companyId={companyId} />}
    {tab === 'VAT ledger' && <VatLedger companyId={companyId} />}
    {tab === 'Invoices' && <ClientInvoices data={data} can={can} companyId={companyId} />}
    {tab === 'Cheques' && <Cheques can={can} data={data} companyId={companyId} />}
    {tab === 'Bonds' && <Bonds data={data} can={can} companyId={companyId} />}
    {tab === 'Petty cash' && <PettyCash data={data} can={can} companyId={companyId} />}
    {tab === 'Expenses' && <Expenses companyId={companyId} />}
    {tab === 'Income' && <Income companyId={companyId} />}
    {tab === 'Supplier invoices' && <Invoices can={can} refresh={refresh} companyId={companyId} />}
    {tab === 'Categories' && <Categories companyId={companyId} />}

    {open === 'Expenses' && <ExpenseForm data={data} close={() => setOpen('')} reload={refresh} />}
    {open === 'Income' && <IncomeForm data={data} close={() => setOpen('')} reload={refresh} />}
    {open === 'Supplier invoices' && <InvoiceForm companyId={companyId} close={() => setOpen('')} reload={refresh} />}
    {open === 'Categories' && <CategoryForm close={() => setOpen('')} reload={refresh} />}
  </Page>;
}

function DailyCostReview({ companyId, can }) {
  const [rows,setRows]=useState([]),[selected,setSelected]=useState(null),[error,setError]=useState('');
  const load=()=>api(`/boq/cost-control/review-queue?companyId=${companyId}`).then(setRows).catch(failure=>setError(failure.message));
  useEffect(()=>{setRows([]);setError('');load();},[companyId]);
  const template='120px minmax(160px,1.3fr) 120px 70px 130px 130px 115px 90px';
  return <>{error && <p className="form-error">{error}</p>}<div className="attendance-summary"><Summary label="Awaiting review" value={rows.filter(row=>row.status==='Submitted').length} icon={Wallet}/><Summary label="Approved sheets" value={rows.filter(row=>row.status==='Approved').length} icon={CircleDollarSign}/></div>
    <Table title="QS daily cost submissions" columns={['Date','Project','Submitted by','Lines','Site cost','Quoted recovery','Status','']} template={template} empty="No daily cost sheets have been submitted for this company.">{rows.map(row=><Row template={template} key={row.id}><span>{shortDate(row.workDate)}</span><strong>{row.project}</strong><span>{row.submittedBy}</span><span>{row.lineCount}</span><strong>{rupees(row.totalCost)}</strong><span>{rupees(row.quotedRecovery)}</span><Badge tone={row.status==='Approved'?'on-track':row.status==='Returned'?'at-risk':'watch'}>{row.status}</Badge><button className="status-button" onClick={()=>setSelected(row.id)}>{can.finance&&row.status==='Submitted'?'Review':'View'}</button></Row>)}</Table>
    {selected && <DailySheetDetail id={selected} close={()=>setSelected(null)} review={can.finance} reload={load} />}
  </>;
}

function Bills({data,can,companyId,open,close}){
  const [rows,setRows]=useState([]),[paying,setPaying]=useState(null);
  const load=()=>api(`/finance/bills?companyId=${companyId}`).then(setRows).catch(()=>setRows([]));useLiveList(load);useEffect(()=>{load();},[companyId]);
  const template='130px minmax(180px,1.4fr) minmax(140px,1fr) 120px 130px 120px 110px';
  return <><div className="attendance-summary"><Summary label="Unpaid bills" value={rows.filter(r=>r.status==='Unpaid').length} icon={Wallet}/>
    <Summary label="Due within 5 days" value={rows.filter(r=>r.status==='Unpaid'&&r.daysUntil>=0&&r.daysUntil<=5).length} icon={CircleDollarSign}/>
    <Summary label="Overdue" value={rows.filter(r=>r.status==='Unpaid'&&r.daysUntil<0).length} icon={TrendingUp}/></div>
    <Table columns={['Type','Provider / reference','Project','Due','Total','Status','']} template={template} title="Electricity, water and operating bills" empty="No operating bills recorded.">
      {rows.map(r=><Row template={template} key={r.id}><Badge tone={slug(r.billType)}>{r.billType}</Badge><div><strong>{r.provider}</strong><small>{r.reference}</small></div>
        <span>{r.project||'Company office'}</span><span className={r.status==='Unpaid'&&r.daysUntil<0?'overdue':''}>{shortDate(r.dueDate)}</span><strong>{rupees(r.totalAmount)}</strong>
        <Badge tone={slug(r.status)}>{r.status}</Badge>{can.finance&&r.status==='Unpaid'?<button className="status-button" onClick={()=>setPaying(r)}>Pay</button>:<span>—</span>}</Row>)}</Table>
    {open&&<BillForm data={data} companyId={companyId} close={close} reload={load}/>} {paying&&<BillPayment bill={paying} close={()=>setPaying(null)} reload={load}/>}</>;
}

function BillForm({data,companyId,close,reload}){return <FormModal title="Record an operating bill" close={close} label="Save bill" onSubmit={async v=>{
  await post('/finance/bills',{companyId,projectId:v.projectId?Number(v.projectId):null,billType:v.billType,provider:v.provider,accountNumber:v.accountNumber||undefined,
    reference:v.reference,periodFrom:v.periodFrom||undefined,periodTo:v.periodTo||undefined,billDate:v.billDate,dueDate:v.dueDate,netAmount:Number(v.netAmount),
    taxTreatment:v.taxTreatment,vatRate:Number(v.vatRate||0),reminderDays:Number(v.reminderDays||5),notes:v.notes||undefined});await reload();}}>
  <SelectField name="billType" label="Bill type" options={['Electricity','Water','Telephone','Internet','Rent','Insurance','Rates and taxes','Other']}/>
  <Field name="provider" label="Provider"/><Field name="reference" label="Bill / invoice number"/><Field name="accountNumber" label="Account number" required={false}/>
  <SelectField name="projectId" label="Cost belongs to" required={false} options={[["",'Company office'],...data.projects.map(p=>[p.id,p.name])]}/>
  <Field name="periodFrom" label="Period from" type="date" required={false}/><Field name="periodTo" label="Period to" type="date" required={false}/>
  <Field name="billDate" label="Bill date" type="date" defaultValue={todayInput()}/><Field name="dueDate" label="Payment deadline" type="date"/>
  <Field name="netAmount" label="Amount before VAT (LKR)" type="number" min="0" step="0.01"/><SelectField name="taxTreatment" label="VAT treatment" options={['Standard','Exempt']}/>
  <Field name="vatRate" label="VAT rate (%)" type="number" min="0" max="100" step="0.01" defaultValue="18"/><Field name="reminderDays" label="Remind before deadline (days)" type="number" min="0" max="90" defaultValue="5"/>
  <Field name="notes" label="Notes" wide required={false}/></FormModal>}

function BillPayment({bill,close,reload}){return <FormModal title={`Pay ${bill.provider} — ${bill.reference}`} close={close} label="Mark paid" onSubmit={async v=>{await post(`/finance/bills/${bill.id}/pay`,{paidDate:v.paidDate,method:v.method,reference:v.reference||undefined});await reload();}}>
  <Field name="paidDate" label="Paid on" type="date" defaultValue={todayInput()}/><SelectField name="method" label="Method" options={['Bank transfer','Cheque','Cash','Card']}/><Field name="reference" label="Payment reference" required={false}/></FormModal>}

function CreditCards({can,companyId}){const [data,setData]=useState({cards:[],statements:[]}),[mode,setMode]=useState(''),[paying,setPaying]=useState(null);
  const load=()=>api(`/finance/credit-cards?companyId=${companyId}`).then(setData).catch(()=>setData({cards:[],statements:[]}));useLiveList(load);useEffect(()=>{load();},[companyId]);
  const t='minmax(160px,1.2fr) 120px 120px 130px 130px 120px 110px';return <><div className="toolbar"><div className="segments"><span className="segment-label">{data.cards.length} company card{data.cards.length===1?'':'s'}</span></div>{can.finance&&<span className="row-actions"><button className="secondary" onClick={()=>setMode('card')}>Add card</button><button className="secondary" onClick={()=>setMode('statement')} disabled={!data.cards.length}>Add statement</button></span>}</div>
  <Table columns={['Card','Statement','Due','Amount','Outstanding','Status','']} template={t} title="Credit card statements and payment deadlines" empty="No card statements recorded.">{data.statements.map(s=><Row template={t} key={s.id}><div><strong>{s.card}</strong><small>{s.bank} •••• {s.lastFour}</small></div><span>{shortDate(s.statementDate)}</span><span className={s.status!=='Paid'&&s.daysUntil<0?'overdue':''}>{shortDate(s.dueDate)}</span><span>{rupees(s.amount)}</span><strong>{rupees(Number(s.amount)-Number(s.paidAmount))}</strong><Badge tone={slug(s.status)}>{s.status}</Badge>{can.finance&&s.status!=='Paid'?<button className="status-button" onClick={()=>setPaying(s)}>Pay</button>:<span>—</span>}</Row>)}</Table>
  {mode==='card'&&<CardForm companyId={companyId} close={()=>setMode('')} reload={load}/>} {mode==='statement'&&<StatementForm cards={data.cards} close={()=>setMode('')} reload={load}/>} {paying&&<CardPayment statement={paying} close={()=>setPaying(null)} reload={load}/>}</>}

function CardForm({companyId,close,reload}){return <FormModal title="Add a company credit card" close={close} label="Save card" onSubmit={async v=>{await post('/finance/credit-cards',{companyId,name:v.name,bank:v.bank,lastFour:v.lastFour,cardholder:v.cardholder,creditLimit:Number(v.creditLimit||0),defaultReminderDays:Number(v.defaultReminderDays||5)});await reload();}}><Field name="name" label="Card name" placeholder="Operations Visa"/><Field name="bank" label="Bank"/><Field name="lastFour" label="Last four digits" pattern="[0-9]{4}"/><Field name="cardholder" label="Cardholder"/><Field name="creditLimit" label="Credit limit (LKR)" type="number" min="0"/><Field name="defaultReminderDays" label="Default reminder (days before)" type="number" min="0" max="90" defaultValue="5"/></FormModal>}
function StatementForm({cards,close,reload}){return <FormModal title="Record a card statement" close={close} label="Save statement" onSubmit={async v=>{await post('/finance/credit-card-statements',{cardId:Number(v.cardId),statementDate:v.statementDate,periodFrom:v.periodFrom||undefined,periodTo:v.periodTo||undefined,dueDate:v.dueDate,amount:Number(v.amount),minimumDue:Number(v.minimumDue||0),reminderDays:v.reminderDays===''?undefined:Number(v.reminderDays),notes:v.notes||undefined});await reload();}}><SelectField name="cardId" label="Card" options={cards.map(c=>[c.id,`${c.name} — ${c.bank} •••• ${c.lastFour}`])}/><Field name="statementDate" label="Statement date" type="date" defaultValue={todayInput()}/><Field name="dueDate" label="Payment deadline" type="date"/><Field name="amount" label="Statement amount (LKR)" type="number" min="0" step="0.01"/><Field name="minimumDue" label="Minimum due (LKR)" type="number" min="0" step="0.01" defaultValue="0"/><Field name="periodFrom" label="Period from" type="date" required={false}/><Field name="periodTo" label="Period to" type="date" required={false}/><Field name="reminderDays" label="Remind before (optional override)" type="number" min="0" max="90" required={false}/></FormModal>}
function CardPayment({statement,close,reload}){return <FormModal title={`Pay ${statement.card} statement`} close={close} label="Record payment" onSubmit={async v=>{await post(`/finance/credit-card-statements/${statement.id}/payments`,{amount:Number(v.amount),paidDate:v.paidDate,method:v.method,reference:v.reference||undefined});await reload();}}><Field name="amount" label="Payment amount (LKR)" type="number" min="0" step="0.01" defaultValue={Number(statement.amount)-Number(statement.paidAmount)}/><Field name="paidDate" label="Paid on" type="date" defaultValue={todayInput()}/><SelectField name="method" label="Method" options={['Bank transfer','Cheque','Cash']}/><Field name="reference" label="Payment reference" required={false}/></FormModal>}

function VatLedger({companyId}){const [vat,setVat]=useState(null);const load=()=>api(`/finance/vat?companyId=${companyId}`).then(setVat).catch(()=>setVat(null));useLiveList(load);useEffect(()=>{load();},[companyId]);if(!vat)return <p className="empty-state">Loading VAT ledger…</p>;return <><div className="attendance-summary"><Summary label="Output VAT collected" value={rupees(vat.outputVat)} icon={TrendingUp}/><Summary label="Input VAT paid" value={rupees(vat.inputVat)} icon={CircleDollarSign}/><Summary label="Net VAT payable" value={rupees(vat.netVatPayable)} icon={Wallet}/></div><Table columns={['Date','Direction','Invoice / bill','Counterparty','Net amount','VAT','Total']} template="120px 100px 150px minmax(180px,1.3fr) 130px 130px 130px" title="VAT calculated automatically from paid invoices and bills" empty="No paid VAT-bearing documents.">{vat.entries.map((r,i)=><Row template="120px 100px 150px minmax(180px,1.3fr) 130px 130px 130px" key={`${r.direction}-${r.reference}-${i}`}><span>{shortDate(r.date)}</span><Badge tone={r.direction==='Output'?'active':'pending'}>{r.direction}</Badge><strong>{r.reference}</strong><span>{r.counterparty}</span><span>{rupees(r.netAmount)}</span><strong>{rupees(r.vatAmount)}</strong><span>{rupees(r.totalAmount)}</span></Row>)}</Table></>}

const BUDGET_COLUMNS = ['Project', 'Approved budget', 'Recorded cost', 'Variance', 'Used', 'Income', 'Margin'];
const BUDGET_TEMPLATE = 'minmax(170px,1.3fr) 140px 140px 140px 130px 140px 140px';

function BudgetMonitoring({ summary }) {
  if (!summary) return <p className="empty-state">Loading financial position…</p>;
  return <>
    <div className="attendance-summary">
      <Summary label="Approved budget" value={rupees(summary.totals.budget)} icon={Wallet} />
      <Summary label="Recorded cost" value={rupees(summary.totals.expenses)} icon={CircleDollarSign} />
      <Summary label="Income received" value={rupees(summary.totals.income)} icon={TrendingUp} />
      <Summary label="Payable to suppliers" value={rupees(summary.payable.outstanding)} icon={Wallet} />
    </div>
    <Table columns={BUDGET_COLUMNS} template={BUDGET_TEMPLATE} title="Budget against actual cost">
      {summary.projects.map(project => <Row template={BUDGET_TEMPLATE} key={project.projectId}>
        <strong>{project.project}</strong>
        <span>{rupees(project.budget)}</span>
        <span>{rupees(project.expenses)}</span>
        <span className={project.variance < 0 ? 'overdue' : ''}>{rupees(project.variance)}</span>
        <div><b>{project.used.toFixed(1)}%</b><Progress value={project.used} /></div>
        <span>{rupees(project.income)}</span>
        <span className={project.profit < 0 ? 'overdue' : ''}>{rupees(project.profit)}</span>
      </Row>)}
    </Table>
    <div style={{ height: '14px' }} />
    <Table columns={['Cost category', 'Total recorded']} template="minmax(200px,1fr) 200px" title="Spend by category"
      empty="No costs recorded yet.">
      {summary.bySource.map(row => <Row template="minmax(200px,1fr) 200px" key={row.source}>
        <Badge tone={slug(row.source)}>{row.source}</Badge>
        <strong>{rupees(row.total)}</strong>
      </Row>)}
    </Table>
  </>;
}

const LEDGER_TEMPLATE = '120px minmax(200px,1.6fr) minmax(150px,1fr) 130px 130px minmax(130px,1fr)';

function Expenses({ companyId }) {
  const [rows, setRows] = useState([]);
  useLiveList(() => api(`/finance/expenses?companyId=${companyId}`).then(setRows).catch(() => setRows([])));
  useEffect(() => { api(`/finance/expenses?companyId=${companyId}`).then(setRows).catch(() => setRows([])); }, [companyId]);
  return <Table columns={['Date', 'Description', 'Project', 'Category', 'Amount', 'Recorded by']} template={LEDGER_TEMPLATE}
    title="Project expenses" empty="No expenses recorded.">
    {rows.map(row => <Row template={LEDGER_TEMPLATE} key={row.id}>
      <span>{shortDate(row.expenseDate)}</span>
      <div><strong>{row.description}</strong><small>{row.originType ? 'Posted automatically' : row.reference || 'Manual entry'}</small></div>
      <span>{row.project}</span>
      <Badge tone={slug(row.source)}>{row.source}</Badge>
      <strong>{rupees(row.amount)}</strong>
      <span>{row.recordedBy}</span>
    </Row>)}
  </Table>;
}

function Income({ companyId }) {
  const [rows, setRows] = useState([]);
  useLiveList(() => api(`/finance/income?companyId=${companyId}`).then(setRows).catch(() => setRows([])));
  useEffect(() => { api(`/finance/income?companyId=${companyId}`).then(setRows).catch(() => setRows([])); }, [companyId]);
  return <Table columns={['Date', 'Description', 'Project', 'Method', 'Amount', 'Recorded by']} template={LEDGER_TEMPLATE}
    title="Income received" empty="No income recorded.">
    {rows.map(row => <Row template={LEDGER_TEMPLATE} key={row.id}>
      <span>{shortDate(row.receivedDate)}</span>
      <div><strong>{row.description}</strong><small>{row.reference || '—'}</small></div>
      <span>{row.project}</span>
      <span>{row.method}</span>
      <strong>{rupees(row.amount)}</strong>
      <span>{row.recordedBy}</span>
    </Row>)}
  </Table>;
}

const INVOICE_COLUMNS = ['Invoice','Supplier','Order','Due date','Net / VAT','Total','Outstanding','Status',''];
const INVOICE_TEMPLATE = 'minmax(130px,1fr) minmax(160px,1.2fr) 130px 120px 140px 125px 130px 120px 110px';

function Invoices({ can, refresh, companyId }) {
  const [rows, setRows] = useState([]);
  const [paying, setPaying] = useState(null);
  const load = () => api(`/purchasing/invoices?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);

  return <>
    <Table columns={INVOICE_COLUMNS} template={INVOICE_TEMPLATE} title="Supplier invoices" empty="No invoices recorded.">
      {rows.map(row => <Row template={INVOICE_TEMPLATE} key={row.id}>
        <strong>{row.invoiceNo}</strong>
        <span>{row.supplier}</span>
        <span>{row.orderReference || '—'}</span>
        <span className={row.dueDate && new Date(row.dueDate) < new Date() && row.status !== 'Paid' ? 'overdue' : ''}>{shortDate(row.dueDate)}</span>
        <div><span>{rupees(row.netAmount)}</span><small>VAT {rupees(row.vatAmount)}</small></div><span>{rupees(row.amount)}</span>
        <strong>{rupees(Number(row.amount) - Number(row.paidAmount))}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.finance && row.status !== 'Paid'
          ? <button className="status-button" onClick={() => setPaying(row)}>Pay</button>
          : <span>—</span>}
      </Row>)}
    </Table>
    {paying && <PaymentForm invoice={paying} close={() => setPaying(null)}
      reload={async () => { await load(); await refresh(); }} />}
  </>;
}

/** Expense categories used when coding costs (PID 2.10). */
function Categories({ companyId }) {
  const [rows, setRows] = useState([]);
  const [expenses, setExpenses] = useState([]);
  useLiveList(() => {
    api('/finance/categories').then(setRows).catch(() => setRows([]));
    api(`/finance/expenses?companyId=${companyId}`).then(setExpenses).catch(() => setExpenses([]));
  });
  useEffect(() => { api(`/finance/expenses?companyId=${companyId}`).then(setExpenses).catch(() => setExpenses([])); }, [companyId]);
  const template = 'minmax(200px,1.4fr) 140px 180px';
  return <Table columns={['Category', 'Entries', 'Total recorded']} template={template} title="Expense categories"
    empty="No categories defined.">
    {rows.map(row => {
      const matching = expenses.filter(expense => expense.category === row.name);
      return <Row template={template} key={row.id}>
        <strong>{row.name}</strong>
        <span>{matching.length}</span>
        <span>{rupees(matching.reduce((sum, expense) => sum + Number(expense.amount), 0))}</span>
      </Row>;
    })}
  </Table>;
}

function CategoryForm({ close, reload }) {
  return <FormModal title="Add expense category" close={close} label="Add category" onSubmit={async values => {
    await post('/finance/categories', { name: values.name });
    await reload();
  }}>
    <Field name="name" label="Category name" wide placeholder="Site overheads, plant hire" />
  </FormModal>;
}

function ExpenseForm({ data, close, reload }) {
  const costTypes = useOptions('expense.source');
  const [categories, setCategories] = useState([]);
  useEffect(() => { api('/finance/categories').then(setCategories).catch(() => setCategories([])); }, []);
  return <FormModal title="Record expense" close={close} label="Save expense" onSubmit={async values => {
    await post('/finance/expenses', {
      projectId: Number(values.projectId),
      categoryId: values.categoryId ? Number(values.categoryId) : undefined,
      source: values.source,
      description: values.description,
      amount: Number(values.amount),
      expenseDate: values.expenseDate,
      reference: values.reference || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="source" label="Cost type" options={costTypes} />
    <SelectField name="categoryId" label="Category" options={[['', 'Uncategorised'], ...categories.map(category => [category.id, category.name])]} />
    <Field name="amount" label="Total cost (LKR)" type="number" step="0.01" min="0.01" />
    <Field name="expenseDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="description" label="Description" wide />
    <p className="invoice-note">Use Bills or Supplier invoices for VAT-bearing documents, Fleet for fuel and repairs, Materials for site issues, and QS for BOQ-linked costs. These all feed the same project ledger.</p>
  </FormModal>;
}

function IncomeForm({ data, close, reload }) {
  const payMethods = useOptions('income.method');
  return <FormModal title="Record income" close={close} label="Save income" onSubmit={async values => {
    await post('/finance/income', {
      projectId: Number(values.projectId),
      description: values.description,
      amount: Number(values.amount),
      receivedDate: values.receivedDate,
      method: values.method,
      reference: values.reference || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="receivedDate" label="Received on" type="date" defaultValue={todayInput()} />
    <SelectField name="method" label="Method" options={payMethods.filter(method => method !== 'Cheque')} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="description" label="Description" wide />
    <p className="invoice-note">Use Received cheques for cheques and Invoices for client payments. Those workflows post income automatically.</p>
  </FormModal>;
}

function InvoiceForm({ companyId, close, reload }) {
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api('/purchasing/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    api(`/purchasing/orders?companyId=${companyId}`).then(setOrders).catch(() => setOrders([]));
  }, [companyId]);
  return <FormModal title="Record supplier invoice" close={close} label="Save invoice" onSubmit={async values => {
    await post('/purchasing/invoices', {
      companyId,
      supplierId: Number(values.supplierId),
      orderId: values.orderId ? Number(values.orderId) : undefined,
      invoiceNo: values.invoiceNo,
      amount: Number(values.amount),
      invoiceDate: values.invoiceDate,
      dueDate: values.dueDate || undefined
    });
    await reload();
  }}>
    <SelectField name="supplierId" label="Supplier" options={suppliers.map(supplier => [supplier.id, supplier.name])} />
    <SelectField name="orderId" label="Against order" options={[['', 'No order'], ...orders.map(order => [order.id, `${order.reference} — ${order.supplier}`])]} />
    <Field name="invoiceNo" label="Invoice number" />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="invoiceDate" label="Invoice date" type="date" defaultValue={todayInput()} />
    <Field name="dueDate" label="Payment due" type="date" defaultValue={todayInput()} required={false} />
  </FormModal>;
}

function PaymentForm({ invoice, close, reload }) {
  const payMethods = useOptions('income.method');
  const outstanding = Number(invoice.amount) - Number(invoice.paidAmount);
  return <FormModal title={`Pay ${invoice.invoiceNo}`} close={close} label="Record payment" onSubmit={async values => {
    await post(`/purchasing/invoices/${invoice.id}/payments`, {
      amount: Number(values.amount),
      paidDate: values.paidDate,
      method: values.method,
      reference: values.reference || undefined
    });
    await reload();
  }}>
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="any" min="0" defaultValue={outstanding} />
    <Field name="paidDate" label="Paid on" type="date" defaultValue={todayInput()} />
    <SelectField name="method" label="Method" options={payMethods.filter(method => method !== 'Cheque')} />
    <Field name="reference" label="Reference" required={false} />
    <p className="invoice-note">Use Issued cheques for cheque payments; clearing the cheque will update this invoice.</p>
  </FormModal>;
}
