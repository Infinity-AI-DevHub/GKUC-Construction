import { query } from '../db.js';

const money = value => Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
const date = value => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}` : value ? String(value).slice(0, 10) : null;

/** A liability is represented once, at the most specific recorded stage. */
export async function cashOutflows(companyId) {
  const [bills, invoices, orders, cheques, cards, payroll, plans] = await Promise.all([
    query(`SELECT b.id,b.provider payee,b.bill_type description,b.reference,b.due_date expectedDate,
      b.total_amount amount,b.project_id projectId,p.name project
      FROM operating_bills b LEFT JOIN projects p ON p.id=b.project_id
      WHERE b.company_id=? AND b.status='Unpaid'`, [companyId]),
    query(`SELECT i.id,i.invoice_no reference,i.amount,i.paid_amount paidAmount,i.due_date expectedDate,
      i.order_id orderId,s.name payee,o.project_id projectId,p.name project,
      COALESCE((SELECT SUM(c.amount) FROM issued_cheques c WHERE c.invoice_id=i.id AND c.status='Issued'),0) issuedCheques
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id
      LEFT JOIN purchase_orders o ON o.id=i.order_id LEFT JOIN projects p ON p.id=o.project_id
      WHERE i.company_id=? AND i.status<>'Paid'`, [companyId]),
    query(`SELECT o.id,o.reference,o.total amount,o.status,s.name payee,o.project_id projectId,p.name project,
      COALESCE((SELECT SUM(i.amount) FROM supplier_invoices i WHERE i.order_id=o.id),0) invoiced
      FROM purchase_orders o JOIN projects p ON p.id=o.project_id JOIN suppliers s ON s.id=o.supplier_id
      WHERE p.company_id=? AND o.status<>'Cancelled'`, [companyId]),
    query(`SELECT c.id,c.cheque_number reference,c.payee,c.purpose description,c.amount,
      c.cheque_date expectedDate,i.order_id orderId,o.project_id projectId,p.name project
      FROM issued_cheques c LEFT JOIN supplier_invoices i ON i.id=c.invoice_id
      LEFT JOIN purchase_orders o ON o.id=i.order_id LEFT JOIN projects p ON p.id=o.project_id
      WHERE c.company_id=? AND c.status='Issued'`, [companyId]),
    query(`SELECT s.id,CONCAT(c.name,' ••••',c.last_four) payee,s.statement_date reference,
      s.due_date expectedDate,s.amount,s.paid_amount paidAmount
      FROM credit_card_statements s JOIN company_credit_cards c ON c.id=s.card_id
      WHERE c.company_id=? AND s.status IN ('Unpaid','Partially paid')`, [companyId]),
    query(`SELECT id,reference,total amount,period_end periodEnd,pay_frequency payFrequency
      FROM payroll_runs WHERE company_id=? AND status='Approved'`, [companyId]),
    query(`SELECT id,source_type sourceType,source_id sourceId,project_id projectId,payee,description,
      amount,expected_date expectedDate,confidence,status,notes FROM cash_outflow_plans
      WHERE company_id=?`, [companyId])
  ]);
  const source = (type,row,amount,confidence,status,description,sourceUrl) => ({
    key:`${type}:${row.id}`,sourceType:type,sourceId:Number(row.id),reference:String(row.reference||`#${row.id}`),
    payee:row.payee,description:description||row.description||'',projectId:row.projectId||null,
    project:row.project||null,amount:money(amount),expectedDate:date(row.expectedDate),confidence,status,
    sourceUrl
  });
  const rows = [
    ...bills.map(row=>source('Operating bill',row,row.amount,'High','Unpaid',row.description,'/finance/bills')),
    ...invoices.map(row=>source('Supplier invoice',row,Number(row.amount)-Number(row.paidAmount)-Number(row.issuedCheques),'High','Unpaid','Supplier invoice balance','/finance/supplier-invoices')),
    ...orders.map(row=>source('Purchase order',row,Number(row.amount)-Number(row.invoiced),'Medium',row.status,'Uninvoiced purchase order balance','/materials')),
    ...cheques.map(row=>source('Issued cheque',row,row.amount,'High','Issued',row.description,'/finance/cheques')),
    ...cards.map(row=>source('Credit card',row,Number(row.amount)-Number(row.paidAmount),'High','Unpaid','Card statement balance','/finance/credit-cards')),
    ...payroll.map(row=>source('Payroll',row,row.amount,'High','Approved',`${row.payFrequency} payroll ending ${date(row.periodEnd)}`,'/people/payroll'))
  ].filter(row=>row.amount>0);
  const activePlans=new Map(plans.filter(row=>row.sourceType&&row.status!=='Cancelled').map(row=>[`${row.sourceType}:${row.sourceId}`,row]));
  for(const row of rows){
    const plan=activePlans.get(row.key);
    if(plan){row.expectedDate=date(plan.expectedDate);row.confidence=plan.confidence;row.scheduleId=Number(plan.id);row.scheduleNotes=plan.notes;
      // The source remains authoritative for the amount and payment state.
    }
  }
  for(const plan of plans.filter(row=>!row.sourceType&&row.status!=='Cancelled'&&row.status!=='Paid')){
    rows.push({key:`Plan:${plan.id}`,sourceType:'Planned payment',sourceId:Number(plan.id),scheduleId:Number(plan.id),
      reference:`Plan #${plan.id}`,payee:plan.payee,description:plan.description,projectId:plan.projectId||null,
      project:null,amount:money(plan.amount),expectedDate:date(plan.expectedDate),confidence:plan.confidence,
      status:plan.status,sourceUrl:null,scheduleNotes:plan.notes});
  }
  rows.sort((a,b)=>(a.expectedDate||'9999-12-31').localeCompare(b.expectedDate||'9999-12-31')||a.key.localeCompare(b.key));
  return {entries:rows,total:money(rows.reduce((sum,row)=>sum+(row.expectedDate?row.amount:0),0)),
    unscheduled:money(rows.reduce((sum,row)=>sum+(!row.expectedDate?row.amount:0),0)),
    note:'Only dated items enter the forecast total. Purchase orders show only their uninvoiced balance; issued cheques reduce the linked supplier invoice balance. Paid records are excluded. A scheduled source changes its forecast date, not its amount or payment status.'};
}
