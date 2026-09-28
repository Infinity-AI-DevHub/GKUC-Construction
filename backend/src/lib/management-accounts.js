import { query } from '../db.js';

const sum = (rows, key) => rows.reduce((value, row) => value + Number(row[key] || 0), 0);
const rounded = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function periodBounds(period) {
  const [year, month] = period.split('-').map(Number);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start: `${period}-01`, next };
}

export async function managementPack(companyId, period) {
  const { start, next } = periodBounds(period);
  const [company, projects, invoices, receipts, incomes, expenses, supplierInvoices,
    supplierPayments, bills, petty, payroll, adjustments] = await Promise.all([
    query('SELECT id,name FROM companies WHERE id=?', [companyId]),
    query(`SELECT p.id,p.name,p.progress,p.budget,
      COALESCE((SELECT SUM(v.amount) FROM variation_orders v WHERE v.project_id=p.id AND v.status='Approved'),0) variations,
      (SELECT q.subtotal*(1+q.markup_percent/100) FROM quotations_client q
       WHERE q.project_id=p.id AND q.status='Accepted' ORDER BY q.quote_date DESC,q.id DESC LIMIT 1) acceptedValue,
      COALESCE((SELECT SUM(f.forecast_amount) FROM project_cost_forecasts f WHERE f.project_id=p.id),0) forecastCost
      FROM projects p WHERE p.company_id=? ORDER BY p.name`, [companyId]),
    query(`SELECT id,project_id projectId,reference,kind,invoice_date date,gross,net_payable netPayable
      FROM client_invoices WHERE company_id=? AND invoice_date<? AND status NOT IN ('Draft','Cancelled')`, [companyId,next]),
    query(`SELECT r.id,r.invoice_id invoiceId,r.amount,r.received_date date FROM client_receipts r
      JOIN client_invoices i ON i.id=r.invoice_id WHERE i.company_id=? AND i.status NOT IN ('Draft','Cancelled') AND r.received_date<?`, [companyId,next]),
    query(`SELECT i.id,i.project_id projectId,i.amount,i.received_date date,i.description FROM incomes i
      LEFT JOIN projects p ON p.id=i.project_id WHERE COALESCE(i.company_id,p.company_id)=?
      AND i.received_date>=? AND i.received_date<?`, [companyId,start,next]),
    query(`SELECT e.id,e.project_id projectId,e.amount,e.expense_date date,e.description,e.origin_type originType
      FROM expenses e JOIN projects p ON p.id=e.project_id WHERE p.company_id=? AND e.expense_date<?`, [companyId,next]),
    query(`SELECT si.id,si.order_id orderId,si.invoice_no reference,si.amount,si.net_amount netAmount,si.invoice_date date
      FROM supplier_invoices si WHERE si.company_id=? AND si.invoice_date<?`, [companyId,next]),
    query(`SELECT sp.id,sp.invoice_id invoiceId,sp.amount,sp.paid_date date FROM supplier_payments sp
      JOIN supplier_invoices si ON si.id=sp.invoice_id WHERE si.company_id=? AND sp.paid_date<?`, [companyId,next]),
    query(`SELECT id,project_id projectId,reference,net_amount netAmount,total_amount totalAmount,
      bill_date date,paid_date paidDate,status FROM operating_bills
      WHERE company_id=? AND bill_date<? AND status<>'Cancelled'`, [companyId,next]),
    query(`SELECT e.id,e.amount,e.entry_date date,e.kind FROM petty_cash_entries e
      JOIN petty_cash_floats f ON f.id=e.float_id WHERE f.company_id=? AND e.entry_date>=? AND e.entry_date<?`, [companyId,start,next]),
    query(`SELECT id,total,period_end date FROM payroll_runs WHERE company_id=? AND status='Paid'
      AND period_end>=? AND period_end<?`, [companyId,start,next]),
    query(`SELECT a.id,a.category,a.amount,a.explanation,a.reference,a.project_id projectId,a.created_at createdAt,
      u.name createdBy FROM management_adjustments a JOIN users u ON u.id=a.created_by
      WHERE a.company_id=? AND a.period=? ORDER BY a.id`, [companyId,period])
  ]);
  if (!company.length) return null;
  const inMonth = row => row.date >= start && row.date < next;
  const adj = category => sum(adjustments.filter(row => row.category === category), 'amount');
  const earnedInvoices = invoices.filter(row => inMonth(row) && row.kind !== 'Advance');
  const revenue = sum(earnedInvoices, 'gross');
  // The income ledger includes client receipts and other income. Keep it on the cash side;
  // adding it to billed work here would count client payments as revenue a second time.
  const monthlyExpenses = expenses.filter(inMonth);
  const monthlyBills = bills.filter(inMonth);
  const cost = sum(monthlyExpenses.filter(row => row.originType !== 'operating_bill'), 'amount') + sum(monthlyBills, 'netAmount');
  const receivableRows = invoices.map(invoice => {
    const received = sum(receipts.filter(row => row.invoiceId === invoice.id), 'amount');
    return { ...invoice, received: rounded(received), outstanding: rounded(Math.max(0, Number(invoice.netPayable) - received)) };
  }).filter(row => row.outstanding > 0);
  const payableRows = supplierInvoices.map(invoice => {
    const paid = sum(supplierPayments.filter(row => row.invoiceId === invoice.id), 'amount');
    return { ...invoice, paid: rounded(paid), outstanding: rounded(Math.max(0, Number(invoice.amount) - paid)) };
  }).filter(row => row.outstanding > 0);
  const billPayables = bills.filter(row => !row.paidDate || row.paidDate >= next).map(row => ({ ...row, outstanding: Number(row.totalAmount) }));
  const cashPaid = sum(supplierPayments.filter(inMonth), 'amount') +
    sum(bills.filter(row => row.paidDate && row.paidDate >= start && row.paidDate < next), 'totalAmount') +
    Math.abs(sum(petty.filter(row => row.kind === 'Spend'), 'amount')) + sum(payroll, 'total');
  const projectWip = projects.map(project => {
    const projectInvoices = invoices.filter(row => row.projectId === project.id && row.kind !== 'Advance');
    const billed = sum(projectInvoices, 'gross');
    const contract = project.acceptedValue === null ? Math.max(0, Number(project.budget) - Number(project.variations)) : Number(project.acceptedValue);
    const estimatedEarned = rounded((contract + Number(project.variations)) * Number(project.progress) / 100);
    return { projectId: project.id, project: project.name, progress: project.progress,
      contract: rounded(contract), approvedVariations: rounded(project.variations), billed: rounded(billed),
      actualCost: rounded(sum(expenses.filter(row => row.projectId === project.id), 'amount')),
      forecastCost: rounded(project.forecastCost), estimatedEarned,
      unbilledEstimate: rounded(Math.max(0, estimatedEarned - billed)) };
  });
  const checks = [
    { label: 'Client invoices = receipts + outstanding', difference: rounded(sum(invoices,'netPayable') - sum(receipts,'amount') - sum(receivableRows,'outstanding')) },
    { label: 'Supplier invoices = payments + outstanding', difference: rounded(sum(supplierInvoices,'amount') - sum(supplierPayments,'amount') - sum(payableRows,'outstanding')) },
    { label: 'Operating bills = paid + outstanding', difference: rounded(sum(bills,'totalAmount') - sum(bills.filter(row => row.paidDate && row.paidDate < next),'totalAmount') - sum(billPayables,'outstanding')) }
  ];
  return { company: company[0], period, basis: 'Management estimate — not audited',
    accrual: { billedWorkRevenue: rounded(revenue), revenueAdjustments: rounded(adj('Revenue')),
      recordedCost: rounded(cost), costAdjustments: rounded(adj('Cost')),
      result: rounded(revenue + adj('Revenue') - cost - adj('Cost')) },
    cash: { receiptsCaptured: rounded(sum(incomes, 'amount')), paymentsCaptured: rounded(cashPaid),
      movementCaptured: rounded(sum(incomes, 'amount') - cashPaid) },
    workingCapital: { receivables: rounded(sum(receivableRows, 'outstanding') + adj('Receivable')),
      payables: rounded(sum(payableRows, 'outstanding') + sum(billPayables, 'outstanding') + adj('Payable')),
      receivableRows, payableRows, billPayables },
    wip: { projects: projectWip, unbilledEstimate: rounded(sum(projectWip, 'unbilledEstimate')),
      managementAdjustment: rounded(adj('WIP')) },
    adjustments, reconciliation: { checks, balanced: checks.every(row => Math.abs(row.difference) < 0.01) },
    sources: { earnedInvoices, monthlyExpenses, monthlyBills,
      monthlyReceipts: incomes, monthlySupplierPayments: supplierPayments.filter(inMonth) },
    caveats: [
      'This is an internal management pack, not an audited income statement or balance sheet.',
      'Accrual revenue uses issued non-advance invoice work before VAT. Unbilled WIP is an estimate from project progress and is not automatically recognised as revenue.',
      'Cost uses posted project expenses and operating bills by bill date. Supplier invoices and purchase orders are working-capital or commitment records, not automatically a second expense.',
      'Cash payments captured include supplier payments, paid operating bills, petty-cash spending and paid payroll. Direct bank payments without a linked payment record may be missing.',
      'Receivable and payable balances are as at month end; later payments are excluded. This pack does not replace bank reconciliation.'
    ] };
}
