import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, spendSql, transaction } from '../db.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { assertUniqueManualEntry } from '../lib/ledger-duplicates.js';
import { managementPack } from '../lib/management-accounts.js';
import { cashOutflows } from '../lib/cash-outflows.js';
import { cashComparison } from '../lib/cash-comparison.js';
import { SVAT_LAST_DATE, vatSchedule, vatWorkbook } from '../lib/vat-schedules.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const accountPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const companyParam = req => {
  const value = Number(req.query.companyId || 0);
  return Number.isInteger(value) && value > 0 ? value : null;
};

router.get('/cash-comparison',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req),period=String(req.query.period||'');
  if(!companyId||!accountPeriod.safeParse(period).success)return res.status(400).json({error:'Choose a company and a month in YYYY-MM format.'});
  const company=await getOne('SELECT id,name FROM companies WHERE id=?',[companyId]);
  if(!company)return res.status(404).json({error:'Company not found.'});
  res.json({company,...await cashComparison(companyId,period)});
}));

router.put('/cash-comparison/period',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),period:accountPeriod,
  budgetReceipts:z.number().nonnegative().nullable(),budgetPayments:z.number().nonnegative().nullable(),
  openingBalance:z.number().finite().nullable(),verifiedClosingBalance:z.number().finite().nullable(),
  reconciliationAdjustment:z.number().finite().default(0),adjustmentReason:z.string().trim().max(500).nullable().optional(),
  balanceSource:z.string().trim().max(300).nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  if(!await getOne('SELECT id FROM companies WHERE id=?',[b.companyId]))return res.status(404).json({error:'Company not found.'});
  if(b.reconciliationAdjustment&&!b.adjustmentReason?.trim())return res.status(400).json({error:'Explain any reconciliation adjustment before saving it.'});
  if(b.verifiedClosingBalance!==null&&!b.balanceSource?.trim())return res.status(400).json({error:'Name the bank statement or cash count used to verify the closing balance.'});
  const prior=await getOne('SELECT * FROM cash_comparison_periods WHERE company_id=? AND period=?',[b.companyId,b.period]);
  await query(`INSERT INTO cash_comparison_periods
    (company_id,period,budget_receipts,budget_payments,opening_balance,verified_closing_balance,
     reconciliation_adjustment,adjustment_reason,balance_source,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE budget_receipts=VALUES(budget_receipts),
      budget_payments=VALUES(budget_payments),opening_balance=VALUES(opening_balance),
      verified_closing_balance=VALUES(verified_closing_balance),reconciliation_adjustment=VALUES(reconciliation_adjustment),
      adjustment_reason=VALUES(adjustment_reason),balance_source=VALUES(balance_source),updated_by=VALUES(updated_by)`,
    [b.companyId,b.period,b.budgetReceipts,b.budgetPayments,b.openingBalance,b.verifiedClosingBalance,
      b.reconciliationAdjustment,b.adjustmentReason||null,b.balanceSource||null,req.user.id]);
  const after=await getOne('SELECT * FROM cash_comparison_periods WHERE company_id=? AND period=?',[b.companyId,b.period]);
  await audit(pool,req.user.id,prior?'UPDATE':'CREATE','cash_comparison_period',after.id,prior,after,req.ip);
  res.json({id:after.id});
}));

router.get('/expected-outflows',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req);
  if(!companyId)return res.status(400).json({error:'Choose a company to view its expected payments.'});
  const company=await getOne('SELECT id,name FROM companies WHERE id=?',[companyId]);
  if(!company)return res.status(404).json({error:'Company not found.'});
  res.json({company,...await cashOutflows(companyId)});
}));

router.post('/expected-outflows/plans',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),sourceType:z.string().trim().min(2).max(40).nullable().optional(),
  sourceId:z.number().int().positive().nullable().optional(),projectId:z.number().int().positive().nullable().optional(),
  payee:z.string().trim().min(2).max(180).nullable().optional(),description:z.string().trim().min(2).max(400).nullable().optional(),
  amount:z.number().positive().nullable().optional(),expectedDate:isoDate,confidence:z.enum(['High','Medium','Low']),
  notes:z.string().trim().max(600).nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body,linked=!!b.sourceType;
  if(linked!==!!b.sourceId)return res.status(400).json({error:'Choose both a source type and its record, or create a standalone planned payment.'});
  if(!linked&&(!b.payee||!b.description||!b.amount))return res.status(400).json({error:'Enter the payee, purpose and amount for this planned payment.'});
  if(!await getOne('SELECT id FROM companies WHERE id=?',[b.companyId]))return res.status(404).json({error:'Company not found.'});
  if(b.projectId&&!await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',[b.projectId,b.companyId]))
    return res.status(400).json({error:'That project belongs to another company.'});
  if(linked){
    const forecast=await cashOutflows(b.companyId);
    if(!forecast.entries.some(row=>row.sourceType===b.sourceType&&row.sourceId===b.sourceId&&row.sourceType!=='Planned payment'))
      return res.status(404).json({error:'This open payment record was not found in the selected company. Refresh the forecast and try again.'});
    if(b.amount||b.payee||b.description)return res.status(400).json({error:'A linked payment uses the amount and payee from its original record. Edit that record to change them.'});
  }
  const prior=linked?await getOne('SELECT * FROM cash_outflow_plans WHERE company_id=? AND source_type=? AND source_id=?',[b.companyId,b.sourceType,b.sourceId]):null;
  if(prior){
    await query(`UPDATE cash_outflow_plans SET expected_date=?,confidence=?,notes=?,status='Planned' WHERE id=?`,
      [b.expectedDate,b.confidence,b.notes||null,prior.id]);
    await audit(pool,req.user.id,'UPDATE','cash_outflow_plan',prior.id,prior,{...b},req.ip);
    return res.json({id:prior.id});
  }
  const result=await query(`INSERT INTO cash_outflow_plans
    (company_id,source_type,source_id,project_id,payee,description,amount,expected_date,confidence,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[b.companyId,b.sourceType||null,b.sourceId||null,b.projectId||null,
    b.payee||null,b.description||null,b.amount||null,b.expectedDate,b.confidence,b.notes||null,req.user.id]);
  await audit(pool,req.user.id,'CREATE','cash_outflow_plan',result.insertId,null,b,req.ip);
  res.status(201).json({id:result.insertId});
}));

router.patch('/expected-outflows/plans/:id',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),status:z.enum(['Planned','Committed','Paid','Cancelled'])
})),wrap(async(req,res)=>{
  const prior=await getOne('SELECT * FROM cash_outflow_plans WHERE id=? AND company_id=?',[req.params.id,req.body.companyId]);
  if(!prior)return res.status(404).json({error:'Planned payment not found for this company.'});
  if(prior.source_type&&req.body.status!=='Cancelled')return res.status(400).json({error:'Record payment against the original bill, cheque or invoice. This schedule cannot mark it paid.'});
  await query('UPDATE cash_outflow_plans SET status=? WHERE id=?',[req.body.status,prior.id]);
  await audit(pool,req.user.id,'UPDATE','cash_outflow_plan',prior.id,prior,{status:req.body.status},req.ip);
  res.json({id:prior.id,status:req.body.status});
}));

router.patch('/expected-outflows/plans/:id/details',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),projectId:z.number().int().positive().nullable().optional(),
  payee:z.string().trim().min(2).max(180),description:z.string().trim().min(2).max(400),amount:z.number().positive(),
  expectedDate:isoDate,confidence:z.enum(['High','Medium','Low']),notes:z.string().trim().max(600).nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body,prior=await getOne('SELECT * FROM cash_outflow_plans WHERE id=? AND company_id=?',[req.params.id,b.companyId]);
  if(!prior)return res.status(404).json({error:'Planned payment not found for this company.'});
  if(prior.source_type||['Paid','Cancelled'].includes(prior.status))return res.status(409).json({error:'Only open standalone planned payments can be edited here. Edit the original record or create a new plan.'});
  if(b.projectId&&!await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',[b.projectId,b.companyId]))
    return res.status(400).json({error:'That project belongs to another company.'});
  await query(`UPDATE cash_outflow_plans SET project_id=?,payee=?,description=?,amount=?,expected_date=?,confidence=?,notes=? WHERE id=?`,
    [b.projectId||null,b.payee,b.description,b.amount,b.expectedDate,b.confidence,b.notes||null,prior.id]);
  await audit(pool,req.user.id,'UPDATE','cash_outflow_plan',prior.id,prior,b,req.ip);
  res.json({id:prior.id});
}));

router.post('/office-expense-payments',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),paymentDate:isoDate,category:z.string().trim().min(2).max(100),
  payee:z.string().trim().min(2).max(180),paymentMethod:z.enum(['Bank transfer','Card','Cash','Cheque']),
  description:z.string().trim().min(2).max(400),reference:z.string().trim().min(2).max(120),
  amount:z.number().positive()
})),wrap(async(req,res)=>{
  const b=req.body;
  if(!await getOne('SELECT id FROM companies WHERE id=?',[b.companyId]))return res.status(404).json({error:'Company not found.'});
  try{
    const result=await query(`INSERT INTO office_expense_payments
      (company_id,payment_date,category,payee,payment_method,description,reference,amount,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,[b.companyId,b.paymentDate,b.category,b.payee,b.paymentMethod,b.description,b.reference,b.amount,req.user.id]);
    await audit(pool,req.user.id,'CREATE','office_expense_payment',result.insertId,null,b,req.ip);
    res.status(201).json({id:result.insertId});
  }catch(error){if(error.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That office payment reference is already recorded for this company. Open the existing entry instead of entering it twice.'});throw error;}
}));

router.get('/daily-expenses',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req),date=String(req.query.date||'');
  if(!companyId||!isoDate.safeParse(date).success)return res.status(400).json({error:'Choose a company and a valid day.'});
  const [company,petty,supplierPayments,bills,direct,office,unverified]=await Promise.all([
    getOne('SELECT id,name FROM companies WHERE id=?',[companyId]),
    query(`SELECT pe.id,pe.entry_date date,ABS(pe.amount) amount,pe.description,pe.category,
      pe.payee,pf.name floatName,pf.account_type accountType,COALESCE(pe.project_id,pf.project_id) projectId,
      p.name project,pe.fuel_record_id fuelRecordId,fv.vehicle vehicle,fv.registration registration
      FROM petty_cash_entries pe JOIN petty_cash_floats pf ON pf.id=pe.float_id
      LEFT JOIN projects p ON p.id=COALESCE(pe.project_id,pf.project_id)
      LEFT JOIN fuel_records fr ON fr.id=pe.fuel_record_id LEFT JOIN fleet fv ON fv.id=fr.vehicle_id
      WHERE pf.company_id=? AND pe.entry_date=? AND pe.kind='Spend' AND pf.account_type<>'Salary advance'`,[companyId,date]),
    query(`SELECT sp.id,sp.paid_date date,sp.amount,sp.method,sp.reference,si.id invoiceId,
      si.invoice_no invoiceNo,s.name payee,po.project_id projectId,p.name project
      FROM supplier_payments sp JOIN supplier_invoices si ON si.id=sp.invoice_id
      JOIN suppliers s ON s.id=si.supplier_id LEFT JOIN purchase_orders po ON po.id=si.order_id
      LEFT JOIN projects p ON p.id=po.project_id
      WHERE si.company_id=? AND sp.paid_date=?`,[companyId,date]),
    query(`SELECT b.id,b.paid_date date,b.total_amount amount,b.payment_method method,
      b.payment_reference reference,b.provider payee,b.bill_type category,b.project_id projectId,p.name project
      FROM operating_bills b LEFT JOIN projects p ON p.id=b.project_id
      WHERE b.company_id=? AND b.paid_date=? AND b.status='Paid'`,[companyId,date]),
    query(`SELECT e.id,e.paid_date date,e.amount,e.description,e.source,e.payee,e.payment_method method,
      e.reference,e.project_id projectId,p.name project,c.name category
      FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories c ON c.id=e.category_id
      WHERE p.company_id=? AND e.paid_date=? AND e.payment_method IS NOT NULL AND e.origin_type IS NULL`,[companyId,date]),
    query(`SELECT id,payment_date date,amount,description,category,payee,payment_method method,reference
      FROM office_expense_payments WHERE company_id=? AND payment_date=?`,[companyId,date]),
    query(`SELECT COUNT(*) count FROM expenses e JOIN projects p ON p.id=e.project_id
      WHERE p.company_id=? AND e.expense_date=? AND e.origin_type IS NULL AND e.payment_method IS NULL`,[companyId,date])
  ]);
  if(!company)return res.status(404).json({error:'Company not found.'});
  const location=row=>({locationType:row.projectId?'Project site':'Office',projectId:row.projectId||null,
    location:row.project||'Head office'});
  const entries=[
    ...petty.map(row=>({key:`petty:${row.id}`,source:'Petty cash',sourceId:row.id,date:row.date,
      ...location(row),category:row.category||row.accountType,payee:row.payee||'Not recorded',
      paymentMethod:'Petty cash',paymentSource:row.floatName,description:row.description,
      reference:row.fuelRecordId?`Fleet fuel #${row.fuelRecordId}`:`Petty cash #${row.id}`,
      amount:Number(row.amount),sourceUrl:row.fuelRecordId?`/fleet?section=fuel&record=${row.fuelRecordId}`:'/finance/petty-cash'})),
    ...supplierPayments.map(row=>({key:`supplier:${row.id}`,source:'Supplier payment',sourceId:row.id,date:row.date,
      ...location(row),category:'Supplier / material',payee:row.payee,paymentMethod:row.method,
      paymentSource:'Supplier invoice',description:`Payment for ${row.invoiceNo}`,
      reference:row.reference||row.invoiceNo,amount:Number(row.amount),sourceUrl:'/finance/supplier-invoices'})),
    ...bills.map(row=>({key:`bill:${row.id}`,source:'Operating bill',sourceId:row.id,date:row.date,
      ...location(row),category:row.category,payee:row.payee,paymentMethod:row.method||'Not recorded',
      paymentSource:'Bills',description:`Paid ${row.category}`,reference:row.reference||`Bill #${row.id}`,
      amount:Number(row.amount),sourceUrl:'/finance/bills'})),
    ...direct.map(row=>({key:`expense:${row.id}`,source:'Direct expense',sourceId:row.id,date:row.date,
      ...location(row),category:row.category||row.source,payee:row.payee||'Not recorded',
      paymentMethod:row.method,paymentSource:'Direct payment',description:row.description,
      reference:row.reference||`Expense #${row.id}`,amount:Number(row.amount),sourceUrl:`/finance/expenses?record=${row.id}`})),
    ...office.map(row=>({key:`office:${row.id}`,source:'Direct office payment',sourceId:row.id,date:row.date,
      locationType:'Office',projectId:null,location:'Head office',category:row.category,payee:row.payee,
      paymentMethod:row.method,paymentSource:'Office payment',description:row.description,
      reference:row.reference,amount:Number(row.amount),sourceUrl:'/finance/daily-expenses'}))
  ].sort((a,b)=>a.location.localeCompare(b.location)||a.source.localeCompare(b.source)||a.sourceId-b.sourceId);
  res.json({company,date,entries,unverifiedManualExpenses:Number(unverified[0].count),
    total:Math.round(entries.reduce((sum,row)=>sum+row.amount,0)*100)/100,
    note:'Each recorded payment appears once. Linked Fleet fuel and project-cost rows are not counted a second time. Salary advances, float top-ups and card-statement settlements are not operating expenses. Older manual expenses without payment details are excluded until verified.'});
}));

router.get('/management-accounts', auth, permit('finance.view','finance.manage'), wrap(async (req,res) => {
  const companyId=companyParam(req), period=String(req.query.period||'');
  if (!companyId || !accountPeriod.safeParse(period).success) return res.status(400).json({error:'Choose a company and a month in YYYY-MM format.'});
  const latest=await getOne(`SELECT id,version,status,snapshot,close_note closeNote,closed_at closedAt,
    reopen_reason reopenReason FROM management_closes WHERE company_id=? AND period=? ORDER BY version DESC LIMIT 1`,[companyId,period]);
  const live=await managementPack(companyId,period);
  if (!live) return res.status(404).json({error:'Company not found.'});
  res.json({ ...live, close:latest?{id:latest.id,version:latest.version,status:latest.status,
    closeNote:latest.closeNote,closedAt:latest.closedAt,reopenReason:latest.reopenReason}:null,
    ...(latest?.status==='Closed'?{...JSON.parse(typeof latest.snapshot==='string'?latest.snapshot:JSON.stringify(latest.snapshot)),
      close:{id:latest.id,version:latest.version,status:latest.status,closeNote:latest.closeNote,closedAt:latest.closedAt,
        changedSinceClose:JSON.stringify(live)!==JSON.stringify(typeof latest.snapshot==='string'?JSON.parse(latest.snapshot):latest.snapshot)}}:{}) });
}));

router.post('/management-accounts/adjustments',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),period:accountPeriod,
  category:z.enum(['Revenue','Cost','WIP','Receivable','Payable']),amount:z.number().finite().refine(value=>value!==0),
  explanation:z.string().trim().min(10).max(600),reference:z.string().trim().min(2).max(120),
  projectId:z.number().int().positive().nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  if(!await getOne('SELECT id FROM companies WHERE id=?',[b.companyId]))return res.status(404).json({error:'Company not found.'});
  if(b.projectId&&!await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',[b.projectId,b.companyId]))
    return res.status(400).json({error:'The selected project belongs to another company.'});
  const close=await getOne(`SELECT status FROM management_closes WHERE company_id=? AND period=? ORDER BY version DESC LIMIT 1`,[b.companyId,b.period]);
  if(close?.status==='Closed')return res.status(409).json({error:'This month is closed. Reopen it with a reason before adding a management adjustment.'});
  const result=await query(`INSERT INTO management_adjustments
    (company_id,period,category,amount,explanation,reference,project_id,created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [b.companyId,b.period,b.category,b.amount,b.explanation,b.reference,b.projectId||null,req.user.id]);
  await audit(pool,req.user.id,'CREATE','management_adjustment',result.insertId,null,b,req.ip);
  res.status(201).json({id:result.insertId});
}));

router.post('/management-accounts/close',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),period:accountPeriod,note:z.string().trim().min(10).max(600)
})),wrap(async(req,res)=>{
  const {companyId,period,note}=req.body;
  const pack=await managementPack(companyId,period);
  if(!pack)return res.status(404).json({error:'Company not found.'});
  if(!pack.reconciliation.balanced)return res.status(409).json({error:'The invoice, receipt or payable totals do not reconcile. Review the reconciliation checks before closing this month.'});
  const result=await transaction(async connection=>{
    const [rows]=await connection.execute(`SELECT id,version,status FROM management_closes
      WHERE company_id=? AND period=? ORDER BY version DESC LIMIT 1 FOR UPDATE`,[companyId,period]);
    if(rows[0]?.status==='Closed')throw Object.assign(new Error('This month is already closed. Reopen it with a reason before closing it again.'),{status:409});
    const version=(rows[0]?.version||0)+1;
    const [inserted]=await connection.execute(`INSERT INTO management_closes
      (company_id,period,version,snapshot,close_note,closed_by) VALUES (?,?,?,?,?,?)`,
      [companyId,period,version,JSON.stringify(pack),note,req.user.id]);
    await audit(connection,req.user.id,'PERIOD_CLOSE','management_close',inserted.insertId,null,{companyId,period,version,note},req.ip);
    return {id:inserted.insertId,version};
  });
  res.status(201).json({...result,status:'Closed'});
}));

router.post('/management-accounts/reopen',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),period:accountPeriod,reason:z.string().trim().min(10).max(600)
})),wrap(async(req,res)=>{
  const {companyId,period,reason}=req.body;
  const result=await transaction(async connection=>{
    const [rows]=await connection.execute(`SELECT id,version,status FROM management_closes
      WHERE company_id=? AND period=? ORDER BY version DESC LIMIT 1 FOR UPDATE`,[companyId,period]);
    if(rows[0]?.status!=='Closed')throw Object.assign(new Error('This month is not closed.'),{status:409});
    await connection.execute(`UPDATE management_closes SET status='Reopened',reopen_reason=?,reopened_by=?,reopened_at=NOW() WHERE id=?`,[reason,req.user.id,rows[0].id]);
    await audit(connection,req.user.id,'PERIOD_REOPEN','management_close',rows[0].id,rows[0],{reason},req.ip);
    return {id:rows[0].id,version:rows[0].version};
  });res.json({...result,status:'Reopened'});
}));

/* Office and site utilities are payable documents first and expenses only when paid. */
router.get('/bills', auth, permit('finance.view','finance.manage'), wrap(async (req,res)=>{
  const companyId=companyParam(req);
  res.json(await query(`SELECT b.id,b.company_id companyId,b.project_id projectId,p.name project,b.bill_type billType,
    b.provider,b.account_number accountNumber,b.reference,b.period_from periodFrom,b.period_to periodTo,
    b.bill_date billDate,b.due_date dueDate,b.net_amount netAmount,b.tax_treatment taxTreatment,
    b.vat_rate vatRate,b.vat_amount vatAmount,b.total_amount totalAmount,b.reminder_days reminderDays,
    b.status,b.paid_date paidDate,b.payment_method paymentMethod,b.payment_reference paymentReference,b.notes,
    DATEDIFF(b.due_date,CURDATE()) daysUntil FROM operating_bills b LEFT JOIN projects p ON p.id=b.project_id
    ${companyId?'WHERE b.company_id=?':''} ORDER BY b.due_date DESC,b.id DESC`,companyId?[companyId]:[]));
}));

const billSchema=z.object({companyId:z.number().int().positive().default(1),projectId:z.number().int().positive().nullable().optional(),
  billType:z.string().trim().min(2).max(80),provider:z.string().trim().min(2).max(180),accountNumber:z.string().max(100).optional(),
  reference:z.string().trim().min(1).max(100),periodFrom:isoDate.optional(),periodTo:isoDate.optional(),billDate:isoDate,dueDate:isoDate,
  netAmount:z.number().positive(),taxTreatment:z.enum(['Standard','Exempt']).default('Standard'),vatRate:z.number().min(0).max(100).default(0),
  reminderDays:z.number().int().min(0).max(90).default(5),notes:z.string().max(600).optional()});

router.post('/bills',auth,permit('finance.manage'),validate(billSchema),wrap(async(req,res)=>{
  const b=req.body;if(b.dueDate<b.billDate)return res.status(400).json({error:'Due date cannot be before the bill date'});
  if(b.projectId&&!await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',[b.projectId,b.companyId]))
    return res.status(400).json({error:'That project belongs to the other company'});
  const vat=b.taxTreatment==='Standard'?Math.round(b.netAmount*b.vatRate)/100:0,total=Math.round((b.netAmount+vat)*100)/100;
  try{const result=await query(`INSERT INTO operating_bills
    (company_id,project_id,bill_type,provider,account_number,reference,period_from,period_to,bill_date,due_date,
     net_amount,tax_treatment,vat_rate,vat_amount,total_amount,reminder_days,notes,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[b.companyId,b.projectId||null,b.billType,b.provider,b.accountNumber||null,b.reference,
      b.periodFrom||null,b.periodTo||null,b.billDate,b.dueDate,b.netAmount,b.taxTreatment,b.taxTreatment==='Standard'?b.vatRate:0,
      vat,total,b.reminderDays,b.notes||null,req.user.id]);
    res.status(201).json({id:result.insertId,totalAmount:total,vatAmount:vat});
  }catch(error){if(error.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That provider bill is already recorded'});throw error;}
}));

router.post('/bills/:id/pay',auth,permit('finance.manage'),validate(z.object({paidDate:isoDate,method:z.string().min(2).max(60),reference:z.string().max(120).optional()})),wrap(async(req,res)=>{
  await transaction(async connection=>{
    const [[bill]]=await connection.execute('SELECT * FROM operating_bills WHERE id=? FOR UPDATE',[req.params.id]);
    if(!bill)throw Object.assign(new Error('Bill not found'),{status:404});
    if(bill.status==='Paid')throw Object.assign(new Error('That bill is already paid'),{status:409});
    await connection.execute(`UPDATE operating_bills SET status='Paid',paid_date=?,payment_method=?,payment_reference=? WHERE id=?`,
      [req.body.paidDate,req.body.method,req.body.reference||null,bill.id]);
    if(bill.project_id) await connection.execute(`INSERT INTO expenses
      (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
      VALUES (?,'Overhead',?,?,?,?, 'operating_bill',?,?)`,[bill.project_id,`${bill.bill_type} — ${bill.provider}`,bill.total_amount,
        req.body.paidDate,bill.reference,String(bill.id),req.user.id]);
    await audit(connection,req.user.id,'PAYMENT','operating_bill',bill.id,bill,{status:'Paid',...req.body},req.ip);
  });res.status(201).json({paid:true});
}));

router.get('/credit-cards',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req);
  const cards=await query(`SELECT c.id,c.company_id companyId,c.name,c.bank,c.last_four lastFour,c.cardholder,c.credit_limit creditLimit,
    c.default_reminder_days defaultReminderDays,c.active FROM company_credit_cards c ${companyId?'WHERE c.company_id=?':''} ORDER BY c.name`,companyId?[companyId]:[]);
  const statements=await query(`SELECT s.id,s.card_id cardId,c.name card,c.bank,c.last_four lastFour,s.statement_date statementDate,
    s.period_from periodFrom,s.period_to periodTo,s.due_date dueDate,s.amount,s.minimum_due minimumDue,s.paid_amount paidAmount,
    s.reminder_days reminderDays,s.status,s.notes,DATEDIFF(s.due_date,CURDATE()) daysUntil
    FROM credit_card_statements s JOIN company_credit_cards c ON c.id=s.card_id ${companyId?'WHERE c.company_id=?':''}
    ORDER BY s.due_date DESC,s.id DESC`,companyId?[companyId]:[]);res.json({cards,statements});
}));

router.post('/credit-cards',auth,permit('finance.manage'),validate(z.object({companyId:z.number().int().positive().default(1),name:z.string().min(2).max(120),
  bank:z.string().min(2).max(180),lastFour:z.string().regex(/^\d{4}$/),cardholder:z.string().min(2).max(180),creditLimit:z.number().nonnegative().default(0),
  defaultReminderDays:z.number().int().min(0).max(90).default(5)})),wrap(async(req,res)=>{const b=req.body;const result=await query(`INSERT INTO company_credit_cards
    (company_id,name,bank,last_four,cardholder,credit_limit,default_reminder_days,created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [b.companyId,b.name,b.bank,b.lastFour,b.cardholder,b.creditLimit,b.defaultReminderDays,req.user.id]);res.status(201).json({id:result.insertId});}));

router.post('/credit-card-statements',auth,permit('finance.manage'),validate(z.object({cardId:z.number().int().positive(),statementDate:isoDate,
  periodFrom:isoDate.optional(),periodTo:isoDate.optional(),dueDate:isoDate,amount:z.number().positive(),minimumDue:z.number().nonnegative().default(0),
  reminderDays:z.number().int().min(0).max(90).optional(),notes:z.string().max(600).optional()})),wrap(async(req,res)=>{const b=req.body;
  const card=await getOne('SELECT * FROM company_credit_cards WHERE id=? AND active=1',[b.cardId]);if(!card)return res.status(404).json({error:'Credit card not found'});
  if(b.dueDate<b.statementDate)return res.status(400).json({error:'Due date cannot be before statement date'});
  const result=await query(`INSERT INTO credit_card_statements
    (card_id,statement_date,period_from,period_to,due_date,amount,minimum_due,reminder_days,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.cardId,b.statementDate,b.periodFrom||null,b.periodTo||null,b.dueDate,b.amount,b.minimumDue,b.reminderDays??card.default_reminder_days,b.notes||null,req.user.id]);res.status(201).json({id:result.insertId});}));

router.post('/credit-card-statements/:id/payments',auth,permit('finance.manage'),validate(z.object({amount:z.number().positive(),paidDate:isoDate,
  method:z.string().min(2).max(60).default('Bank transfer'),reference:z.string().max(120).optional()})),wrap(async(req,res)=>{const result=await transaction(async connection=>{
  const [rows]=await connection.execute('SELECT * FROM credit_card_statements WHERE id=? FOR UPDATE',[req.params.id]);const s=rows[0];
  if(!s)throw Object.assign(new Error('Statement not found'),{status:404});const paid=Number(s.paid_amount)+req.body.amount;
  if(paid>Number(s.amount)+.001)throw Object.assign(new Error('Payment exceeds the statement balance'),{status:409});
  const status=paid>=Number(s.amount)-.001?'Paid':'Partially paid';await connection.execute('UPDATE credit_card_statements SET paid_amount=?,status=? WHERE id=?',[paid,status,s.id]);
  await connection.execute('INSERT INTO credit_card_payments (statement_id,amount,paid_date,method,reference,created_by) VALUES (?,?,?,?,?,?)',
    [s.id,req.body.amount,req.body.paidDate,req.body.method,req.body.reference||null,req.user.id]);return{paidAmount:paid,status};});res.status(201).json(result);
}));

/* Older dashboard clients asked for the whole ledger without a range. Keep that read-only
   view working while the tax workspace always sends an explicit filing period. */
const vatRange = req => ({ start: String(req.query.start || '1900-01-01'), end: String(req.query.end || '2999-12-31') });
router.get('/vat',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req),{start,end}=vatRange(req);
  if(!companyId||!isoDate.safeParse(start).success||!isoDate.safeParse(end).success||start>end)
    return res.status(400).json({error:'Choose a company and a valid VAT period.'});
  const schedule=await vatSchedule(companyId,start,end);
  if(!schedule)return res.status(404).json({error:'Company not found.'});
  res.json({...schedule,outputVat:schedule.totals.outputVat,inputVat:schedule.totals.inputVat,
    netVatPayable:schedule.totals.netVatPayable,entries:[
      ...schedule.output.map(row=>({...row,date:row.documentDate,reference:row.documentNumber,netAmount:row.taxableAmount,direction:'Output'})),
      ...schedule.input.map(row=>({...row,date:row.documentDate,reference:row.documentNumber,netAmount:row.taxableAmount,direction:'Input'}))
    ].sort((a,b)=>String(b.date).localeCompare(String(a.date)))});
}));

router.put('/vat/period',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),start:isoDate,end:isoDate,
  status:z.enum(['Draft','Reconciled','Filed']).default('Draft'),
  outputAdjustment:z.number().finite().default(0),inputAdjustment:z.number().finite().default(0),
  adjustmentNote:z.string().trim().max(600).nullable().optional(),
  filingReference:z.string().trim().max(160).nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  if(b.start>b.end)return res.status(400).json({error:'The VAT period end cannot be before its start.'});
  if((b.outputAdjustment||b.inputAdjustment)&&!b.adjustmentNote)
    return res.status(400).json({error:'Explain every manual VAT adjustment before reconciling the period.'});
  if(b.status==='Filed'&&!b.filingReference)
    return res.status(400).json({error:'Enter the filing reference before marking this period as filed.'});
  if(!await getOne('SELECT id FROM companies WHERE id=?',[b.companyId]))return res.status(404).json({error:'Company not found.'});
  const prior=await getOne('SELECT * FROM vat_periods WHERE company_id=? AND period_start=? AND period_end=?',[b.companyId,b.start,b.end]);
  if(prior?.status==='Filed'&&b.status!=='Filed')return res.status(409).json({error:'A filed VAT period cannot be reopened from this screen. Record a correcting adjustment in a new period.'});
  await query(`INSERT INTO vat_periods
    (company_id,period_start,period_end,status,output_adjustment,input_adjustment,adjustment_note,filing_reference,
     updated_by,reconciled_at,filed_at) VALUES (?,?,?,?,?,?,?,?,?,IF(? IN ('Reconciled','Filed'),NOW(),NULL),IF(?='Filed',NOW(),NULL))
    ON DUPLICATE KEY UPDATE status=VALUES(status),output_adjustment=VALUES(output_adjustment),
      input_adjustment=VALUES(input_adjustment),adjustment_note=VALUES(adjustment_note),filing_reference=VALUES(filing_reference),
      updated_by=VALUES(updated_by),reconciled_at=IF(VALUES(status) IN ('Reconciled','Filed'),COALESCE(reconciled_at,NOW()),NULL),
      filed_at=IF(VALUES(status)='Filed',COALESCE(filed_at,NOW()),NULL)`,
    [b.companyId,b.start,b.end,b.status,b.outputAdjustment,b.inputAdjustment,b.adjustmentNote||null,
      b.filingReference||null,req.user.id,b.status,b.status]);
  const after=await getOne('SELECT * FROM vat_periods WHERE company_id=? AND period_start=? AND period_end=?',[b.companyId,b.start,b.end]);
  await audit(pool,req.user.id,prior?'UPDATE':'CREATE','vat_period',after.id,prior,after,req.ip);
  res.json(await vatSchedule(b.companyId,b.start,b.end));
}));

router.get('/vat/export',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{
  const companyId=companyParam(req),{start,end}=vatRange(req);
  if(!companyId||!isoDate.safeParse(start).success||!isoDate.safeParse(end).success||start>end)
    return res.status(400).json({error:'Choose a valid company VAT period before exporting.'});
  const schedule=await vatSchedule(companyId,start,end);
  if(!schedule)return res.status(404).json({error:'Company not found.'});
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="VAT-${start}-to-${end}.xlsx"`);
  res.send(vatWorkbook(schedule));
}));

router.post('/vat/svat-entries',auth,permit('finance.manage'),validate(z.object({
  companyId:z.number().int().positive(),periodStart:isoDate,periodEnd:isoDate,
  direction:z.enum(['Output','Input']),scheduleType:z.enum(['SVAT 05','SVAT 05a','SVAT 05b','SVAT 06','SVAT 07']),
  documentDate:isoDate,documentNumber:z.string().trim().min(1).max(120),counterparty:z.string().trim().min(2).max(180),
  counterpartyVatNumber:z.string().trim().max(100).nullable().optional(),counterpartySvatNumber:z.string().trim().max(100).nullable().optional(),
  taxableAmount:z.number().nonnegative(),suspendedVat:z.number().nonnegative(),creditVoucherNumber:z.string().trim().max(120).nullable().optional(),
  notes:z.string().trim().max(600).nullable().optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  if(b.periodStart>b.periodEnd||b.documentDate<b.periodStart||b.documentDate>b.periodEnd)
    return res.status(400).json({error:'The document date must fall inside the selected SVAT period.'});
  if(b.periodEnd>SVAT_LAST_DATE)return res.status(409).json({error:'SVAT schedules are historical only. Sri Lanka repealed SVAT from 1 October 2025; choose a period ending on or before 30 September 2025.'});
  try{
    const result=await query(`INSERT INTO svat_schedule_entries
      (company_id,period_start,period_end,direction,schedule_type,document_date,document_number,counterparty,
       counterparty_vat_number,counterparty_svat_number,taxable_amount,suspended_vat,credit_voucher_number,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[b.companyId,b.periodStart,b.periodEnd,b.direction,b.scheduleType,b.documentDate,
      b.documentNumber,b.counterparty,b.counterpartyVatNumber||null,b.counterpartySvatNumber||null,b.taxableAmount,b.suspendedVat,
      b.creditVoucherNumber||null,b.notes||null,req.user.id]);
    const row=await getOne('SELECT * FROM svat_schedule_entries WHERE id=?',[result.insertId]);
    await audit(pool,req.user.id,'CREATE','svat_schedule_entry',row.id,null,row,req.ip);
    res.status(201).json(row);
  }catch(error){if(error.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That SVAT document is already recorded for this company.'});throw error;}
}));

router.get('/categories', auth, permit('finance.view', 'finance.manage'),
  wrap(async (_req, res) => res.json(await query('SELECT id,name FROM expense_categories ORDER BY name'))));

router.post('/categories', auth, permit('finance.manage'), validate(z.object({ name: z.string().min(2).max(120) })), wrap(async (req, res) => {
  const result = await query('INSERT INTO expense_categories (name) VALUES (?)', [req.body.name]);
  res.status(201).json(await getOne('SELECT * FROM expense_categories WHERE id=?', [result.insertId]));
}));

router.get('/expenses', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  const companyId = companyParam(req);
  if (companyId) { filters.push('p.company_id=?'); params.push(companyId); }
  if (req.query.projectId) { filters.push('e.project_id=?'); params.push(req.query.projectId); }
  if (req.query.from) { filters.push('e.expense_date>=?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('e.expense_date<=?'); params.push(req.query.to); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT e.id,e.description,e.amount,e.expense_date expenseDate,e.source,e.reference,e.origin_type originType,
    e.payee,e.payment_method paymentMethod,e.paid_date paidDate,
    e.origin_id originId,dcl.sheet_id dailySheetId,p.name project,e.project_id projectId,c.name category,u.name recordedBy
    FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories c ON c.id=e.category_id
    LEFT JOIN daily_cost_lines dcl ON e.origin_type='daily_cost_line' AND dcl.id=CAST(e.origin_id AS UNSIGNED)
    JOIN users u ON u.id=e.created_by ${where} ORDER BY e.expense_date DESC,e.id DESC LIMIT 300`, params));
}));

router.post('/expenses', auth, permit('finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  categoryId: z.number().int().positive().optional(),
  source: z.string().trim().min(1).max(60).default('Other'),
  description: z.string().min(2).max(400),
  amount: z.number().positive(),
  expenseDate: isoDate,
  reference: z.string().max(120).optional(),
  payee: z.string().trim().max(180).optional(),
  paymentMethod: z.enum(['Bank transfer','Card','Cash','Cheque']).optional(),
  paidDate: isoDate.optional()
})), fromOptions({ source: 'expense.source' }), wrap(async (req, res) => {
  const body = req.body;
  if(body.paymentMethod&&!body.payee)return res.status(400).json({error:'Enter who was paid for this direct expense.'});
  if(body.paidDate&&!body.paymentMethod)return res.status(400).json({error:'Choose a payment method when entering a paid date.'});
  const result = await transaction(async connection => {
    await assertUniqueManualEntry(connection, 'expenses', { projectId: body.projectId, reference: body.reference,
      amount: body.amount, date: body.expenseDate, description: body.description });
    const [inserted] = await connection.execute(`INSERT INTO expenses (project_id,category_id,source,description,amount,expense_date,reference,payee,payment_method,paid_date,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [body.projectId, body.categoryId || null, body.source, body.description, body.amount,
      body.expenseDate, body.reference?.trim() || null, body.payee||null,body.paymentMethod||null,
      body.paymentMethod?(body.paidDate||body.expenseDate):null,req.user.id]);
    return inserted;
  });
  const row = await getOne('SELECT * FROM expenses WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'expense', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/expenses/:id/payment',auth,permit('finance.manage'),validate(z.object({
  payee:z.string().trim().min(2).max(180),paymentMethod:z.enum(['Bank transfer','Card','Cash','Cheque']),
  paidDate:isoDate,reference:z.string().max(120).optional()
})),wrap(async(req,res)=>{
  const updated=await transaction(async connection=>{
    const [[row]]=await connection.execute(`SELECT e.*,p.company_id companyId FROM expenses e
      JOIN projects p ON p.id=e.project_id WHERE e.id=? FOR UPDATE`,[req.params.id]);
    if(!row)throw Object.assign(new Error('Expense not found.'),{status:404});
    if(row.origin_type)throw Object.assign(new Error('This expense comes from another module. Record its payment in the source record, not here.'),{status:409});
    if(row.payment_method)throw Object.assign(new Error('Payment details are already recorded for this expense.'),{status:409});
    await connection.execute(`UPDATE expenses SET payee=?,payment_method=?,paid_date=?,reference=COALESCE(?,reference) WHERE id=?`,
      [req.body.payee,req.body.paymentMethod,req.body.paidDate,req.body.reference||null,row.id]);
    await audit(connection,req.user.id,'PAYMENT','expense',row.id,row,req.body,req.ip);
    return row.id;
  });
  res.json({id:updated,paymentRecorded:true});
}));

router.get('/income', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const filters = []; const params = [];
  const companyId = companyParam(req);
  if (companyId) { filters.push('i.company_id=?'); params.push(companyId); }
  if (req.query.projectId) { filters.push('i.project_id=?'); params.push(req.query.projectId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT i.id,i.description,i.amount,i.received_date receivedDate,i.method,i.reference,
    i.origin_type originType,i.origin_id originId,ci.id invoiceId,p.name project,i.project_id projectId,u.name recordedBy
    FROM incomes i LEFT JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by
    LEFT JOIN client_receipts cr ON i.origin_type='client_receipt' AND cr.id=CAST(i.origin_id AS UNSIGNED)
    LEFT JOIN client_invoices ci ON ci.id=cr.invoice_id ${where}
    ORDER BY i.received_date DESC,i.id DESC LIMIT 300`, params));
}));

router.post('/income', auth, permit('finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  description: z.string().min(2).max(400),
  amount: z.number().positive(),
  receivedDate: isoDate,
  method: z.string().trim().min(1).max(60).default('Bank transfer'),
  reference: z.string().max(120).optional()
})), fromOptions({ method: 'income.method' }), wrap(async (req, res) => {
  const body = req.body;
  if (body.method === 'Cheque') return res.status(400).json({ error: 'Record cheques in Received cheques so clearing is tracked once' });
  const result = await transaction(async connection => {
    await assertUniqueManualEntry(connection, 'incomes', { projectId: body.projectId, reference: body.reference,
      amount: body.amount, date: body.receivedDate, description: body.description });
    const [[project]] = await connection.execute('SELECT company_id FROM projects WHERE id=?', [body.projectId]);
    if (!project) throw Object.assign(new Error('Choose an existing project'), { status: 400 });
    const [inserted] = await connection.execute('INSERT INTO incomes (project_id,company_id,description,amount,received_date,method,reference,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [body.projectId, project.company_id, body.description, body.amount, body.receivedDate, body.method, body.reference?.trim() || null, req.user.id]);
    return inserted;
  });
  const row = await getOne('SELECT * FROM incomes WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'income', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

/**
 * Budget monitoring (PID 2.10): every project's approved budget beside what has actually
 * been spent and received, so an overrun is visible while it can still be acted on.
 */
router.get('/summary', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const companyId = companyParam(req);
  const companyWhere = companyId ? 'AND p.company_id=?' : '';
  const companyParams = companyId ? [companyId] : [];
  const projects = await query(`SELECT p.id projectId,p.name project,p.budget,p.progress,p.health,
    ${spendSql('p')} expenses,
    COALESCE((SELECT SUM(i.amount) FROM incomes i WHERE i.project_id=p.id),0) income
    FROM projects p WHERE p.active=1 ${companyWhere} ORDER BY p.id`, companyParams);
  const bySource = await query(`SELECT e.source,COALESCE(SUM(e.amount),0) total FROM expenses e
    JOIN projects p ON p.id=e.project_id ${companyId ? 'WHERE p.company_id=?' : ''} GROUP BY e.source`, companyParams);
  const monthly = await query(`SELECT DATE_FORMAT(month_start,'%Y-%m') month,
      COALESCE(SUM(expense),0) expenses, COALESCE(SUM(income),0) income FROM (
      SELECT DATE_FORMAT(e.expense_date,'%Y-%m-01') month_start, e.amount expense, 0 income FROM expenses e
        JOIN projects ep ON ep.id=e.project_id ${companyId ? 'WHERE ep.company_id=?' : ''}
      UNION ALL
      SELECT DATE_FORMAT(i.received_date,'%Y-%m-01') month_start, 0 expense, i.amount income FROM incomes i
        LEFT JOIN projects ip ON ip.id=i.project_id ${companyId ? 'WHERE COALESCE(i.company_id,ip.company_id)=?' : ''}
    ) ledger WHERE month_start >= DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'), INTERVAL 5 MONTH)
    GROUP BY month_start ORDER BY month_start`, companyId ? [companyId, companyId] : []);
  const payable = await getOne(`SELECT COALESCE(SUM(amount-paid_amount),0) outstanding,
    COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN amount-paid_amount ELSE 0 END),0) overdue
    FROM supplier_invoices WHERE status<>'Paid' ${companyId ? 'AND company_id=?' : ''}`, companyParams);
  const operating = await getOne(`SELECT COALESCE(SUM(CASE WHEN status='Paid' THEN total_amount ELSE 0 END),0) paid,
    COALESCE(SUM(CASE WHEN status='Unpaid' THEN total_amount ELSE 0 END),0) outstanding,
    COALESCE(SUM(CASE WHEN status='Unpaid' AND due_date<CURDATE() THEN total_amount ELSE 0 END),0) overdue
    FROM operating_bills ${companyId?'WHERE company_id=?':''}`,companyParams);

  const totals = projects.reduce((sum, row) => ({
    budget: sum.budget + Number(row.budget),
    expenses: sum.expenses + Number(row.expenses),
    income: sum.income + Number(row.income)
  }), { budget: 0, expenses: 0, income: 0 });
  const officeBills = await getOne(`SELECT COALESCE(SUM(total_amount),0) paid FROM operating_bills WHERE project_id IS NULL AND status='Paid' ${companyId?'AND company_id=?':''}`, companyParams);
  totals.expenses+=Number(officeBills.paid);
  const companyIncome = await getOne(`SELECT COALESCE(SUM(amount),0) total FROM incomes
    WHERE project_id IS NULL ${companyId ? 'AND company_id=?' : ''}`, companyParams);
  totals.income += Number(companyIncome.total);
  payable.outstanding=Number(payable.outstanding)+Number(operating.outstanding);
  payable.overdue=Number(payable.overdue)+Number(operating.overdue);
  if(Number(officeBills.paid)>0)bySource.push({source:'Office and utility bills',total:officeBills.paid});

  res.json({
    projects: projects.map(row => ({
      ...row,
      variance: Number(row.budget) - Number(row.expenses),
      used: Number(row.budget) ? (Number(row.expenses) / Number(row.budget)) * 100 : 0,
      profit: Number(row.income) - Number(row.expenses)
    })),
    bySource,
    monthly,
    payable,
    totals: { ...totals, profit: totals.income - totals.expenses }
  });
}));

/**
 * One reconciled reporting feed for the finance cockpit. Every schedule is scoped with the
 * same project and date rules so the company view and a single project's view can be compared
 * without silently changing the accounting population between reports.
 */
router.get('/reporting', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const requestedProject = req.query.projectId && req.query.projectId !== 'all'
    ? Number(req.query.projectId) : null;
  const companyId = companyParam(req);
  if ((from && !isoDate.safeParse(from).success) || (to && !isoDate.safeParse(to).success))
    return res.status(400).json({ error: 'Dates must use YYYY-MM-DD' });
  if (requestedProject !== null && (!Number.isInteger(requestedProject) || requestedProject < 1))
    return res.status(400).json({ error: 'Project is invalid' });

  const scoped = (projectExpression, dateExpression, companyExpression = null) => {
    const filters = []; const params = [];
    if (companyId) {
      filters.push(companyExpression
        ? `${companyExpression}=?`
        : `EXISTS (SELECT 1 FROM projects company_project WHERE company_project.id=${projectExpression} AND company_project.company_id=?)`);
      params.push(companyId);
    }
    if (requestedProject !== null) { filters.push(`${projectExpression}=?`); params.push(requestedProject); }
    if (from && dateExpression) { filters.push(`${dateExpression}>=?`); params.push(from); }
    if (to && dateExpression) { filters.push(`${dateExpression}<=?`); params.push(to); }
    return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
  };
  const e = scoped('e.project_id', 'e.expense_date');
  const i = scoped('i.project_id', 'i.received_date', 'COALESCE(i.company_id,p.company_id)');
  const ci = scoped('ci.project_id', 'ci.invoice_date', 'ci.company_id');
  const cr = scoped('ci.project_id', 'cr.received_date', 'ci.company_id');
  const po = scoped('po.project_id', 'po.order_date');
  const si = scoped('po.project_id', 'si.invoice_date', 'si.company_id');
  const sp = scoped('po.project_id', 'sp.paid_date', 'si.company_id');
  const pc = scoped('COALESCE(pce.project_id,pcf.project_id)', 'pce.entry_date', 'pcf.company_id');
  const rt = scoped('r.project_id', 'r.held_from');
  const bb = scoped('b.project_id', 'b.issued_date', 'b.company_id');
  const vo = scoped('v.project_id', 'DATE(v.created_at)');
  const projectOnly = scoped('p.id', null, 'p.company_id');
  const costProject = scoped('b.project_id', null);

  const [projects, expenses, incomes, clientInvoices, clientReceipts, purchaseOrders,
    supplierInvoices, supplierPayments, pettyCash, retentions, bonds, variations,
    boqSummary, forecasts, costItems, payroll, acceptedQuotations, approvedVariationsAll] = await Promise.all([
    query(`SELECT p.id,p.name,p.client,p.site,p.budget,p.progress,p.health,p.stage,p.company_id companyId
      FROM projects p ${projectOnly.where} ORDER BY p.name`, projectOnly.params),
    query(`SELECT e.id,e.project_id projectId,p.name project,e.expense_date date,e.description,
      e.amount,e.source,COALESCE(ec.name,'Uncategorised') category,e.cost_type costType,
      e.reference,e.boq_item_id boqItemId
      FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories ec ON ec.id=e.category_id
      ${e.where} ORDER BY e.expense_date,e.id`, e.params),
    query(`SELECT i.id,i.project_id projectId,p.name project,i.received_date date,i.description,
      i.amount,i.method,i.reference FROM incomes i LEFT JOIN projects p ON p.id=i.project_id
      ${i.where} ORDER BY i.received_date,i.id`, i.params),
    query(`SELECT ci.id,ci.project_id projectId,p.name project,ci.reference,ci.client,ci.kind,
      ci.invoice_date invoiceDate,ci.due_date dueDate,ci.gross,ci.vat_amount vatAmount,
      ci.retention_amount retentionAmount,ci.advance_recovery advanceRecovery,
      ci.other_deductions otherDeductions,ci.net_payable netPayable,ci.paid_amount paidAmount,ci.status
      FROM client_invoices ci LEFT JOIN projects p ON p.id=ci.project_id ${ci.where}
      ORDER BY ci.invoice_date,ci.id`, ci.params),
    query(`SELECT cr.id,ci.project_id projectId,p.name project,ci.reference invoiceReference,
      cr.received_date date,cr.amount,cr.method,cr.reference
      FROM client_receipts cr JOIN client_invoices ci ON ci.id=cr.invoice_id LEFT JOIN projects p ON p.id=ci.project_id
      ${cr.where} ORDER BY cr.received_date,cr.id`, cr.params),
    query(`SELECT po.id,po.project_id projectId,p.name project,po.reference,s.name supplier,
      po.order_date orderDate,po.total,po.status FROM purchase_orders po
      JOIN projects p ON p.id=po.project_id JOIN suppliers s ON s.id=po.supplier_id
      ${po.where} ORDER BY po.order_date,po.id`, po.params),
    query(`SELECT si.id,po.project_id projectId,COALESCE(p.name,'Unallocated') project,
      si.invoice_no invoiceNo,s.name supplier,si.invoice_date invoiceDate,si.due_date dueDate,
      si.amount,si.paid_amount paidAmount,si.status,po.reference orderReference
      FROM supplier_invoices si JOIN suppliers s ON s.id=si.supplier_id
      LEFT JOIN purchase_orders po ON po.id=si.order_id LEFT JOIN projects p ON p.id=po.project_id
      ${si.where} ORDER BY si.invoice_date,si.id`, si.params),
    query(`SELECT sp.id,po.project_id projectId,COALESCE(p.name,'Unallocated') project,
      si.invoice_no invoiceNo,s.name supplier,sp.paid_date date,sp.amount,sp.method,sp.reference
      FROM supplier_payments sp JOIN supplier_invoices si ON si.id=sp.invoice_id
      JOIN suppliers s ON s.id=si.supplier_id LEFT JOIN purchase_orders po ON po.id=si.order_id
      LEFT JOIN projects p ON p.id=po.project_id ${sp.where} ORDER BY sp.paid_date,sp.id`, sp.params),
    query(`SELECT pce.id,COALESCE(pce.project_id,pcf.project_id) projectId,
      COALESCE(p.name,'Head office') project,pcf.name floatName,pce.kind,pce.entry_date date,
      pcf.account_type accountType,pce.description,pce.category,pce.amount,
      pce.employee_id employeeId,emp.name employee,fr.vehicle_id vehicleId,
      fv.vehicle vehicle,fv.registration registration FROM petty_cash_entries pce
      JOIN petty_cash_floats pcf ON pcf.id=pce.float_id
      LEFT JOIN employees emp ON emp.id=pce.employee_id
      LEFT JOIN fuel_records fr ON fr.id=pce.fuel_record_id
      LEFT JOIN fleet fv ON fv.id=fr.vehicle_id
      LEFT JOIN projects p ON p.id=COALESCE(pce.project_id,pcf.project_id)
      ${pc.where} ORDER BY pce.entry_date,pce.id`, pc.params),
    query(`SELECT r.id,r.project_id projectId,p.name project,r.description,r.amount,r.percent,
      r.held_from heldFrom,r.release_date releaseDate,r.released_amount releasedAmount,r.status
      FROM retentions r JOIN projects p ON p.id=r.project_id ${rt.where} ORDER BY r.held_from,r.id`, rt.params),
    query(`SELECT b.id,b.project_id projectId,COALESCE(p.name,'Company') project,b.reference,b.kind,
      b.beneficiary,b.bank,b.amount,b.margin_held marginHeld,b.commission,b.issued_date issuedDate,
      b.expiry_date expiryDate,b.status FROM bank_bonds b LEFT JOIN projects p ON p.id=b.project_id
      ${bb.where} ORDER BY b.issued_date,b.id`, bb.params),
    query(`SELECT v.id,v.project_id projectId,p.name project,v.reference,v.description,v.amount,
      DATE(v.created_at) date,v.status FROM variation_orders v JOIN projects p ON p.id=v.project_id
      ${vo.where} ORDER BY v.created_at,v.id`, vo.params),
    query(`SELECT b.project_id projectId,p.name project,COALESCE(SUM(bi.amount),0) baseline
      FROM boqs b JOIN projects p ON p.id=b.project_id LEFT JOIN boq_items bi ON bi.boq_id=b.id
      ${costProject.where} GROUP BY b.project_id,p.name`, costProject.params),
    query(`SELECT f.project_id projectId,p.name project,COALESCE(SUM(f.forecast_amount),0) forecast
      FROM project_cost_forecasts f JOIN projects p ON p.id=f.project_id
      WHERE ${companyId ? 'p.company_id=? AND ' : ''}${requestedProject !== null ? 'f.project_id=?' : '1=1'} GROUP BY f.project_id,p.name`,
      [companyId, requestedProject].filter(value => value !== null)),
    query(`SELECT b.project_id projectId,bi.id,bi.amount expectedAmount,
      f.forecast_amount forecastAmount,COALESCE(SUM(e.amount),0) actualAmount
      FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id JOIN projects p ON p.id=b.project_id
      LEFT JOIN project_cost_forecasts f ON f.boq_item_id=bi.id
      LEFT JOIN expenses e ON e.boq_item_id=bi.id
      WHERE ${companyId ? 'p.company_id=? AND ' : ''}${requestedProject !== null ? 'b.project_id=? AND ' : ''}
        (b.status='Approved' OR NOT EXISTS
          (SELECT 1 FROM boqs approved WHERE approved.project_id=b.project_id AND approved.status='Approved'))
      GROUP BY b.project_id,bi.id,bi.amount,f.forecast_amount ORDER BY b.project_id,bi.id`,
      [companyId, requestedProject].filter(value => value !== null)),
    requestedProject === null
      ? query(`SELECT pr.id,pr.reference,pr.period_start periodStart,pr.period_end periodEnd,pr.pay_frequency payFrequency,
          pr.status,COALESCE(SUM(ps.net_pay),pr.total) total,COUNT(ps.id) employees,COALESCE(SUM(ps.overtime_pay),0) overtime,
          COALESCE(SUM(ps.gross_earnings),0) grossEarnings,COALESCE(SUM(ps.employer_cost),0) employerCost,
          COALESCE(SUM(ps.epf_employee_deduction),0) epfEmployeeDeductions,
          COALESCE(SUM(ps.epf_employer_contribution),0) epfEmployerContributions,
          COALESCE(SUM(ps.etf_employer_contribution),0) etfEmployerContributions,
          COALESCE(SUM(ps.allowance_total),0) allowances,COALESCE(SUM(ps.reimbursement_total),0) reimbursements,
          COALESCE(SUM(ps.unpaid_leave_deduction),0) unpaidLeaveDeductions,
          COALESCE(SUM(ps.salary_advance_deduction),0) salaryAdvanceDeductions,
          COALESCE(SUM(ps.deductions),0) deductions FROM payroll_runs pr
          LEFT JOIN payslips ps ON ps.run_id=pr.id
          WHERE ${companyId ? 'pr.company_id=? AND ' : ''}${from || to ? [from && 'pr.period_end>=?', to && 'pr.period_start<=?'].filter(Boolean).join(' AND ') : '1=1'}
          GROUP BY pr.id ORDER BY pr.period_start`, [companyId, from, to].filter(value => value !== null))
      : Promise.resolve([]),
    query(`SELECT q.id,q.project_id projectId,q.reference,q.quote_date date,q.total,q.subtotal,
      q.markup_percent markupPercent,q.vat_percent vatPercent,q.status
      FROM quotations_client q JOIN projects p ON p.id=q.project_id
      WHERE q.status='Accepted' ${companyId ? 'AND p.company_id=?' : ''}
      ${requestedProject !== null ? 'AND q.project_id=?' : ''}
      ORDER BY q.quote_date DESC,q.id DESC`,
      [companyId, requestedProject].filter(value => value !== null)),
    query(`SELECT v.id,v.project_id projectId,v.reference,v.description,v.amount,v.status
      FROM variation_orders v JOIN projects p ON p.id=v.project_id
      WHERE v.status='Approved' ${companyId ? 'AND p.company_id=?' : ''}
      ${requestedProject !== null ? 'AND v.project_id=?' : ''}
      ORDER BY v.id`, [companyId, requestedProject].filter(value => value !== null))
  ]);

  res.json({ scope: { companyId: companyId || 'all', projectId: requestedProject || 'all', from, to }, projects, expenses, incomes,
    clientInvoices, clientReceipts, purchaseOrders, supplierInvoices, supplierPayments, pettyCash,
    retentions, bonds, variations, boqSummary, forecasts, costItems, payroll, acceptedQuotations, approvedVariationsAll });
}));

export default router;
