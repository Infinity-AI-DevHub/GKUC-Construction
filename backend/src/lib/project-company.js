import {audit} from '../db.js';
import {quotationIdentity} from './quotation-presentation.js';

// Registers which store project ownership; cash payer and payroll company are separate facts.
export const PROJECT_COMPANY_TABLES = ['tasks','fuel_records','fuel_submissions','vehicle_maintenance','incomes',
  'operating_bills','inquiries','quotations_client','tenders','client_invoices',
  'quotation_billing_plans','received_cheques','bank_bonds',
  'subcontractor_quotations','vehicle_odometer_readings','management_adjustments','cash_outflow_plans'];
const json=value=>typeof value==='string'?JSON.parse(value):value;

/** Called with the project locked, in the same transaction as its update. Also repairs
 * previously mismatched ownership when Edit project saves the existing company again. */
export async function moveProjectCompany(connection,projectId,companyId,userId,ip){
  const changes=[];
  const moved=new Map();
  const move=async(table,where,params)=>{
    const [rows]=await connection.execute(`SELECT id,company_id FROM ${table} WHERE ${where} AND (company_id IS NULL OR company_id<>?) FOR UPDATE`,[...params,companyId]);
    for(const row of rows){
      await connection.execute(`UPDATE ${table} SET company_id=? WHERE id=?`,[companyId,row.id]);
      await audit(connection,userId,'PROJECT_COMPANY_MOVE',table,row.id,{companyId:row.company_id},{companyId,projectId},ip);
    }
    const ids=moved.get(table)||new Set();for(const row of rows)ids.add(Number(row.id));moved.set(table,ids);
    if(rows.length)changes.push({table,count:rows.length});
  };
  // Record the actual payer before changing invoice ownership. Never infer a new payer
  // from an invoice's new company after a project transfer.
  const [payments]=await connection.execute(`SELECT sp.id,si.company_id FROM supplier_payments sp JOIN supplier_invoices si ON si.id=sp.invoice_id
    JOIN purchase_orders po ON po.id=si.order_id WHERE po.project_id=? AND sp.payment_company_id IS NULL FOR UPDATE`,[projectId]);
  for(const payment of payments){
    await connection.execute('UPDATE supplier_payments SET payment_company_id=? WHERE id=?',[payment.company_id,payment.id]);
    await audit(connection,userId,'PROJECT_COMPANY_PAYER', 'supplier_payment',payment.id,{paymentCompanyId:null},{paymentCompanyId:payment.company_id,projectId},ip);
  }
  for(const table of PROJECT_COMPANY_TABLES)await move(table,'project_id=?',[projectId]);
  await move('supplier_invoices','order_id IN (SELECT id FROM purchase_orders WHERE project_id=?)',[projectId]);
  // Quotes can be linked through the inquiry before their own project link is populated.
  await move('quotations_client','inquiry_id IN (SELECT id FROM inquiries WHERE project_id=?)',[projectId]);
  const quoteScope='quotation_id IN (SELECT id FROM quotations_client WHERE project_id=? OR inquiry_id IN (SELECT id FROM inquiries WHERE project_id=?))';
  await move('quotation_billing_plans',quoteScope,[projectId,projectId]);
  await move('client_invoices',quoteScope,[projectId,projectId]);
  const {company}=await quotationIdentity(companyId,null);
  for(const [table,column] of [['quotations_client','presentation'],['client_invoices','invoice_options']]){
    const movedIds=[...(moved.get(table)||[])];
    const [rows]=await connection.execute(`SELECT id,${column} value${table==='quotations_client'?',bank_account_id bankAccountId':''} FROM ${table} WHERE project_id=?${movedIds.length?` OR id IN (${movedIds.map(()=>'?').join(',')})`:''} FOR UPDATE`,[projectId,...movedIds]);
    for(const row of rows){
      const before=json(row.value);
      const ownershipMoved=moved.get(table)?.has(Number(row.id));
      if(!before&&!ownershipMoved)continue;
      const presentation=table==='quotations_client'?before:before?.presentation;
      if(!ownershipMoved&&(!presentation?.company||presentation.company.name===company.name))continue;
      const nextPresentation=presentation?{...presentation,company,bank:null,show:{...presentation.show,company:{...presentation.show?.company,bankDetails:false}}}:null;
      const after=table==='quotations_client'?nextPresentation:{...before,presentation:nextPresentation,bankDetails:''};
      await connection.execute(`UPDATE ${table} SET ${column}=?${table==='quotations_client'?',bank_account_id=NULL':''} WHERE id=?`,[JSON.stringify(after),row.id]);
      await audit(connection,userId,'PROJECT_COMPANY_DOCUMENT',table,row.id,{value:before,bankAccountId:row.bankAccountId??null},{value:after,companyId,projectId},ip);
    }
  }
  return changes;
}
