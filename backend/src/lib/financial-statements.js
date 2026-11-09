// Statement presentation of the existing saved management-account sources.
// Unknown balances remain null: never manufacture equity to balance the statement.
export function financialStatements(pack) {
  const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const sum = rows => round(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const row = (label, amount = null, style = 'detail') => ({ label, amount, style });
  const heading = label => row(label, null, 'heading');
  const expenses = pack.sources.monthlyExpenses.filter(item => item.originType !== 'operating_bill');
  const direct = expenses.filter(item => ['Material','Labour','Fuel','Equipment','Subcontractor'].includes(item.source));
  const other = expenses.filter(item => !direct.includes(item));
  const revenue = round(pack.accrual.billedWorkRevenue + pack.accrual.revenueAdjustments);
  const directCost = sum(direct);
  const operatingCost = round(sum(other) + pack.sources.monthlyBills.reduce((sum, item) => sum + Number(item.netAmount || 0), 0) + pack.accrual.costAdjustments);
  const grossProfit = round(revenue - directCost);
  const result = round(grossProfit - operatingCost);
  const [year, month] = pack.period.split('-').map(Number);
  const asAt = new Date(Date.UTC(year, month, 0)).toISOString().slice(0,10);
  return { company: pack.company, period: pack.period, asAt,
    basis: 'Internal management statement · incomplete accounting coverage',
    notes: [
      'Income statement covers the selected calendar month. Financial position includes recorded balances through month end; later receipts and payments are excluded.',
      'Revenue is issued non-advance work before VAT, plus saved management revenue adjustments. Client receipts are not added again.',
      'Direct costs use Material, Labour, Fuel, Equipment and Subcontractor project expenses. Other posted project costs and net operating bills form operating expenses; linked operating-bill expenses are excluded to avoid duplication.',
      'Cash/bank, inventory valuation, fixed assets, depreciation, borrowings, capital, retained earnings, interest and tax are not fully available in these sources. Not recorded means unknown, not zero. Totals requiring missing balances are withheld.',
      'This live view is separate from versioned closed management packs. WIP estimates are not recognised as assets or revenue here. Receivable/payable adjustments are the selected month’s saved management adjustments.',
      ...pack.caveats.slice(2)
    ],
    incomeStatement: [
      row('Sales / work revenue', pack.accrual.billedWorkRevenue),
      row('Revenue adjustments', pack.accrual.revenueAdjustments), row('Total revenue',revenue,'total'),
      heading('Less: Cost of sales / direct project costs'),
      ...['Material','Labour','Fuel','Equipment','Subcontractor'].map(source => row(source === 'Material' ? 'Materials' : source, sum(direct.filter(item => item.source === source)))),
      row('Total direct costs',directCost,'total'),row('Gross Profit / (Loss)',grossProfit,'total'),
      heading('Less: Operating expenses'), row('Other project expenses',sum(other)),
      row('Operating bills (before VAT)',round(pack.sources.monthlyBills.reduce((sum, item) => sum + Number(item.netAmount || 0),0))),
      row('Cost adjustments',pack.accrual.costAdjustments),row('Total operating expenses',operatingCost,'total'),
      row('Operating Profit / (Loss) — recorded sources',result,'total'),
      row('Other non-operating income / expenses'),row('Interest income / (expense)'),
      row('Earnings Before Tax',null,'total'),row('Income tax'),row('Net Profit / (Loss)',null,'grand')
    ],
    financialPosition: [
      heading('Assets'), heading('Current Assets'), row('Cash and bank'),row('Accounts receivable',pack.workingCapital.receivables),row('Inventory'),row('Total Current Assets',null,'total'),
      heading('Fixed Assets'),row('Property, plant and equipment'),row('Accumulated depreciation'),row('Total Fixed Assets',null,'total'),
      heading('Other Assets'),row('Other assets'),row('Total Other Assets',null,'total'),row('Total Assets',null,'grand'),
      heading('Liabilities'),heading('Current Liabilities'),
      row('Supplier accounts payable',sum(pack.workingCapital.payableRows.map(item => ({amount:item.outstanding})))),
      row('Operating bills payable',sum(pack.workingCapital.billPayables.map(item => ({amount:item.outstanding})))),
      row('Payable adjustments',round(pack.workingCapital.payables - sum([...pack.workingCapital.payableRows,...pack.workingCapital.billPayables].map(item => ({amount:item.outstanding}))))),
      row('Known trade and bill payables',pack.workingCapital.payables,'total'),
      row('Other current liabilities / accruals'),row('Total Current Liabilities',null,'total'),
      row('Long-term liabilities'),row('Total Liabilities',null,'grand'),
      heading("Owner’s Equity"),row('Capital / share capital'),row('Retained earnings'),
      row('Total Equity',null,'total'),row('Total Liabilities and Equity',null,'grand')
    ] };
}
