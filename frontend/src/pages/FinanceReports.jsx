import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Building2, Download, FileText, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { api, rupees, shortDate, todayInput } from '../api.js';

const n = value => Number(value || 0);
const total = (rows, key) => rows.reduce((sum, row) => sum + n(typeof key === 'function' ? key(row) : row[key]), 0);
const pct = (value, base) => base ? (n(value) / n(base) * 100).toFixed(1) : '0.0';
const money = value => rupees(n(value));
const metric = (label, value, raw = null) => ({ label, value, raw });
const table = (columns, rows) => ({ columns, rows });
const report = (id, title, category, narrative, metrics, visual, schedule) =>
  ({ id, title, category, narrative, metrics, visual, ...schedule });
const monthKey = date => String(date || '').slice(0, 7) || 'Unspecified';
const group = (rows, key, valueKey = 'amount') => Object.values(rows.reduce((out, row) => {
  const label = typeof key === 'function' ? key(row) : row[key] || 'Uncategorised';
  out[label] ||= { label, value: 0 };
  out[label].value += n(typeof valueKey === 'function' ? valueKey(row) : row[valueKey]);
  return out;
}, {})).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

function buildReports(data) {
  const expenses = data.expenses || [];
  const incomes = data.incomes || [];
  const invoices = data.clientInvoices || [];
  const receipts = data.clientReceipts || [];
  const supplierInvoices = data.supplierInvoices || [];
  const supplierPayments = data.supplierPayments || [];
  const orders = data.purchaseOrders || [];
  const retentions = data.retentions || [];
  const bonds = data.bonds || [];
  const payroll = data.payroll || [];
  const petty = data.pettyCash || [];
  const variations = data.variations || [];
  const cost = total(expenses, 'amount');
  const income = total(incomes, 'amount');
  const profit = income - cost;
  const budget = total(data.projects || [], 'budget');
  const outstandingReceivable = invoices.reduce((sum, row) => sum + Math.max(0, n(row.netPayable) - n(row.paidAmount)), 0);
  const outstandingPayable = supplierInvoices.reduce((sum, row) => sum + Math.max(0, n(row.amount) - n(row.paidAmount)), 0);
  const today = todayInput();
  const overdueReceivables = invoices.filter(row => row.dueDate && row.dueDate < today && n(row.netPayable) > n(row.paidAmount));
  const overduePayables = supplierInvoices.filter(row => row.dueDate && row.dueDate < today && n(row.amount) > n(row.paidAmount));
  const scopeName = data.projects?.length === 1 && data.scope?.projectId !== 'all' ? data.projects[0].name : 'the company';

  const projectPosition = (data.projects || []).map(project => {
    const projectExpenses = expenses.filter(row => n(row.projectId) === n(project.id));
    const projectIncomes = incomes.filter(row => n(row.projectId) === n(project.id));
    const actual = total(projectExpenses, 'amount');
    const revenue = total(projectIncomes, 'amount');
    return { project: project.name, budget: n(project.budget), actual, revenue, profit: revenue - actual };
  });
  const months = [...new Set([
    ...expenses.map(row => monthKey(row.date)), ...incomes.map(row => monthKey(row.date)),
    ...receipts.map(row => monthKey(row.date)), ...supplierPayments.map(row => monthKey(row.date))
  ])].sort();
  const monthly = months.map(month => {
    const cashIn = total(incomes.filter(row => monthKey(row.date) === month), 'amount');
    const cashOut = total(expenses.filter(row => monthKey(row.date) === month), 'amount');
    return { month, cashIn, cashOut, net: cashIn - cashOut };
  });
  const approvedVariations = variations.filter(row => row.status === 'Approved');
  const forecastRows = projectPosition.map(row => {
    const project = data.projects.find(item => item.name === row.project);
    const items = (data.costItems || []).filter(item => n(item.projectId) === n(project?.id));
    const itemBaseline = total(items, 'expectedAmount');
    const explicitUnexpected = total(expenses.filter(item => n(item.projectId) === n(project?.id) && item.costType === 'Unexpected'), 'amount');
    const itemForecast = items.reduce((sum, item) => sum + Math.max(n(item.actualAmount), item.forecastAmount === null ? n(item.expectedAmount) : n(item.forecastAmount)), 0) + explicitUnexpected;
    const approvedChanges = total(approvedVariations.filter(item => n(item.projectId) === n(project?.id)), 'amount');
    const baseline = itemBaseline || Math.max(0, row.budget - approvedChanges);
    const currentBudget = baseline + approvedChanges || row.budget;
    const forecast = Math.max(row.actual, itemForecast || row.actual);
    return { ...row, baseline: currentBudget, forecast, variance: forecast - currentBudget };
  });
  const unexpected = expenses.filter(row => row.costType === 'Unexpected' || (!row.boqItemId && row.costType !== 'Variation'));
  const tax = invoices.reduce((sum, row) => sum + n(row.vatAmount), 0);
  const collected = total(invoices, 'paidAmount');
  const certified = total(invoices, 'netPayable');
  const retentionHeld = retentions.reduce((sum, row) => sum + Math.max(0, n(row.amount) - n(row.releasedAmount)), 0);
  const committed = total(orders.filter(row => row.status !== 'Cancelled'), 'total');
  const pettyIn = total(petty.filter(row => n(row.amount) > 0), 'amount');
  const pettyOut = Math.abs(total(petty.filter(row => n(row.amount) < 0), 'amount'));

  return [
    report('executive', 'Executive financial summary', 'Management', `${scopeName} recorded ${money(income)} of income and ${money(cost)} of cost in the selected period. The resulting position is ${profit >= 0 ? 'a profit' : 'a loss'} of ${money(Math.abs(profit))}, with ${money(outstandingReceivable)} still due from clients.`, [metric('Income', money(income), income), metric('Cost', money(cost), cost), metric(profit >= 0 ? 'Profit' : 'Loss', money(Math.abs(profit)), profit), metric('Cash margin', `${pct(profit, income)}%`, profit)], [{ label: 'Income', value: income, display: money(income) }, { label: 'Cost', value: cost, display: money(cost) }, { label: profit >= 0 ? 'Profit' : 'Loss', value: profit, display: money(Math.abs(profit)) }, { label: 'Receivable', value: outstandingReceivable, display: money(outstandingReceivable) }], table(['Measure', 'Amount'], [['Recorded income', money(income)], ['Recorded cost', money(cost)], ['Net result', money(profit)], ['Client receivables', money(outstandingReceivable)], ['Supplier payables', money(outstandingPayable)]])),
    report('profit-loss', 'Profit and loss statement', 'Performance', `${scopeName} has a ${profit >= 0 ? 'positive' : 'negative'} operating result for this reporting range. This view uses posted income and expense ledgers, so draft invoices are kept separate from earned cash.`, [metric('Revenue', money(income), income), metric('Expenses', money(cost), cost), metric('Net result', money(profit), profit), metric('Margin', `${pct(profit, income)}%`, profit)], group(incomes, 'project').map(row => ({ ...row, display: money(row.value) })), table(['Account', 'Amount'], [['Revenue / other income', money(income)], ...group(expenses, 'source').map(row => [`Less: ${row.label}`, money(row.value)]), ['Net profit / (loss)', money(profit)]])),
    report('project-profitability', 'Project profitability comparison', 'Performance', `${projectPosition.filter(row => row.profit >= 0).length} of ${projectPosition.length} visible project(s) are profitable on posted income and cost. The comparison exposes sites whose activity is consuming cash faster than it is earning it.`, [metric('Projects', projectPosition.length), metric('Profitable', projectPosition.filter(row => row.profit >= 0).length), metric('Loss-making', projectPosition.filter(row => row.profit < 0).length), metric('Combined result', money(profit), profit)], projectPosition.map(row => ({ label: row.project, value: row.profit, display: money(row.profit) })), table(['Project', 'Income', 'Cost', 'Profit / (loss)', 'Margin'], projectPosition.map(row => [row.project, money(row.revenue), money(row.actual), money(row.profit), `${pct(row.profit, row.revenue)}%`]))),
    report('budget-actual', 'Budget versus actual cost', 'Cost control', `${pct(cost, budget)}% of the visible approved project budget has been consumed. ${cost <= budget ? `${money(budget - cost)} remains within the approved envelope.` : `Recorded cost is ${money(cost - budget)} above it.`}`, [metric('Approved budget', money(budget), budget), metric('Actual cost', money(cost), cost), metric(cost <= budget ? 'Available' : 'Overrun', money(Math.abs(budget - cost)), budget - cost), metric('Budget used', `${pct(cost, budget)}%`, cost)], projectPosition.map(row => ({ label: row.project, value: row.actual, display: `${pct(row.actual, row.budget)}% used` })), table(['Project', 'Budget', 'Actual', 'Variance', 'Used'], projectPosition.map(row => [row.project, money(row.budget), money(row.actual), money(row.budget - row.actual), `${pct(row.actual, row.budget)}%`]))),
    report('cash-flow', 'Cash flow movement', 'Cash', `Cash movement across the selected range is ${monthly.reduce((sum, row) => sum + row.net, 0) >= 0 ? 'positive' : 'negative'}. Client receipts are already posted once in the income ledger and are shown against posted operating cash costs by month.`, [metric('Cash in', money(total(monthly, 'cashIn')), total(monthly, 'cashIn')), metric('Cash out', money(total(monthly, 'cashOut')), total(monthly, 'cashOut')), metric('Net movement', money(total(monthly, 'net')), total(monthly, 'net')), metric('Periods', monthly.length)], monthly.map(row => ({ label: row.month, value: row.net, display: money(row.net) })), table(['Month', 'Cash in', 'Cash out', 'Net movement'], monthly.map(row => [row.month, money(row.cashIn), money(row.cashOut), money(row.net)]))),
    report('revenue', 'Revenue and income analysis', 'Revenue', `${money(income)} has been posted across ${incomes.length} income entry or entries. The project and payment-method schedules show where the money came from and how it was received.`, [metric('Income received', money(income), income), metric('Entries', incomes.length), metric('Projects', new Set(incomes.map(row => row.projectId)).size), metric('Average receipt', money(incomes.length ? income / incomes.length : 0))], group(incomes, 'project').map(row => ({ ...row, display: money(row.value) })), table(['Date', 'Project', 'Description', 'Method', 'Amount'], incomes.map(row => [shortDate(row.date), row.project, row.description, row.method, money(row.amount)]))),
    report('expenses', 'Expense analysis by category', 'Cost', `${money(cost)} has been posted across ${expenses.length} cost entries. ${group(expenses, 'source')[0]?.label || 'No category'} is currently the largest source category.`, [metric('Total expense', money(cost), cost), metric('Transactions', expenses.length), metric('Categories', new Set(expenses.map(row => row.source)).size), metric('Largest category', group(expenses, 'source')[0]?.label || '—')], group(expenses, 'source').map(row => ({ ...row, display: money(row.value) })), table(['Date', 'Project', 'Source', 'Expense category', 'Description', 'Amount'], expenses.map(row => [shortDate(row.date), row.project, row.source, row.category, row.description, money(row.amount)]))),
    report('receivables', 'Accounts receivable and ageing', 'Working capital', `${money(outstandingReceivable)} remains collectible from clients. ${overdueReceivables.length} certificate(s) have passed their due date without full settlement.`, [metric('Certified', money(certified), certified), metric('Collected', money(collected), collected), metric('Outstanding', money(outstandingReceivable), outstandingReceivable), metric('Overdue', overdueReceivables.length)], invoices.map(row => ({ label: row.reference, value: Math.max(0, n(row.netPayable) - n(row.paidAmount)), display: money(Math.max(0, n(row.netPayable) - n(row.paidAmount))) })), table(['Invoice', 'Project', 'Client', 'Due date', 'Certified', 'Paid', 'Outstanding', 'Ageing'], invoices.map(row => [row.reference, row.project, row.client, shortDate(row.dueDate), money(row.netPayable), money(row.paidAmount), money(Math.max(0, n(row.netPayable) - n(row.paidAmount))), overdueReceivables.includes(row) ? 'Overdue' : n(row.netPayable) <= n(row.paidAmount) ? 'Settled' : 'Current']))),
    report('payables', 'Accounts payable and ageing', 'Working capital', `${money(outstandingPayable)} remains due to suppliers. ${overduePayables.length} invoice(s) are overdue and should be prioritised in the payment plan.`, [metric('Supplier invoices', money(total(supplierInvoices, 'amount')), total(supplierInvoices, 'amount')), metric('Paid', money(total(supplierInvoices, 'paidAmount')), total(supplierInvoices, 'paidAmount')), metric('Outstanding', money(outstandingPayable), outstandingPayable), metric('Overdue', overduePayables.length)], supplierInvoices.map(row => ({ label: row.invoiceNo, value: Math.max(0, n(row.amount) - n(row.paidAmount)), display: money(Math.max(0, n(row.amount) - n(row.paidAmount))) })), table(['Invoice', 'Supplier', 'Project', 'Due date', 'Amount', 'Paid', 'Outstanding', 'Status'], supplierInvoices.map(row => [row.invoiceNo, row.supplier, row.project, shortDate(row.dueDate), money(row.amount), money(row.paidAmount), money(Math.max(0, n(row.amount) - n(row.paidAmount))), overduePayables.includes(row) ? 'Overdue' : row.status]))),
    report('procurement', 'Procurement commitments', 'Commitments', `${money(committed)} has been committed through non-cancelled purchase orders. Comparing commitments with supplier invoices helps finance see cost that is contracted but may not yet have reached the expense ledger.`, [metric('Committed', money(committed), committed), metric('Orders', orders.length), metric('Supplier invoiced', money(total(supplierInvoices, 'amount')), total(supplierInvoices, 'amount')), metric('Uninvoiced exposure', money(Math.max(0, committed - total(supplierInvoices, 'amount'))))], group(orders.filter(row => row.status !== 'Cancelled'), 'project', 'total').map(row => ({ ...row, display: money(row.value) })), table(['Purchase order', 'Project', 'Supplier', 'Date', 'Value', 'Status'], orders.map(row => [row.reference, row.project, row.supplier, shortDate(row.orderDate), money(row.total), row.status]))),
    report('payroll', 'Payroll and labour cost', 'People cost', payroll.length ? `${money(total(payroll, 'total'))} of net payroll has been processed across ${payroll.length} run(s). Employee deductions and employer EPF/ETF costs are reported separately.` : data.scope?.projectId === 'all' ? 'No payroll runs fall inside this date range.' : 'Payroll is shown in the company-wide view because current payslips are not allocated to individual projects.', [metric('Net payroll', money(total(payroll, 'total')), total(payroll, 'total')), metric('Employer cost', money(total(payroll, 'employerCost')), total(payroll, 'employerCost')), metric('EPF employer', money(total(payroll, 'epfEmployerContributions')), total(payroll, 'epfEmployerContributions')), metric('ETF employer', money(total(payroll, 'etfEmployerContributions')), total(payroll, 'etfEmployerContributions'))], payroll.map(row => ({ label: `${row.reference} · ${row.payFrequency}`, value: row.employerCost, display: money(row.employerCost) })), table(['Run', 'Frequency', 'Period', 'Employees', 'Gross earnings', 'Net payroll', 'Employer cost', 'Overtime', 'EPF employee', 'EPF employer', 'ETF employer', 'Salary advances', 'Status'], payroll.map(row => [row.reference, row.payFrequency, `${shortDate(row.periodStart)} – ${shortDate(row.periodEnd)}`, row.employees, money(row.grossEarnings), money(row.total), money(row.employerCost), money(row.overtime), money(row.epfEmployeeDeductions), money(row.epfEmployerContributions), money(row.etfEmployerContributions), money(row.salaryAdvanceDeductions), row.status]))),
    report('petty-cash', 'Petty cash movement', 'Cash control', `${money(pettyOut)} was spent or returned across three independently funded accounts: office expenses, worker salary advances and fuel. Employee-linked advances remain traceable into payroll.`, [metric('Money in', money(pettyIn), pettyIn), metric('Money out', money(pettyOut), pettyOut), metric('Net float movement', money(pettyIn - pettyOut), pettyIn - pettyOut), metric('Salary advances', money(Math.abs(total(petty.filter(row => row.accountType === 'Salary advance' && row.kind === 'Spend'), 'amount'))))], group(petty, 'accountType').map(row => ({ ...row, display: money(row.value) })), table(['Date', 'Account', 'Float', 'Employee / project', 'Movement', 'Description', 'Amount'], petty.map(row => [shortDate(row.date), row.accountType, row.floatName, row.employee || row.project, row.kind, row.description, money(row.amount)]))),
    report('retention', 'Retention exposure and releases', 'Working capital', `${money(retentionHeld)} remains held under client or project retention arrangements. The release schedule highlights cash that should return after defects-liability obligations are met.`, [metric('Retention recorded', money(total(retentions, 'amount')), total(retentions, 'amount')), metric('Released', money(total(retentions, 'releasedAmount')), total(retentions, 'releasedAmount')), metric('Still held', money(retentionHeld), retentionHeld), metric('Records', retentions.length)], retentions.map(row => ({ label: row.project, value: Math.max(0, n(row.amount) - n(row.releasedAmount)), display: money(Math.max(0, n(row.amount) - n(row.releasedAmount))) })), table(['Project', 'Description', 'Held from', 'Release date', 'Original', 'Released', 'Balance', 'Status'], retentions.map(row => [row.project, row.description, shortDate(row.heldFrom), shortDate(row.releaseDate), money(row.amount), money(row.releasedAmount), money(n(row.amount) - n(row.releasedAmount)), row.status]))),
    report('tax', 'VAT and invoice deductions', 'Tax', `${money(tax)} of VAT is recorded on invoices issued in the selected range. Retention, advance recovery and other deductions are separated so finance can reconcile gross work, statutory treatment and the amount actually payable.`, [metric('Gross certified', money(total(invoices, 'gross')), total(invoices, 'gross')), metric('VAT', money(tax), tax), metric('Retention deducted', money(total(invoices, 'retentionAmount')), total(invoices, 'retentionAmount')), metric('Other recoveries', money(total(invoices, row => n(row.advanceRecovery) + n(row.otherDeductions))))], invoices.map(row => ({ label: row.reference, value: row.vatAmount, display: money(row.vatAmount) })), table(['Invoice', 'Project', 'Gross', 'VAT', 'Retention', 'Advance recovery', 'Other deductions', 'Net payable'], invoices.map(row => [row.reference, row.project, money(row.gross), money(row.vatAmount), money(row.retentionAmount), money(row.advanceRecovery), money(row.otherDeductions), money(row.netPayable)]))),
    report('bonds', 'Bank bonds and guarantees', 'Treasury risk', `${bonds.filter(row => row.status === 'Live').length} live bond(s) represent ${money(total(bonds.filter(row => row.status === 'Live'), 'amount'))} of contingent exposure, with ${money(total(bonds.filter(row => row.status === 'Live'), 'marginHeld'))} held as security.`, [metric('Live exposure', money(total(bonds.filter(row => row.status === 'Live'), 'amount'))), metric('Margin held', money(total(bonds.filter(row => row.status === 'Live'), 'marginHeld'))), metric('Commission', money(total(bonds, 'commission'))), metric('Live bonds', bonds.filter(row => row.status === 'Live').length)], bonds.map(row => ({ label: row.reference, value: row.amount, display: money(row.amount) })), table(['Bond', 'Project', 'Type', 'Bank', 'Beneficiary', 'Amount', 'Margin held', 'Expiry', 'Status'], bonds.map(row => [row.reference, row.project, row.kind, row.bank, row.beneficiary, money(row.amount), money(row.marginHeld), shortDate(row.expiryDate), row.status]))),
    report('forecast', 'Cost forecast and overrun', 'Forecast', `${forecastRows.filter(row => row.variance > 0).length} project(s) currently forecast above their original BOQ or approved budget baseline. The view combines actual cost with the latest QS item forecasts.`, [metric('Baseline', money(total(forecastRows, 'baseline')), total(forecastRows, 'baseline')), metric('Forecast', money(total(forecastRows, 'forecast')), total(forecastRows, 'forecast')), metric('Forecast variance', money(total(forecastRows, 'variance')), total(forecastRows, 'variance')), metric('Projects over', forecastRows.filter(row => row.variance > 0).length)], forecastRows.map(row => ({ label: row.project, value: row.variance, display: money(row.variance) })), table(['Project', 'Baseline', 'Actual cost', 'Current forecast', 'Forecast variance'], forecastRows.map(row => [row.project, money(row.baseline), money(row.actual), money(row.forecast), money(row.variance)]))),
    report('unexpected', 'Unexpected and unallocated costs', 'Cost control', `${unexpected.length} cost entry or entries totalling ${money(total(unexpected, 'amount'))} sit outside a linked BOQ item or are explicitly marked unexpected. They stay visible instead of disappearing inside planned work.`, [metric('Unexpected cost', money(total(unexpected, 'amount')), total(unexpected, 'amount')), metric('Entries', unexpected.length), metric('Share of cost', `${pct(total(unexpected, 'amount'), cost)}%`), metric('Projects affected', new Set(unexpected.map(row => row.projectId)).size)], group(unexpected, 'project').map(row => ({ ...row, display: money(row.value) })), table(['Date', 'Project', 'Description', 'Source', 'Cost type', 'Amount'], unexpected.map(row => [shortDate(row.date), row.project, row.description, row.source, row.costType, money(row.amount)]))),
    report('variations', 'Variation financial impact', 'Commercial control', `${approvedVariations.length} approved variation(s) add ${money(total(approvedVariations, 'amount'))} to the commercial position. Pending and rejected changes remain visible separately for governance.`, [metric('Approved value', money(total(approvedVariations, 'amount')), total(approvedVariations, 'amount')), metric('Pending value', money(total(variations.filter(row => row.status === 'Pending'), 'amount'))), metric('Approved', approvedVariations.length), metric('Pending', variations.filter(row => row.status === 'Pending').length)], group(variations, 'status').map(row => ({ ...row, display: money(row.value) })), table(['Date', 'Variation', 'Project', 'Description', 'Amount', 'Status'], variations.map(row => [shortDate(row.date), row.reference, row.project, row.description, money(row.amount), row.status]))),
    report('payment-methods', 'Payment method analysis', 'Cash control', `The mix of cash, cheque, card and bank transfers provides an audit view of how money entered and left the company. Client invoice receipts appear through the income ledger only once.`, [metric('Income entries', incomes.length), metric('Supplier payments', supplierPayments.length), metric('Client receipts', receipts.length), metric('Cash transactions', [...incomes, ...supplierPayments].filter(row => row.method === 'Cash').length)], group([...incomes, ...supplierPayments], 'method').map(row => ({ ...row, display: money(row.value) })), table(['Direction', 'Date', 'Project', 'Method', 'Reference', 'Amount'], [...incomes.map(row => ['In', shortDate(row.date), row.project, row.method, row.reference || row.description, money(row.amount)]), ...supplierPayments.map(row => ['Out', shortDate(row.date), row.project, row.method, row.reference || row.invoiceNo, money(row.amount)])])),
    report('monthly-trend', 'Monthly financial trend', 'Trend', `${monthly.length} reporting month(s) show how revenue, cost and net movement are developing. Use this trend to detect sustained margin pressure rather than reacting to a single transaction.`, [metric('Months', monthly.length), metric('Best month', [...monthly].sort((a, b) => b.net - a.net)[0]?.month || '—'), metric('Highest cash in', money(Math.max(0, ...monthly.map(row => row.cashIn)))), metric('Highest cash out', money(Math.max(0, ...monthly.map(row => row.cashOut))))], monthly.map(row => ({ label: row.month, value: row.net, display: money(row.net) })), table(['Month', 'Cash in', 'Cost posted', 'Net movement', 'Direction'], monthly.map(row => [row.month, money(row.cashIn), money(row.cashOut), money(row.net), row.net >= 0 ? 'Positive' : 'Negative'])))
  ];
}

function ReportVisual({ rows }) {
  const max = Math.max(1, ...rows.map(row => Math.abs(n(row.value))));
  return <div className="industrial-chart">{rows.slice(0, 14).map((row, index) => <div key={`${row.label}-${index}`}><span>{row.label}</span><i><b className={n(row.value) < 0 ? 'negative' : ''} style={{ width: `${Math.max(3, Math.abs(n(row.value)) / max * 100)}%` }} /></i><strong>{row.display ?? row.value}</strong></div>)}{!rows.length && <p>No recorded data is available for this visualization yet.</p>}</div>;
}

export default function FinanceReports({ projects, companyId, company }) {
  const [scope, setScope] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState('executive');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const params = new URLSearchParams({ companyId: String(companyId), projectId: scope });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    setData(null);
    api(`/finance/reporting?${params}`).then(setData).catch(() => setData({ projects: [], scope: { projectId: scope } }));
  }, [companyId, scope, from, to]);

  useEffect(() => { setScope('all'); }, [companyId]);
  const reports = useMemo(() => data ? buildReports(data) : [], [data]);
  const selected = reports.find(row => row.id === selectedId) || reports[0];
  const visible = reports.filter(row => `${row.title} ${row.category}`.toLowerCase().includes(query.toLowerCase()));
  const download = () => {
    if (!selected) return;
    const lines = [[selected.title], [selected.narrative], [], ...selected.metrics.map(row => [row.label, row.value]), [], selected.columns, ...selected.rows];
    const csv = lines.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const link = document.createElement('a');
    link.href = url; link.download = `finance-${scope}-${selected.id}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  return <>
    <section className="finance-report-filters">
      <div><Building2 size={18} /><span><strong>{company?.name || 'Company'} reporting</strong><small>Every figure below is isolated to this company and then optionally one project.</small></span></div>
      <label>Scope<select aria-label="Financial report scope" value={scope} onChange={event => setScope(event.target.value)}><option value="all">All {company?.name || 'company'}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>From<input aria-label="Report from date" type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>To<input aria-label="Report to date" type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
    </section>
    {!selected ? <p className="empty-state">Preparing reconciled financial reports…</p> : <div className="industrial-reports finance-report-centre">
      <aside className="report-library"><div className="report-library-head"><span>{reports.length} live reports</span><h2>Financial reports</h2><label><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a report" /></label></div><nav>{visible.map(item => <button className={selected.id === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)} key={item.id}><FileText size={15} /><span><strong>{item.title}</strong><small>{item.category}</small></span></button>)}</nav></aside>
      <section className="report-canvas">
        <header><div><span>{selected.category} report</span><h1>{selected.title}</h1><p>{scope === 'all' ? `All ${company?.name || 'company'}` : projects.find(project => String(project.id) === scope)?.name} · live ledger data</p></div><button className="secondary" onClick={download}><Download size={15} />Export table</button></header>
        <article className={`report-narrative ${selected.metrics[2]?.raw < 0 ? 'loss' : 'profit'}`}><BarChart3 size={22} /><div><strong>Management interpretation</strong><p>{selected.narrative}</p></div></article>
        <div className="report-kpis">{selected.metrics.map((row, index) => <article key={row.label}><span>{row.label}</span><strong>{row.value}</strong>{index === 2 && row.raw < 0 ? <TrendingDown /> : <TrendingUp />}</article>)}</div>
        <section className="report-visual-panel"><div><span>Visual analysis</span><h2>Financial performance view</h2></div><ReportVisual rows={selected.visual} /></section>
        <section className="report-table-panel"><div><span>Supporting schedule</span><h2>Detailed financial records</h2></div><div className="report-table-scroll"><table><thead><tr>{selected.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{selected.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell ?? '—'}</td>)}</tr>)}{!selected.rows.length && <tr><td colSpan={selected.columns.length}>No records fall inside this report scope yet.</td></tr>}</tbody></table></div></section>
      </section>
    </div>}
  </>;
}
