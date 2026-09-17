import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, spendSql, transaction } from '../db.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { assertUniqueManualEntry } from '../lib/ledger-duplicates.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const companyParam = req => {
  const value = Number(req.query.companyId || 0);
  return Number.isInteger(value) && value > 0 ? value : null;
};

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

router.get('/vat',auth,permit('finance.view','finance.manage'),wrap(async(req,res)=>{const companyId=companyParam(req)||1;
  const [output,inputSupplier,inputBills]=await Promise.all([
    query(`SELECT i.reference,i.client counterparty,i.invoice_date date,i.gross netAmount,i.vat_amount vatAmount,i.net_payable totalAmount,'Output' direction
      FROM client_invoices i JOIN projects p ON p.id=i.project_id WHERE p.company_id=? AND i.status='Paid' AND i.tax_treatment='Standard' ORDER BY i.invoice_date`,[companyId]),
    query(`SELECT i.invoice_no reference,s.name counterparty,i.invoice_date date,i.net_amount netAmount,i.vat_amount vatAmount,i.amount totalAmount,'Input' direction
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id WHERE i.company_id=? AND i.status='Paid' AND i.tax_treatment='Standard' ORDER BY i.invoice_date`,[companyId]),
    query(`SELECT b.reference,b.provider counterparty,b.bill_date date,b.net_amount netAmount,b.vat_amount vatAmount,b.total_amount totalAmount,'Input' direction
      FROM operating_bills b WHERE b.company_id=? AND b.status='Paid' AND b.tax_treatment='Standard' ORDER BY b.bill_date`,[companyId])]);
  const inputs=[...inputSupplier,...inputBills],sum=rows=>rows.reduce((n,row)=>n+Number(row.vatAmount),0),outputVat=sum(output),inputVat=sum(inputs);
  res.json({outputVat,inputVat,netVatPayable:outputVat-inputVat,entries:[...output,...inputs].sort((a,b)=>String(b.date).localeCompare(String(a.date)))});
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
    p.name project,e.project_id projectId,c.name category,u.name recordedBy
    FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories c ON c.id=e.category_id
    JOIN users u ON u.id=e.created_by ${where} ORDER BY e.expense_date DESC,e.id DESC LIMIT 300`, params));
}));

router.post('/expenses', auth, permit('finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  categoryId: z.number().int().positive().optional(),
  source: z.string().trim().min(1).max(60).default('Other'),
  description: z.string().min(2).max(400),
  amount: z.number().positive(),
  expenseDate: isoDate,
  reference: z.string().max(120).optional()
})), fromOptions({ source: 'expense.source' }), wrap(async (req, res) => {
  const body = req.body;
  const result = await transaction(async connection => {
    await assertUniqueManualEntry(connection, 'expenses', { projectId: body.projectId, reference: body.reference,
      amount: body.amount, date: body.expenseDate, description: body.description });
    const [inserted] = await connection.execute(`INSERT INTO expenses (project_id,category_id,source,description,amount,expense_date,reference,created_by)
      VALUES (?,?,?,?,?,?,?,?)`, [body.projectId, body.categoryId || null, body.source, body.description, body.amount,
      body.expenseDate, body.reference?.trim() || null, req.user.id]);
    return inserted;
  });
  const row = await getOne('SELECT * FROM expenses WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'expense', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.get('/income', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const filters = []; const params = [];
  const companyId = companyParam(req);
  if (companyId) { filters.push('p.company_id=?'); params.push(companyId); }
  if (req.query.projectId) { filters.push('i.project_id=?'); params.push(req.query.projectId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT i.id,i.description,i.amount,i.received_date receivedDate,i.method,i.reference,p.name project,i.project_id projectId,u.name recordedBy
    FROM incomes i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by ${where}
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
    const [inserted] = await connection.execute('INSERT INTO incomes (project_id,description,amount,received_date,method,reference,created_by) VALUES (?,?,?,?,?,?,?)',
      [body.projectId, body.description, body.amount, body.receivedDate, body.method, body.reference?.trim() || null, req.user.id]);
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
        JOIN projects ip ON ip.id=i.project_id ${companyId ? 'WHERE ip.company_id=?' : ''}
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
  const i = scoped('i.project_id', 'i.received_date');
  const ci = scoped('ci.project_id', 'ci.invoice_date');
  const cr = scoped('ci.project_id', 'cr.received_date');
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
    boqSummary, forecasts, costItems, payroll] = await Promise.all([
    query(`SELECT p.id,p.name,p.client,p.site,p.budget,p.progress,p.health,p.stage,p.company_id companyId
      FROM projects p ${projectOnly.where} ORDER BY p.name`, projectOnly.params),
    query(`SELECT e.id,e.project_id projectId,p.name project,e.expense_date date,e.description,
      e.amount,e.source,COALESCE(ec.name,'Uncategorised') category,e.cost_type costType,
      e.reference,e.boq_item_id boqItemId
      FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories ec ON ec.id=e.category_id
      ${e.where} ORDER BY e.expense_date,e.id`, e.params),
    query(`SELECT i.id,i.project_id projectId,p.name project,i.received_date date,i.description,
      i.amount,i.method,i.reference FROM incomes i JOIN projects p ON p.id=i.project_id
      ${i.where} ORDER BY i.received_date,i.id`, i.params),
    query(`SELECT ci.id,ci.project_id projectId,p.name project,ci.reference,ci.client,ci.kind,
      ci.invoice_date invoiceDate,ci.due_date dueDate,ci.gross,ci.vat_amount vatAmount,
      ci.retention_amount retentionAmount,ci.advance_recovery advanceRecovery,
      ci.other_deductions otherDeductions,ci.net_payable netPayable,ci.paid_amount paidAmount,ci.status
      FROM client_invoices ci JOIN projects p ON p.id=ci.project_id ${ci.where}
      ORDER BY ci.invoice_date,ci.id`, ci.params),
    query(`SELECT cr.id,ci.project_id projectId,p.name project,ci.reference invoiceReference,
      cr.received_date date,cr.amount,cr.method,cr.reference
      FROM client_receipts cr JOIN client_invoices ci ON ci.id=cr.invoice_id JOIN projects p ON p.id=ci.project_id
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
      pce.employee_id employeeId,emp.name employee FROM petty_cash_entries pce
      JOIN petty_cash_floats pcf ON pcf.id=pce.float_id
      LEFT JOIN employees emp ON emp.id=pce.employee_id
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
      : Promise.resolve([])
  ]);

  res.json({ scope: { companyId: companyId || 'all', projectId: requestedProject || 'all', from, to }, projects, expenses, incomes,
    clientInvoices, clientReceipts, purchaseOrders, supplierInvoices, supplierPayments, pettyCash,
    retentions, bonds, variations, boqSummary, forecasts, costItems, payroll });
}));

export default router;
