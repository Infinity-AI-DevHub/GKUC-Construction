import { query } from '../db.js';

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const byMonth = rows => new Map(rows.map(row => [String(row.period), Number(row.amount)]));
const value = (map, period) => round(map.get(period) || 0);
const offset = (period, months) => {
  const [year, month] = period.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Consolidated cash movement. Internal float top-ups are transfers, not new cash outflows. */
export async function cashComparison(companyId, period) {
  const first = offset(period, -12), last = offset(period, 1);
  const start = `${first}-01`, end = `${last}-01`;
  const [incomes, suppliers, bills, petty, directOffice, directSite, cardSettlements, payroll, inputs] = await Promise.all([
    query(`SELECT DATE_FORMAT(i.received_date,'%Y-%m') period,SUM(i.amount) amount FROM incomes i
      LEFT JOIN projects p ON p.id=i.project_id WHERE COALESCE(i.company_id,p.company_id)=?
      AND i.received_date>=? AND i.received_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(sp.paid_date,'%Y-%m') period,SUM(sp.amount) amount FROM supplier_payments sp
      JOIN supplier_invoices si ON si.id=sp.invoice_id WHERE si.company_id=? AND sp.method<>'Card'
      AND sp.paid_date>=? AND sp.paid_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(paid_date,'%Y-%m') period,SUM(total_amount) amount FROM operating_bills
      WHERE company_id=? AND status='Paid' AND COALESCE(payment_method,'')<>'Card'
      AND paid_date>=? AND paid_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(e.entry_date,'%Y-%m') period,SUM(ABS(e.amount)) amount FROM petty_cash_entries e
      JOIN petty_cash_floats f ON f.id=e.float_id WHERE f.company_id=? AND e.kind='Spend'
      AND e.entry_date>=? AND e.entry_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(payment_date,'%Y-%m') period,SUM(amount) amount FROM office_expense_payments
      WHERE company_id=? AND payment_method<>'Card' AND payment_date>=? AND payment_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(e.paid_date,'%Y-%m') period,SUM(e.amount) amount FROM expenses e
      JOIN projects p ON p.id=e.project_id WHERE p.company_id=? AND e.origin_type IS NULL
      AND e.payment_method IS NOT NULL AND e.payment_method<>'Card'
      AND e.paid_date>=? AND e.paid_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(cp.paid_date,'%Y-%m') period,SUM(cp.amount) amount FROM credit_card_payments cp
      JOIN credit_card_statements cs ON cs.id=cp.statement_id
      JOIN company_credit_cards c ON c.id=cs.card_id WHERE c.company_id=?
      AND cp.paid_date>=? AND cp.paid_date<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT DATE_FORMAT(period_end,'%Y-%m') period,SUM(total) amount FROM payroll_runs
      WHERE company_id=? AND status='Paid' AND period_end>=? AND period_end<? GROUP BY period`,[companyId,start,end]),
    query(`SELECT period,budget_receipts budgetReceipts,budget_payments budgetPayments,
      opening_balance openingBalance,verified_closing_balance verifiedClosingBalance,
      reconciliation_adjustment reconciliationAdjustment,adjustment_reason adjustmentReason,
      balance_source balanceSource FROM cash_comparison_periods
      WHERE company_id=? AND period>=? AND period<=?`,[companyId,first,period])
  ]);
  const maps = [suppliers,bills,petty,directOffice,directSite,cardSettlements,payroll].map(byMonth);
  const incomeMap=byMonth(incomes),inputMap=new Map(inputs.map(row=>[row.period,row]));
  const months=Array.from({length:13},(_,index)=>offset(first,index)).map(key=>{
    const info=inputMap.get(key)||{},receipts=value(incomeMap,key);
    const components={supplierPayments:value(maps[0],key),operatingBills:value(maps[1],key),pettyCash:value(maps[2],key),
      directOffice:value(maps[3],key),directSite:value(maps[4],key),cardSettlements:value(maps[5],key),paidPayroll:value(maps[6],key)};
    const payments=round(Object.values(components).reduce((sum,amount)=>sum+amount,0));
    const movement=round(receipts-payments),opening=info.openingBalance===null||info.openingBalance===undefined?null:Number(info.openingBalance);
    const verifiedClosing=info.verifiedClosingBalance===null||info.verifiedClosingBalance===undefined?null:Number(info.verifiedClosingBalance);
    const adjustment=Number(info.reconciliationAdjustment||0);
    const calculatedClosing=opening===null?null:round(opening+movement+adjustment);
    const difference=calculatedClosing===null||verifiedClosing===null?null:round(verifiedClosing-calculatedClosing);
    return {period:key,receipts,payments,movement,components,budgetReceipts:info.budgetReceipts===null||info.budgetReceipts===undefined?null:Number(info.budgetReceipts),
      budgetPayments:info.budgetPayments===null||info.budgetPayments===undefined?null:Number(info.budgetPayments),
      openingBalance:opening,verifiedClosingBalance:verifiedClosing,reconciliationAdjustment:adjustment,
      adjustmentReason:info.adjustmentReason||null,balanceSource:info.balanceSource||null,calculatedClosing,difference,
      reconciliationStatus:difference===null?'Missing balance':Math.abs(difference)<0.01?'Reconciled':'Difference'};
  });
  const current=months.at(-1),previous=months.at(-2),priorYear=months[0];
  return {companyId,period,months:months.slice(1),current,previous,priorYear,
    comparison:{receiptsVsPrevious:round(current.receipts-previous.receipts),paymentsVsPrevious:round(current.payments-previous.payments),
      movementVsPrevious:round(current.movement-previous.movement),receiptsVsPriorYear:round(current.receipts-priorYear.receipts),
      paymentsVsPriorYear:round(current.payments-priorYear.payments),movementVsPriorYear:round(current.movement-priorYear.movement),
      receiptsVsBudget:current.budgetReceipts===null?null:round(current.receipts-current.budgetReceipts),
      paymentsVsBudget:current.budgetPayments===null?null:round(current.payments-current.budgetPayments)},
    note:'Company-wide recorded cash, not a bank-by-bank statement. Card purchases enter when the card statement is settled; float top-ups are internal transfers. Paid payroll is dated by period end because no payment date is stored, so Finance must verify that timing. Reconciled requires both entered balances and zero difference.'};
}
