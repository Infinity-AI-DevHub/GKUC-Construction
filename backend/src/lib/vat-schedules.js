import { getOne, query } from '../db.js';
import { STYLE, writeWorkbook } from './xlsx-write.js';

export const SVAT_LAST_DATE = '2025-09-30';

const money = value => Number(value || 0);
const total = (rows, field) => rows.reduce((sum, row) => sum + money(row[field]), 0);

export async function vatSchedule(companyId, start, end) {
  const [company, period, output, supplier, bills, manualSvat, invoiceSvat] = await Promise.all([
    getOne('SELECT id,name,tin,vat_number vatNumber,svat_number svatNumber FROM companies WHERE id=?', [companyId]),
    getOne(`SELECT id,status,output_adjustment outputAdjustment,input_adjustment inputAdjustment,
      adjustment_note adjustmentNote,filing_reference filingReference,reconciled_at reconciledAt,filed_at filedAt
      FROM vat_periods WHERE company_id=? AND period_start=? AND period_end=?`, [companyId, start, end]),
    query(`SELECT i.id,'Client invoice' source,i.reference documentNumber,i.invoice_date documentDate,
      i.client counterparty,COALESCE(NULLIF(i.buyer_vat_number,''),c.vat_number) counterpartyVatNumber,
      i.gross taxableAmount,i.vat_rate vatRate,i.vat_amount vatAmount,i.net_payable totalAmount,i.status
      FROM client_invoices i LEFT JOIN clients c ON c.id=i.client_id
      WHERE i.company_id=? AND i.invoice_date BETWEEN ? AND ? AND i.status NOT IN ('Draft','Cancelled')
        AND i.tax_treatment='Standard' ORDER BY i.invoice_date,i.reference`, [companyId, start, end]),
    query(`SELECT i.id,'Supplier invoice' source,i.invoice_no documentNumber,i.invoice_date documentDate,
      s.name counterparty,NULL counterpartyVatNumber,i.net_amount taxableAmount,
      i.vat_rate vatRate,i.vat_amount vatAmount,i.amount totalAmount,i.status
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id
      WHERE i.company_id=? AND i.invoice_date BETWEEN ? AND ? AND i.tax_treatment='Standard'
      ORDER BY i.invoice_date,i.invoice_no`, [companyId, start, end]),
    query(`SELECT b.id,'Operating bill' source,b.reference documentNumber,b.bill_date documentDate,
      b.provider counterparty,NULL counterpartyVatNumber,b.net_amount taxableAmount,
      b.vat_rate vatRate,b.vat_amount vatAmount,b.total_amount totalAmount,b.status
      FROM operating_bills b WHERE b.company_id=? AND b.bill_date BETWEEN ? AND ?
        AND b.status<>'Cancelled' AND b.tax_treatment='Standard' ORDER BY b.bill_date,b.reference`, [companyId, start, end]),
    query(`SELECT id,direction,schedule_type scheduleType,document_date documentDate,
      document_number documentNumber,counterparty,counterparty_vat_number counterpartyVatNumber,
      counterparty_svat_number counterpartySvatNumber,taxable_amount taxableAmount,
      suspended_vat suspendedVat,credit_voucher_number creditVoucherNumber,notes
      FROM svat_schedule_entries WHERE company_id=? AND period_start=? AND period_end=?
      ORDER BY document_date,document_number`, [companyId, start, end]),
    query(`SELECT CONCAT('invoice-',i.id) id,'Output' direction,'SVAT 05' scheduleType,
      i.invoice_date documentDate,i.reference documentNumber,i.client counterparty,
      COALESCE(NULLIF(i.buyer_vat_number,''),c.vat_number) counterpartyVatNumber,
      NULL counterpartySvatNumber,i.gross taxableAmount,i.vat_amount suspendedVat,
      i.svat_voucher creditVoucherNumber,i.notes
      FROM client_invoices i LEFT JOIN clients c ON c.id=i.client_id
      WHERE i.company_id=? AND i.invoice_date BETWEEN ? AND ? AND i.status NOT IN ('Draft','Cancelled')
        AND i.tax_treatment='SVAT' AND i.invoice_date<=? ORDER BY i.invoice_date,i.reference`, [companyId, start, end, SVAT_LAST_DATE])
  ]);
  if (!company) return null;
  const input = [...supplier, ...bills].sort((a, b) => String(a.documentDate).localeCompare(String(b.documentDate)));
  const outputVat = total(output, 'vatAmount');
  const inputVat = total(input, 'vatAmount');
  const outputAdjustment = money(period?.outputAdjustment);
  const inputAdjustment = money(period?.inputAdjustment);
  return {
    company, start, end, basis: 'Invoice date (accrual)',
    period: period || { status: 'Draft', outputAdjustment: 0, inputAdjustment: 0 },
    output, input, historicalSvat: [...invoiceSvat, ...manualSvat].sort((a,b)=>String(a.documentDate).localeCompare(String(b.documentDate))),
    totals: {
      outputTaxable: total(output, 'taxableAmount'), outputVat,
      inputTaxable: total(input, 'taxableAmount'), inputVat,
      adjustedOutputVat: outputVat + outputAdjustment,
      adjustedInputVat: inputVat + inputAdjustment,
      netVatPayable: outputVat + outputAdjustment - inputVat - inputAdjustment
    },
    svatAllowed: end <= SVAT_LAST_DATE,
    svatLastDate: SVAT_LAST_DATE
  };
}

const h = value => ({ value, style: STYLE.HEADER });
const c = value => ({ value, style: STYLE.CELL });
const m = value => ({ value: money(value), style: STYLE.MONEY });
const scheduleRows = rows => rows.map(row => [c(row.documentDate), c(row.documentNumber), c(row.counterparty),
  c(row.counterpartyVatNumber || ''), m(row.taxableAmount), m(row.vatAmount), m(row.totalAmount), c(row.status)]);

export function vatWorkbook(schedule) {
  const outputHeader = ['Date','Invoice number','Customer','Customer VAT number','Taxable value','Output VAT','Invoice total','Status'].map(h);
  const inputHeader = ['Date','Invoice / bill number','Supplier','Supplier VAT number','Taxable value','Input VAT','Document total','Status'].map(h);
  const reconciliation = [
    [h('VAT reconciliation'), h('Amount (LKR)')],
    [c('Output VAT from issued tax invoices'), m(schedule.totals.outputVat)],
    [c('Output adjustment'), m(schedule.period.outputAdjustment)],
    [c('Adjusted output VAT'), m(schedule.totals.adjustedOutputVat)],
    [c('Input VAT from supplier invoices and bills'), m(schedule.totals.inputVat)],
    [c('Input adjustment'), m(schedule.period.inputAdjustment)],
    [c('Adjusted input VAT'), m(schedule.totals.adjustedInputVat)],
    [c('Net VAT payable / (credit)'), m(schedule.totals.netVatPayable)],
    [c('Basis'), c(schedule.basis)], [c('Status'), c(schedule.period.status)],
    [c('Adjustment explanation'), c(schedule.period.adjustmentNote || '')],
    [c('Filing reference'), c(schedule.period.filingReference || '')]
  ];
  const sheets = [
    { name: 'Reconciliation', rows: reconciliation, columns: [44, 22], freeze: 1 },
    { name: 'Output Schedule 01', rows: [outputHeader, ...scheduleRows(schedule.output)], columns: [14,20,28,22,18,18,18,16], freeze: 1 },
    { name: 'Input Schedule 02', rows: [inputHeader, ...scheduleRows(schedule.input)], columns: [14,20,28,22,18,18,18,16], freeze: 1 }
  ];
  if (schedule.historicalSvat.length) sheets.push({ name: 'Historical SVAT', rows: [[
    'Direction','Schedule','Date','Document','Counterparty','VAT number','SVAT number','Taxable value','Suspended VAT','Credit voucher','Notes'
  ].map(h), ...schedule.historicalSvat.map(row => [c(row.direction),c(row.scheduleType),c(row.documentDate),c(row.documentNumber),
    c(row.counterparty),c(row.counterpartyVatNumber || ''),c(row.counterpartySvatNumber || ''),m(row.taxableAmount),m(row.suspendedVat),
    c(row.creditVoucherNumber || ''),c(row.notes || '')])], columns: [12,14,14,18,28,20,20,18,18,20,35], freeze: 1 });
  return writeWorkbook(sheets);
}
