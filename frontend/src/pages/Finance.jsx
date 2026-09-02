import React, { useEffect, useState } from 'react';
import { CircleDollarSign, TrendingUp, Wallet } from 'lucide-react';
import { api, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Page, Progress, Row, SelectField, Summary, Table, Tabs, useLiveList } from '../ui.jsx';
import { useOptions } from '../options.js';
import { Bonds, ClientInvoices, PettyCash } from '../Receivables.jsx';

const TABS = ['Budget monitoring', 'Client invoices', 'Bonds', 'Petty cash', 'Expenses', 'Income', 'Supplier invoices', 'Categories'];

/** PID 2.10 — costs, payments and profitability in one view, watched continuously. */
export default function Finance({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');
  const [summary, setSummary] = useState(null);

  const load = () => api('/finance/summary').then(setSummary).catch(() => setSummary(null));
  useLiveList(load);

  const actions = {
    'Budget monitoring': null,
    'Client invoices': null,
    Bonds: null,
    'Petty cash': null,
    Expenses: can.finance && 'Record expense',
    Income: can.finance && 'Record income',
    'Supplier invoices': can.finance && 'Record invoice',
    Categories: can.finance && 'Add category'
  };

  const refresh = async () => { await load(); await reload(); };

  return <Page title="Finance" subtitle="Project costs, payments and profitability against the approved budget."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Budget monitoring' && <BudgetMonitoring summary={summary} />}
    {tab === 'Client invoices' && <ClientInvoices data={data} can={can} />}
    {tab === 'Bonds' && <Bonds data={data} can={can} />}
    {tab === 'Petty cash' && <PettyCash data={data} can={can} />}
    {tab === 'Expenses' && <Expenses />}
    {tab === 'Income' && <Income />}
    {tab === 'Supplier invoices' && <Invoices can={can} refresh={refresh} />}
    {tab === 'Categories' && <Categories />}

    {open === 'Expenses' && <ExpenseForm data={data} close={() => setOpen('')} reload={refresh} />}
    {open === 'Income' && <IncomeForm data={data} close={() => setOpen('')} reload={refresh} />}
    {open === 'Supplier invoices' && <InvoiceForm close={() => setOpen('')} reload={refresh} />}
    {open === 'Categories' && <CategoryForm close={() => setOpen('')} reload={refresh} />}
  </Page>;
}

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

function Expenses() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/finance/expenses').then(setRows).catch(() => setRows([])));
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

function Income() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/finance/income').then(setRows).catch(() => setRows([])));
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

const INVOICE_COLUMNS = ['Invoice', 'Supplier', 'Order', 'Due date', 'Amount', 'Outstanding', 'Status', ''];
const INVOICE_TEMPLATE = 'minmax(130px,1fr) minmax(160px,1.2fr) 130px 120px 130px 130px 120px 110px';

function Invoices({ can, refresh }) {
  const [rows, setRows] = useState([]);
  const [paying, setPaying] = useState(null);
  const load = () => api('/purchasing/invoices').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  return <>
    <Table columns={INVOICE_COLUMNS} template={INVOICE_TEMPLATE} title="Supplier invoices" empty="No invoices recorded.">
      {rows.map(row => <Row template={INVOICE_TEMPLATE} key={row.id}>
        <strong>{row.invoiceNo}</strong>
        <span>{row.supplier}</span>
        <span>{row.orderReference || '—'}</span>
        <span className={row.dueDate && new Date(row.dueDate) < new Date() && row.status !== 'Paid' ? 'overdue' : ''}>{shortDate(row.dueDate)}</span>
        <span>{rupees(row.amount)}</span>
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
function Categories() {
  const [rows, setRows] = useState([]);
  const [expenses, setExpenses] = useState([]);
  useLiveList(() => {
    api('/finance/categories').then(setRows).catch(() => setRows([]));
    api('/finance/expenses').then(setExpenses).catch(() => setExpenses([]));
  });
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
    <Field name="amount" label="Amount (LKR)" type="number" step="any" min="0" />
    <Field name="expenseDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="description" label="Description" wide />
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
    <SelectField name="method" label="Method" options={payMethods} />
    <Field name="reference" label="Reference" required={false} />
    <Field name="description" label="Description" wide />
  </FormModal>;
}

function InvoiceForm({ close, reload }) {
  const [suppliers, setSuppliers] = useState([]);
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api('/purchasing/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    api('/purchasing/orders').then(setOrders).catch(() => setOrders([]));
  }, []);
  return <FormModal title="Record supplier invoice" close={close} label="Save invoice" onSubmit={async values => {
    await post('/purchasing/invoices', {
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
    <SelectField name="method" label="Method" options={payMethods} />
    <Field name="reference" label="Reference" required={false} />
  </FormModal>;
}
