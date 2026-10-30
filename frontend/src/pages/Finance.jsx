import React, { useEffect, useState } from 'react';
import { CircleDollarSign, TrendingUp, Wallet } from 'lucide-react';
import { api, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Page, Progress, Row, SelectField, Summary, Table, Tabs, useLiveList } from '../ui.jsx';
import { useOptions } from '../options.js';
import { Bonds, ClientInvoices, PettyCash } from '../Receivables.jsx';
import FinanceReports from './FinanceReports.jsx';
import ManagementAccounts from './ManagementAccounts.jsx';
import DailyExpenses from './DailyExpenses.jsx';
import ExpectedOutflows from './ExpectedOutflows.jsx';
import CashComparison from './CashComparison.jsx';
import Cheques from './Cheques.jsx';
import SupplierStatements from './SupplierStatements.jsx';
import VatClearance from './VatClearance.jsx';
import VehicleExpenseReport from './VehicleExpenseReport.jsx';
import VatSchedules from './VatSchedules.jsx';
import ProgressClaims from './ProgressClaims.jsx';
import { DailySheetDetail } from './CostControl.jsx';
import { RecordScopeProvider } from '../record-scope.jsx';

const TABS = ['Financial reports','Management accounts','Cash comparison','Vehicle expenses','Expected outflows','Invoices','Progress claims','Daily cost review','Budget monitoring','Bills','Credit cards','VAT ledger','VAT clearance','Cheques','Bonds','Petty cash','Expenses','Income','Credit purchases','Supplier invoices','Supplier statements','Categories'];
const TAB_PERMISSIONS = {
  'Progress claims':['finance.view','finance.invoice'],
  'Financial reports':['finance.reports'], 'Management accounts':['finance.managementAccounts'],
  'Cash comparison':['finance.cashComparison'], 'Daily expenses':['finance.dailyExpenses'],
  'Vehicle expenses':['finance.vehicleExpenses'], 'Expected outflows':['finance.expectedOutflows'],
  'VAT ledger':['finance.vatSchedules'], 'VAT clearance':['finance.vatClearance'],
  'Supplier statements':['finance.supplierStatements'], 'Daily cost review':['finance.costReview'],
  'Budget monitoring':['finance.view'], Invoices:['finance.invoice'], Cheques:['finance.invoice'],
  Bonds:['finance.invoice'], 'Petty cash':['finance.manage'], Bills:['finance.manage'],
  'Credit cards':['finance.manage'], Expenses:['finance.manage','finance.dailyExpenses'], Income:['finance.manage'],
  'Supplier invoices':['finance.pay'], 'Credit purchases':['finance.pay'], Categories:['finance.manage']
};
const TAB_GROUPS = [
  { label: 'Overview & review', tabs: ['Financial reports', 'Management accounts', 'Cash comparison', 'Vehicle expenses', 'Daily cost review', 'Budget monitoring'] },
  { label: 'Money in', tabs: ['Invoices', 'Progress claims', 'Income', 'VAT ledger'] },
  { label: 'Money out', tabs: ['Expected outflows', 'Bills', 'Credit purchases', 'Supplier invoices', 'Supplier statements', 'Expenses', 'Petty cash', 'Credit cards'] },
  { label: 'Controls', tabs: ['VAT clearance', 'Cheques', 'Bonds', 'Categories'] }
];

/** PID 2.10 — costs, payments and profitability in one view, watched continuously. */
export default function Finance({ data, reload, can, companyId, company }) {
  const [tab, setTab] = useState(() => window.location.pathname.split('/')[2] === 'daily-expenses' ? 'Expenses' : TABS.find(section => slug(section) === window.location.pathname.split('/')[2]) || TABS[0]);
  const [open, setOpen] = useState('');
  const [summary, setSummary] = useState(null);
  const visibleTabs = TABS.filter(name => (TAB_PERMISSIONS[name] || []).some(key => can.has(key)));
  const visibleGroups = TAB_GROUPS.map(group => ({...group, tabs:group.tabs.filter(name => visibleTabs.includes(name))})).filter(group => group.tabs.length);
  const featureCan = permission => ({...can, finance:can.has(permission)});

  const load = () => api(`/finance/summary?companyId=${companyId}`).then(setSummary).catch(() => setSummary(null));
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);
  useEffect(() => { if (!visibleTabs.includes(tab) && visibleTabs.length) setTab(visibleTabs[0]); }, [tab, visibleTabs.join('|')]);

  const actions = {
    'Financial reports': null,
    'Management accounts': null,
    'Cash comparison': null,
    'Daily expenses': null,
    'Vehicle expenses': null,
    'Expected outflows': null,
    'Budget monitoring': null,
    'Daily cost review': null,
    Bills: can.finance&&'Record bill',
    'Credit cards': null,
    'VAT ledger': null,
    'VAT clearance': null,
    Invoices: null,
    Cheques: null,
    Bonds: null,
    'Petty cash': null,
    Expenses: can.finance && 'Record expense',
    Income: can.finance && 'Record income',
    'Supplier invoices': can.supplierPay && 'Record invoice',
    'Credit purchases': can.supplierPay && 'Record credit purchase',
    'Supplier statements': null,
    Categories: can.finance && 'Add category'
  };

  const refresh = async () => { await load(); await reload(); };

  return <RecordScopeProvider scope={{ kind: 'company', name: company?.name || 'the selected company', id: companyId }}><Page title="Finance" subtitle={`Project costs, payments and profitability for ${company?.name || 'the selected company'}.`}
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={visibleTabs} active={tab} onChange={setTab} groups={visibleGroups} />

    {tab === 'Financial reports' && <FinanceReports projects={data.projects} companyId={companyId} company={company} />}
    {tab === 'Management accounts' && <ManagementAccounts projects={data.projects.filter(project => Number(project.companyId) === Number(companyId))} companyId={companyId} company={company} can={featureCan('finance.managementAccountsManage')} />}
    {tab === 'Cash comparison' && <CashComparison companyId={companyId} company={company} can={featureCan('finance.cashComparison')} />}
    {tab === 'Vehicle expenses' && <VehicleExpenseReport key={companyId} companyId={companyId} company={company} data={data} can={can} />}
    {tab === 'Expected outflows' && <ExpectedOutflows companyId={companyId} company={company} can={featureCan('finance.expectedOutflows')} projects={data.projects} />}
    {tab === 'Budget monitoring' && <BudgetMonitoring summary={summary} />}
    {tab === 'Daily cost review' && <DailyCostReview companyId={companyId} can={can} />}
    {tab === 'Bills' && <Bills data={data} can={can} companyId={companyId} open={open==='Bills'} close={()=>setOpen('')} />}
    {tab === 'Credit cards' && <CreditCards can={can} companyId={companyId} />}
    {tab === 'VAT ledger' && <VatSchedules companyId={companyId} company={company} can={featureCan('finance.vatSchedules')} />}
    {tab === 'VAT clearance' && <VatClearance companyId={companyId} company={company} can={featureCan('finance.vatClearance')} />}
    {tab === 'Invoices' && <ClientInvoices data={data} can={can} companyId={companyId} />}
    {tab === 'Cheques' && <Cheques can={can} data={data} companyId={companyId} />}
    {tab === 'Bonds' && <Bonds data={data} can={can} companyId={companyId} />}
    {tab === 'Petty cash' && <PettyCash data={data} can={can} companyId={companyId} />}
    {tab === 'Expenses' && <div className="expenses-workspace">
      {can.has('finance.dailyExpenses') && <DailyExpenses companyId={companyId} company={company} can={featureCan('finance.dailyExpenses')} />}
      {can.has('finance.manage') && <section className="expenses-ledger-section" aria-label="Project expense ledger">
        <h2>Project expense ledger</h2>
        <p>Recorded project costs, including unpaid expenses. Recording payment details updates the existing expense without creating another cost.</p>
        <Expenses companyId={companyId} can={can} />
      </section>}
    </div>}
    {tab === 'Income' && <Income companyId={companyId} />}
    {tab === 'Progress claims' && <ProgressClaims companyId={companyId} can={can}/>}
    {tab === 'Supplier invoices' && <Invoices key="invoices" can={can} refresh={refresh} companyId={companyId} />}
    {tab === 'Credit purchases' && <Invoices key="credit" creditOnly can={can} refresh={refresh} companyId={companyId} />}
    {tab === 'Supplier statements' && <SupplierStatements companyId={companyId} />}
    {tab === 'Categories' && <Categories companyId={companyId} />}

    {open === 'Expenses' && <ExpenseForm data={data} close={() => setOpen('')} reload={refresh} />}
    {open === 'Income' && <IncomeForm data={data} companyId={companyId} close={() => setOpen('')} reload={refresh} />}
    {open === 'Supplier invoices' && <InvoiceForm companyId={companyId} close={() => setOpen('')} reload={refresh} />}
    {open === 'Credit purchases' && <InvoiceForm creditOnly companyId={companyId} close={() => setOpen('')} reload={refresh} />}
    {open === 'Categories' && <CategoryForm close={() => setOpen('')} reload={refresh} />}
  </Page></RecordScopeProvider>;
}

function DailyCostReview({ companyId, can }) {
  const [rows,setRows]=useState([]),[selected,setSelected]=useState(() => Number(new URLSearchParams(window.location.search).get('record')) || null),[error,setError]=useState('');
  const load=()=>api(`/boq/cost-control/review-queue?companyId=${companyId}`).then(setRows).catch(failure=>setError(failure.message));
  useEffect(()=>{setRows([]);setError('');load();},[companyId]);
  const template='120px minmax(160px,1.3fr) 120px 70px 130px 130px 115px 90px';
  return <>{error && <p className="form-error">{error}</p>}<div className="attendance-summary"><Summary label="Awaiting review" value={rows.filter(row=>row.status==='Submitted').length} icon={Wallet}/><Summary label="Approved sheets" value={rows.filter(row=>row.status==='Approved').length} icon={CircleDollarSign}/></div>
    <Table title="QS daily cost submissions" columns={['Date','Project','Submitted by','Lines','Site cost','Quoted recovery','Status','']} template={template} empty="No daily cost sheets await review for this company. QS must submit a sheet for a completed project task before Finance can review it." emptyAction={can.costControl ? () => window.location.assign('/quantity-surveying/cost-control') : undefined} emptyActionLabel="Open QS cost control">{rows.map(row=><Row template={template} key={row.id}><span>{shortDate(row.workDate)}</span><strong>{row.project}</strong><span>{row.submittedBy}</span><span>{row.lineCount}</span><strong>{rupees(row.totalCost)}</strong><span>{rupees(row.quotedRecovery)}</span><Badge tone={row.status==='Approved'?'on-track':row.status==='Returned'?'at-risk':'watch'}>{row.status}</Badge><button className="status-button" onClick={()=>setSelected(row.id)}>{can.costReview&&row.status==='Submitted'?'Review':'View'}</button></Row>)}</Table>
    {selected && <DailySheetDetail id={selected} close={()=>setSelected(null)} review={can.costReview} reload={load} />}
  </>;
}

function Bills({data,can,companyId,open,close}){
  const [rows,setRows]=useState([]),[paying,setPaying]=useState(null);
  const load=()=>api(`/finance/bills?companyId=${companyId}`).then(setRows).catch(()=>setRows([]));useLiveList(load);useEffect(()=>{load();},[companyId]);
  const template='130px minmax(180px,1.4fr) minmax(140px,1fr) 120px 130px 120px 110px';
  return <><div className="attendance-summary"><Summary label="Unpaid bills" value={rows.filter(r=>r.status==='Unpaid').length} icon={Wallet}/>
    <Summary label="Due within 5 days" value={rows.filter(r=>r.status==='Unpaid'&&r.daysUntil>=0&&r.daysUntil<=5).length} icon={CircleDollarSign}/>
    <Summary label="Overdue" value={rows.filter(r=>r.status==='Unpaid'&&r.daysUntil<0).length} icon={TrendingUp}/></div>
    <Table columns={['Type','Provider / reference','Project','Due','Total','Status','']} template={template} title="Electricity, water and operating bills" empty="No operating bills for this company yet. Record a bill when the provider's statement is received." emptyAction={can.finance ? () => document.querySelector('.page-heading .primary')?.click() : undefined} emptyActionLabel="Record a bill">
      {rows.map(r=><Row template={template} key={r.id}><Badge tone={slug(r.billType)}>{r.billType}</Badge><div><strong>{r.provider}</strong><small>{r.reference}</small></div>
        <span>{r.project||'Company office'}</span><span className={r.status==='Unpaid'&&r.daysUntil<0?'overdue':''}>{shortDate(r.dueDate)}</span><strong>{rupees(r.totalAmount)}</strong>
        <Badge tone={slug(r.status)}>{r.status}</Badge>{can.finance&&r.status==='Unpaid'?<button className="status-button" onClick={()=>setPaying(r)}>Pay</button>:<span>—</span>}</Row>)}</Table>
    {open&&<BillForm data={data} companyId={companyId} close={close} reload={load}/>} {paying&&<BillPayment bill={paying} close={()=>setPaying(null)} reload={load}/>}</>;
}

function BillForm({data,companyId,close,reload}){return <FormModal title="Record an operating bill" close={close} label="Save bill" repeat onSubmit={async v=>{
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

function Expenses({ companyId, can }) {
  const [rows, setRows] = useState([]);
  const [paying,setPaying]=useState(null);
  const load=()=>api(`/finance/expenses?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) document.getElementById(`finance-expense-${id}`)?.scrollIntoView({ block: 'center' }); }, [rows]);
  return <><Table columns={['Date', 'Description', 'Project', 'Category', 'Amount', 'Recorded by']} template={LEDGER_TEMPLATE}
    title="Project expenses" empty="No expenses recorded.">
    {rows.map(row => <Row template={LEDGER_TEMPLATE} key={row.id} id={`finance-expense-${row.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(row.id) ? 'report-source-highlight' : ''}>
      <span>{shortDate(row.expenseDate)}</span>
      <div><strong>{row.description}</strong><small>{row.originType ? 'Posted automatically from the source record · do not enter again' : row.reference || 'Manual entry'}</small>
        {!row.originType && <small>{row.paymentMethod ? `Paid to ${row.payee || 'payee not recorded'} by ${row.paymentMethod} on ${shortDate(row.paidDate)}` : 'Payment details not recorded — excluded from the paid daily register'}</small>}
        {row.originType === 'fuel_record' && <small>Also visible in <a href={`/fleet?section=fuel&record=${row.originId}`}>Fleet fuel record #{row.originId}</a> and Finance petty cash.</small>}
        {row.originType === 'daily_cost_line' && row.dailySheetId && <small>Also visible in <a href={`/quantity-surveying/cost-control?project=${row.projectId}&record=${row.dailySheetId}`}>QS daily cost sheet #{row.dailySheetId}</a>.</small>}
        {row.originType === 'stock_movement' && <small>Also visible in <a href="/materials">Materials stock movements</a>. This cost was posted when stock was issued to the site.</small>}</div>
      <span>{row.project}</span>
      <Badge tone={slug(row.source)}>{row.source}</Badge>
      <strong>{rupees(row.amount)}</strong>
      <span>{row.recordedBy}{can.finance && !row.originType && !row.paymentMethod && <button type="button" className="status-button" onClick={()=>setPaying(row)}>Record payment</button>}</span>
    </Row>)}
  </Table>{paying && <FormModal title={`Record payment for ${paying.description}`} label="Save payment details" close={()=>setPaying(null)} onSubmit={async values=>{await patch(`/finance/expenses/${paying.id}/payment`,{payee:values.payee,paymentMethod:values.paymentMethod,paidDate:values.paidDate,reference:values.reference||undefined});await load();}}><p>This confirms how the existing expense was paid. It does not create another expense.</p><Field name="payee" label="Paid to" /><SelectField name="paymentMethod" label="Payment method" options={['Bank transfer','Card','Cash','Cheque']} /><Field name="paidDate" label="Date paid" type="date" defaultValue={todayInput()} /><Field name="reference" label="Payment reference" required={false} /></FormModal>}</>;
}

function Income({ companyId }) {
  const [rows, setRows] = useState([]);
  useLiveList(() => api(`/finance/income?companyId=${companyId}`).then(setRows).catch(() => setRows([])));
  useEffect(() => { api(`/finance/income?companyId=${companyId}`).then(setRows).catch(() => setRows([])); }, [companyId]);
  return <Table columns={['Date', 'Description', 'Project', 'Method', 'Amount', 'Recorded by']} template={LEDGER_TEMPLATE}
    title="Income received" empty="No income recorded.">
    {rows.map(row => <Row template={LEDGER_TEMPLATE} key={row.id}>
      <span>{shortDate(row.receivedDate)}</span>
      <div><strong>{row.description}</strong><small>{row.reference || '—'}</small>
        {row.incomeSource&&<small>Income source: {row.incomeSource}</small>}
        {!row.invoiceId&&<small>{row.taxTreatment==='Standard'?`VAT ${row.vatRate}%: ${rupees(row.vatAmount)}`:'Excluded from VAT and other tax calculations'}</small>}
        {row.invoiceId&&<small>Also visible in <a href={`/finance/invoices?record=${row.invoiceId}`}>invoice payments and receipts</a>. This income was posted from that receipt.</small>}
        {row.originType==='received_cheque'&&<small>Also visible in <a href="/finance/cheques">received cheques</a>. This income was posted when the cheque cleared.</small>}
      </div>
      <span>{row.project}</span>
      <span>{row.method}</span>
      <strong>{rupees(row.amount)}</strong>
      <span>{row.recordedBy}</span>
    </Row>)}
  </Table>;
}

const INVOICE_COLUMNS = ['Invoice','Supplier','Order','Due date','Net / VAT','Total','Outstanding','Status',''];
const INVOICE_TEMPLATE = 'minmax(130px,1fr) minmax(160px,1.2fr) 130px 120px 140px 125px 130px 120px 110px';

function Invoices({ can, refresh, companyId, creditOnly=false }) {
  const [rows, setRows] = useState([]);
  const [paying, setPaying] = useState(null);
  const [error, setError] = useState('');
  const load = () => api(`/purchasing/invoices?companyId=${companyId}`).then(result=>setRows(result.filter(row=>creditOnly?Boolean(row.creditDescription):!row.creditDescription))).catch(failure => {setRows([]);setError(failure.message);});
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);

  const approveException = async row => {
    const reason = window.prompt(`This supplier invoice has no purchase order or goods receipt. Explain why payment may proceed for ${row.invoiceNo}:`);
    if (!reason) return;
    try {
      await post(`/purchasing/invoices/${row.id}/payment-exception`, { reason: reason.trim() });
      setError(''); await load();
    } catch (failure) { setError(failure.message); }
  };
  const verifyInvoice = async row => {
    try {
      await post(`/purchasing/invoices/${row.id}/verify`, {});
      setError(''); await load(); await refresh();
    } catch (failure) { setError(failure.message); }
  };
  const template = creditOnly ? 'minmax(170px,1.4fr) 130px 120px 140px 125px 130px 120px 110px' : INVOICE_TEMPLATE;
  const columns = creditOnly ? INVOICE_COLUMNS.filter(column => column !== 'Supplier') : INVOICE_COLUMNS;
  const supplierGroups = new Map();
  if (creditOnly) for (const row of rows) {
    const key = row.supplierId != null ? `supplier-${row.supplierId}` : `name-${row.supplier || ''}`;
    if (!supplierGroups.has(key)) supplierGroups.set(key, { key, name: row.supplier || 'Unknown supplier', rows: [] });
    supplierGroups.get(key).rows.push(row);
  }
  const groups = creditOnly && rows.length
    ? [...supplierGroups.values()].sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    : [{ key: 'all', name: creditOnly ? 'Credit purchases' : 'Supplier invoices', rows }];
  const renderInvoice = row => <Row template={template} key={row.id}>
        <div><strong>{row.invoiceNo}</strong>{row.creditDescription&&<small>Credit · {row.creditDescription} · {row.reminderFrequency} reminders</small>}</div>
        {!creditOnly && <span>{row.supplier}</span>}
        <span>{row.orderReference || '—'}</span>
        <span className={row.dueDate && new Date(row.dueDate) < new Date() && row.status !== 'Paid' ? 'overdue' : ''}>{shortDate(row.dueDate)}</span>
        <div><span>{rupees(row.netAmount)}</span><small>VAT {rupees(row.vatAmount)}</small></div><span>{rupees(row.amount)}</span>
        <strong>{rupees(Number(row.amount) - Number(row.paidAmount))}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {row.orderReference && !row.verifiedAt && can.supplierPay
          ? <button className="status-button" onClick={() => verifyInvoice(row)}>Verify match</button>
          : row.status !== 'Paid' && !row.orderReference && !row.paymentExceptionApprovedBy && can.finance
          ? <button className="status-button" onClick={() => approveException(row)}>Review exception</button>
          : row.status !== 'Paid' && can.supplierPay && (row.orderReference || row.paymentExceptionApprovedBy)
            ? <button className="status-button" onClick={() => setPaying(row)}>Pay</button>
          : <span>—</span>}
      </Row>;
  return <>
    {error && <p className="form-error">{error}</p>}
    <div className="supplier-credit-groups">
      {groups.map(group => <Table key={group.key} columns={columns} template={template} title={group.name}
        tools={creditOnly && group.rows.length ? <div className="supplier-credit-summary"><span>{group.rows.length} {group.rows.length === 1 ? 'purchase' : 'purchases'}</span><strong>Outstanding {rupees(group.rows.reduce((sum,row) => sum + Number(row.amount) - Number(row.paidAmount),0))}</strong></div> : null}
        empty={creditOnly ? 'No credit purchases recorded.' : 'No invoices recorded.'}>
        {group.rows.map(renderInvoice)}
      </Table>)}
    </div>
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
  return <FormModal title="Add expense category" close={close} label="Add category" repeat onSubmit={async values => {
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
  return <FormModal title="Record expense" close={close} label="Save expense" repeat onSubmit={async values => {
    await post('/finance/expenses', {
      projectId: Number(values.projectId),
      categoryId: values.categoryId ? Number(values.categoryId) : undefined,
      source: values.source,
      description: values.description,
      amount: Number(values.amount),
      expenseDate: values.expenseDate,
      reference: values.reference || undefined,
      payee: values.payee || undefined,
      paymentMethod: values.paymentMethod || undefined,
      paidDate: values.paymentMethod ? (values.paidDate || values.expenseDate) : undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="source" label="Cost type" options={costTypes} />
    <SelectField name="categoryId" label="Category" options={[['', 'Uncategorised'], ...categories.map(category => [category.id, category.name])]} />
    <Field name="amount" label="Total cost (LKR)" type="number" step="0.01" min="0.01" />
    <Field name="expenseDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="payee" label="Paid to (for direct payments)" required={false} />
    <SelectField name="paymentMethod" label="Payment method (leave blank if unpaid)" required={false} options={[["",'Not paid / payment not recorded'],'Bank transfer','Card','Cash','Cheque']} />
    <Field name="paidDate" label="Payment date (if already paid)" type="date" required={false} />
    <Field name="description" label="Description" wide />
    <p className="invoice-note">Use Bills or Supplier invoices for VAT-bearing documents, Fleet for fuel and repairs, Materials for site issues, and QS for BOQ-linked costs. These all feed the same project ledger.</p>
  </FormModal>;
}

function IncomeForm({ data, companyId, close, reload }) {
  const payMethods = useOptions('income.method');
  const [method,setMethod]=useState('Cash');
  const [taxTreatment,setTaxTreatment]=useState('None');
  const [projectId,setProjectId]=useState('other');
  const cheque=method==='Cheque';
  return <FormModal title="Record income" close={close} label={cheque?'Record cheque':'Save income'} repeat={!cheque&&taxTreatment==='None'} onSubmit={async values => {
    if(values.method==='Cheque') {
      await post('/receivables/cheques',{companyId,projectId:values.projectId==='other'?null:Number(values.projectId),purpose:values.description,
        incomeSource:values.projectId==='other'?values.incomeSource:undefined,
        taxTreatment:values.taxTreatment,vatRate:values.taxTreatment==='Standard'?Number(values.vatRate):0,
        amount:Number(values.amount),receivedDate:values.receivedDate,chequeNumber:values.chequeNumber,
        bank:values.bank,payer:values.payer,chequeDate:values.chequeDate,depositBy:values.depositBy,
        reminderDays:2,notes:values.reference||undefined});
      await reload();
      return;
    }
    await post('/finance/income', {
      projectId: values.projectId==='other'?null:Number(values.projectId),companyId,
      incomeSource:values.projectId==='other'?values.incomeSource:undefined,
      taxTreatment:values.taxTreatment,vatRate:values.taxTreatment==='Standard'?Number(values.vatRate):0,
      description: values.description,
      amount: Number(values.amount),
      receivedDate: values.receivedDate,
      method: values.method,
      reference: values.reference || undefined
    });
    await reload();
    setProjectId('other');
  }}>
    <p className="form-note wide">Record invoice payments on the invoice. Cheques entered here are tracked in Received cheques and become income only after clearing.</p>
    <label>Project *<select name="projectId" required value={projectId} onChange={event=>setProjectId(event.target.value)}>
      <option value="other">Other (no project)</option>
      {data.projects.filter(project=>!project.companyId||Number(project.companyId)===Number(companyId)).map(project=><option value={project.id} key={project.id}>{project.name}</option>)}
    </select></label>
    {projectId==='other'&&<Field name="incomeSource" label="Income source"/>}
    <Field name="amount" label={taxTreatment==='Standard'?'Amount before VAT (LKR)':'Amount (LKR)'} type="number" step="any" min="0" />
    <Field name="receivedDate" label="Received on" type="date" defaultValue={todayInput()} />
    <label>VAT tracking *<select name="taxTreatment" required value={taxTreatment} onChange={event=>setTaxTreatment(event.target.value)}>
      <option value="None">Do not track VAT</option><option value="Standard">Calculate and track VAT</option>
    </select></label>
    {taxTreatment==='Standard'&&<>
      <Field name="vatRate" label="VAT rate (%)" type="number" min="0.001" max="100" step="0.001"/>
    </>}
    <label>Method *<select name="method" required value={method} onChange={event=>setMethod(event.target.value)}>
      {[...new Set(['Cash',...payMethods,'Cheque'])].map(value=><option key={value}>{value}</option>)}
    </select></label>
    {cheque&&<>
      <Field name="chequeNumber" label="Cheque number"/><Field name="bank" label="Drawer bank"/>
      <Field name="payer" label="Received from"/>
      <Field name="chequeDate" label="Cheque date" type="date" defaultValue={todayInput()}/>
      <Field name="depositBy" label="Deposit by" type="date" defaultValue={todayInput()}/>
    </>}
    <Field name="reference" label="Reference" required={false} />
    <Field name="description" label="Description" wide />
    {cheque&&<p className="invoice-note">The cheque will be saved as On hand, not cleared income. Manage deposit, clearing or return in Received cheques.</p>}
  </FormModal>;
}

function InvoiceForm({ companyId, close, reload, creditOnly=false }) {
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [credit,setCredit]=useState(creditOnly);
  const [users,setUsers]=useState([]);
  const [recipients,setRecipients]=useState([]);
  const [userError,setUserError]=useState('');
  useEffect(() => {
    api('/purchasing/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    api(`/purchasing/orders?companyId=${companyId}`).then(setOrders).catch(() => setOrders([]));
    api('/purchasing/credit-reminder-users').then(setUsers).catch(error=>setUserError(error.message));
  }, [companyId]);
  return <FormModal title={creditOnly?'Record credit purchase':'Record supplier invoice'} close={close} label={creditOnly?'Save credit purchase':'Save invoice'} onSubmit={async values => {
    const payload = {
      companyId,
      supplierId: Number(values.supplierId),
      orderId: values.orderId ? Number(values.orderId) : undefined,
      invoiceNo: values.invoiceNo,
      amount: Number(values.amount),
      invoiceDate: values.invoiceDate,
      dueDate: values.dueDate || undefined,
      creditReminder:credit?{description:values.creditDescription,startDate:values.reminderStart,
        frequency:values.reminderFrequency,userIds:recipients}:undefined
    };
    const check = await post('/purchasing/invoices/check', payload);
    if (check.warnings.length) {
      const reason = window.prompt(`Possible duplicate invoice:\n${check.warnings.map(item => `• ${item.message}`).join('\n')}\n\nExplain why this is a separate invoice:`);
      if (!reason || reason.trim().length < 10) throw new Error('Review the possible duplicate and enter a reason before saving.');
      payload.riskAccepted = true;
      payload.riskReason = reason.trim();
    }
    await post('/purchasing/invoices', payload);
    await reload();
  }}>
    <SelectField name="supplierId" label="Supplier" options={suppliers.map(supplier => [supplier.id, supplier.name])} />
    <SelectField name="orderId" label="Against order" required={false} options={[['', 'No order'], ...orders.map(order => [order.id, `${order.reference} — ${order.supplier}`])]} />
    <Field name="invoiceNo" label="Invoice number" />
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="invoiceDate" label="Invoice date" type="date" defaultValue={todayInput()} />
    <Field name="dueDate" label="Payment due" type="date" defaultValue={todayInput()} required={credit} />
    {!creditOnly&&<label className="wide"><input type="checkbox" checked={credit} onChange={event=>setCredit(event.target.checked)}/> Credit purchase with payment reminders</label>}
    {credit&&<>
      <Field name="creditDescription" label="Materials / items purchased" maxLength={500} wide />
      <Field name="reminderStart" label="First reminder" type="date" defaultValue={todayInput()}/>
      <SelectField name="reminderFrequency" label="Reminder frequency" options={['Once','Daily','Weekly','Monthly']}/>
      <fieldset className="wide"><legend>Remind users</legend>
        {userError&&<p className="form-error" role="alert">{userError}</p>}
        {users.map(user=><label key={user.id} style={{display:'block'}}><input type="checkbox" checked={recipients.includes(user.id)}
          onChange={event=>setRecipients(ids=>event.target.checked?[...ids,user.id]:ids.filter(id=>id!==user.id))}/>{user.name} · {user.role}</label>)}
      </fieldset>
    </>}
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
      reference: values.reference || undefined,
      bankChangeAcknowledged: Boolean(values.bankChangeReason?.trim()),
      bankChangeReason: values.bankChangeReason || undefined
    });
    await reload();
  }}>
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="any" min="0" defaultValue={outstanding} />
    <Field name="paidDate" label="Paid on" type="date" defaultValue={todayInput()} />
    <SelectField name="method" label="Method" options={payMethods.filter(method => method !== 'Cheque')} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="bankChangeReason" label="If the supplier changed bank details recently, how were they independently verified?" required={false} wide />
    <p className="invoice-note">Use Issued cheques for cheque payments; clearing the cheque will update this invoice.</p>
  </FormModal>;
}
