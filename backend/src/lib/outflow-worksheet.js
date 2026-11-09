import {query,getOne} from '../db.js';
const sum=rows=>Math.round(rows.reduce((n,row)=>n+Number(row.amount||0),0)*100)/100;
export async function outflowWorksheet(companyId,from,to){
  const company=await getOne('SELECT id,name FROM companies WHERE id=?',[companyId]);
  if(!company)return null;
  const [balance,entries,receivables,outstanding]=await Promise.all([
    getOne('SELECT bank_balance bankBalance FROM outflow_worksheet_periods WHERE company_id=? AND from_date=? AND to_date=?',[companyId,from,to]),
    query(`SELECT c.id,c.payee,c.description,c.amount,c.project_id projectId,p.name project,c.company_office companyOffice,
      c.expected_date expectedDate,c.confidence,c.status FROM cash_outflow_plans c LEFT JOIN projects p ON p.id=c.project_id
      WHERE c.company_id=? AND c.source_type IS NULL AND c.status IN ('Planned','Committed') AND c.expected_date BETWEEN ? AND ? ORDER BY c.expected_date,c.id`,[companyId,from,to]),
    query(`SELECT i.id,i.reference,i.client payee,COALESCE(i.due_date,i.invoice_date) dueDate,p.name project,
      GREATEST(0,i.net_payable-COALESCE((SELECT SUM(r.amount) FROM client_receipts r WHERE r.invoice_id=i.id AND r.received_date<=?),0)) amount
      FROM client_invoices i LEFT JOIN projects p ON p.id=i.project_id WHERE i.company_id=? AND i.invoice_date<=?
      AND i.status NOT IN ('Draft','Cancelled') AND COALESCE(i.due_date,i.invoice_date) BETWEEN ? AND ? HAVING amount>0 ORDER BY dueDate,i.id`,[to,companyId,to,from,to]),
    query(`SELECT i.id,'Supplier invoice' source,i.invoice_no reference,s.name payee,COALESCE(i.due_date,i.invoice_date) dueDate,
      GREATEST(0,i.amount-COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.invoice_id=i.id AND sp.paid_date<=?),0)) amount
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.company_id=? AND i.invoice_date<=?
      AND COALESCE(i.due_date,i.invoice_date) BETWEEN ? AND ? HAVING amount>0
      UNION ALL SELECT b.id,'Operating bill',b.reference,b.provider,COALESCE(b.due_date,b.bill_date),b.total_amount
      FROM operating_bills b WHERE b.company_id=? AND b.status<>'Cancelled' AND b.bill_date<=?
      AND (b.paid_date IS NULL OR b.paid_date>?) AND COALESCE(b.due_date,b.bill_date) BETWEEN ? AND ?`,[to,companyId,to,from,to,companyId,to,to,from,to])
  ]);
  return {company,from,to,bankBalance:balance?.bankBalance==null?null:Number(balance.bankBalance),
    entries:entries.map(row=>({...row,amount:Number(row.amount)})),receivables:receivables.map(row=>({...row,amount:Number(row.amount)})),outstanding:outstanding.map(row=>({...row,amount:Number(row.amount)})),
    totals:{cashOutflow:sum(entries),receivables:sum(receivables),outstanding:sum(outstanding)},
    note:'Planning only. Bank balance is manually entered for this exact date range, not a verified bank balance. Cash outflow contains only manually saved planning rows. No planning amount posts income, expenses, payments or accounting balances. Receivables and outstanding use due dates within the range (invoice/bill date when no due date exists), with payments through the To date deducted; overdue items due before From are excluded. Outstanding means supplier invoices and operating bills, not a second cash-outflow posting.'};
}
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>value===null?'Not entered':Number(value).toLocaleString('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2});
export function outflowWorksheetDocument(data){
  const table=(headers,rows)=>`<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">No records in this period.</td></tr>`}</tbody></table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:14mm}body{font:12px Arial;color:#19364a}h1{font-size:23px}h2{margin-top:25px;font-size:17px}table{width:100%;border-collapse:collapse;margin:12px 0;table-layout:fixed}th{background:#173c54;color:white}th,td{padding:8px;border:1px solid #ccd7df;text-align:left;overflow-wrap:anywhere}tr{break-inside:avoid}thead{display:table-header-group}.summary{display:flex;gap:18px}.summary div{flex:1;border:1px solid #ccd7df;padding:12px}.summary strong{display:block;margin-top:8px;font-size:19px}.note{font-size:10px;line-height:1.5}</style></head><body>
  <h1>${esc(data.company.name)} - Expected cash outflows</h1><p>${esc(data.from)} to ${esc(data.to)} | LKR | Planning only</p>
  <div class="summary">${[['Bank balance',data.bankBalance],['Cash outflow',data.totals.cashOutflow],['Receivables',data.totals.receivables],['Outstanding',data.totals.outstanding]].map(([label,value])=>`<div>${label}<strong>${money(value)}</strong></div>`).join('')}</div>
  <h2>Cash outflow plan</h2>${table(['Payee','Purpose','Amount (LKR)','Project / office','Company / office','Expected payment','Confidence'],data.entries.map(r=>[r.payee,r.description,money(r.amount),r.project||'Office',r.companyOffice||data.company.name,r.expectedDate,r.confidence]))}
  <h2>Receivables</h2>${table(['Reference','Client','Due date','Amount (LKR)'],data.receivables.map(r=>[r.reference,r.payee,r.dueDate,money(r.amount)]))}
  <h2>Outstanding</h2>${table(['Source','Reference','Payee','Due date','Amount (LKR)'],data.outstanding.map(r=>[r.source,r.reference,r.payee,r.dueDate,money(r.amount)]))}
  <p class="note">${esc(data.note)}</p></body></html>`;
}
