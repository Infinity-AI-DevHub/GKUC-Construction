const round = value => Math.round(Number(value || 0) * 100) / 100;
const reject = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function invoiceOptions(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
  return { ...parsed, columns: { unit: true, quantity: true, rate: true, ...parsed.columns }, previousInvoices: parsed.previousInvoices || [] };
}

/** Resolve settled invoices and their ancestors once, within the same billing account. */
export async function previousInvoiceCredits(load, ids, scope) {
  const found = new Map();
  const pending = [...ids];
  while (pending.length) {
    const id = Number(pending.shift());
    if (found.has(id)) continue;
    if (found.size >= 100) reject('Too many previous invoices in this cumulative bill.');
    const row = await load(id);
    if (!row || Number(row.company_id) !== Number(scope.companyId) || Number(row.client_id) !== Number(scope.clientId)
      || Number(row.project_id || 0) !== Number(scope.projectId || 0))
      reject('Previous invoices must belong to this company, client and project.');
    if (row.status !== 'Paid' || Math.abs(Number(row.paid_amount) - Number(row.net_payable)) > 0.001)
      reject('Only fully paid invoices can be deducted. Settle any outstanding balance first.');
    if (String(row.invoice_date).slice(0, 10) > scope.invoiceDate) reject('A previous invoice cannot be dated after this invoice.');
    if (row.tax_treatment !== scope.taxTreatment || Number(row.vat_rate) !== Number(scope.vatRate))
      reject('Previous invoices must use the same tax treatment and VAT rate.');
    found.set(id, {
      invoiceId: id, reference: row.reference, amount: round(row.net_payable), gross: round(row.gross),
      vatAmount: round(row.vat_amount), retentionAmount: round(row.retention_amount),
      advanceRecovery: round(row.advance_recovery), otherDeductions: round(row.other_deductions)
    });
    pending.push(...invoiceOptions(row.invoice_options).previousInvoices.map(item => item.invoiceId));
  }
  return [...found.values()].sort((a, b) => a.invoiceId - b.invoiceId);
}

/** Persist only the new amounts; retain cumulative workings for the customer document. */
export function cumulativeInvoice(current, previousInvoices) {
  if (!previousInvoices.length) return { ...current, previousInvoices: [], cumulativeTotals: null };
  const fields = ['gross', 'vatAmount', 'retentionAmount', 'advanceRecovery', 'otherDeductions'];
  const result = { ...current };
  for (const field of fields) {
    result[field] = round(current[field] - previousInvoices.reduce((sum, row) => sum + row[field], 0));
    if (result[field] < 0) reject('Cumulative work, tax and deductions must include all amounts already invoiced.');
  }
  result.vatCollected = current.vatCollected ? result.vatAmount : 0;
  const previousPaid = round(previousInvoices.reduce((sum, row) => sum + row.amount, 0));
  result.netPayable = round(current.netPayable - previousPaid);
  if (result.netPayable <= 0) reject('The cumulative bill must leave a positive new amount to invoice.');
  return { ...result, previousInvoices, cumulativeTotals: current,
    workings: [...current.workings, ...previousInvoices.map(row => ({ label: `Less paid invoice ${row.reference}`, amount: -row.amount }))] };
}
