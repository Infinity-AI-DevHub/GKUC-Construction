import {z} from 'zod';
import {query,transaction,audit} from '../db.js';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {linkMdPersonal} from '../lib/md-personal-expenses.js';
import {sendDocument} from '../lib/document-pdf.js';
import {writeWorkbook} from '../lib/xlsx-write.js';

const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const metadata=z.object({category:z.string().trim().min(2).max(100),notes:z.string().trim().max(1000).optional(),paidBy:z.string().trim().max(180).optional()});
function filters(req){
 const from=String(req.query.from||''),to=String(req.query.to||''),companyId=Number(req.query.companyId||0),source=String(req.query.source||''),category=String(req.query.category||'');
 if(!validDate(from)||!validDate(to)||from>to||!Number.isInteger(companyId)||companyId<0||!['','Petty cash','Direct payment'].includes(source)||category.length>100)throw fail(400,'Choose a valid date range, company and payment source.');
 return {from,to,companyId,source,category};
}
const select=`SELECT md.id,md.category,md.notes,md.paid_by paidBy,md.created_at createdAt,md.petty_cash_entry_id pettyCashEntryId,md.office_payment_id officePaymentId,
 COALESCE(e.company_id,f.company_id,o.company_id) companyId,c.name company,COALESCE(e.entry_date,o.payment_date) date,
 COALESCE(ABS(e.amount),o.amount) amount,COALESCE(e.description,o.description) description,
 COALESCE(e.payee,o.payee) payee,IF(e.id IS NULL,'Direct payment','Petty cash') source,
 COALESCE(o.payment_method,'Petty cash') paymentMethod,f.name floatName,
 COALESCE(o.reference,CONCAT('Petty cash #',e.id)) reference,u.name recordedBy
 FROM md_personal_expenses md LEFT JOIN petty_cash_entries e ON e.id=md.petty_cash_entry_id
 LEFT JOIN petty_cash_floats f ON f.id=e.float_id LEFT JOIN office_expense_payments o ON o.id=md.office_payment_id
 JOIN companies c ON c.id=COALESCE(e.company_id,f.company_id,o.company_id) JOIN users u ON u.id=COALESCE(e.recorded_by,o.created_by)`;
async function list(b){
 const params=[b.from,b.to],where=['COALESCE(e.entry_date,o.payment_date) BETWEEN ? AND ?'];
 if(b.companyId){where.push('c.id=?');params.push(b.companyId);}
 if(b.category){where.push('md.category=?');params.push(b.category);}
 if(b.source)where.push(b.source==='Petty cash'?'e.id IS NOT NULL':'o.id IS NOT NULL');
 const rows=await query(`${select} WHERE ${where.join(' AND ')} ORDER BY date DESC,md.id DESC`,params);
 const sum=values=>Math.round(values.reduce((s,r)=>s+Number(r.amount),0)*100)/100;
 const groups=key=>Object.entries(rows.reduce((m,r)=>{m[r[key]]=(m[r[key]]||0)+Number(r.amount);return m;},Object.create(null))).map(([name,amount])=>({name,amount:Math.round(amount*100)/100}));
 return {beneficiary:'Mr. Gihan',...b,rows,total:sum(rows),pettyCash:sum(rows.filter(r=>r.source==='Petty cash')),direct:sum(rows.filter(r=>r.source==='Direct payment')),byCategory:groups('category'),byCompany:groups('company')};
}
export function mdPersonalDocument(data){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=v=>Number(v).toLocaleString('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2});
 return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:15mm}body{font:11px Arial;color:#16314b}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{padding:7px;text-align:left;border-bottom:1px solid #ddd}th{background:#eaf0f5}tr{break-inside:avoid}.amount{text-align:right}small{display:block;color:#64748b}</style></head><body><h1>MD Personal Expenses — ${esc(data.beneficiary)}</h1><p>${esc(data.from)} to ${esc(data.to)} · ${data.companyId?esc(data.rows[0]?.company||'Selected company'):'Both companies'}</p><p>Total LKR ${money(data.total)} · Petty cash ${money(data.pettyCash)} · Direct payments ${money(data.direct)}</p><p>Personal spending record. No repayment or outstanding balance is tracked. Payments shown here are the original payment records, not additional expenses.</p><table><thead><tr>${['Date','Company','Category','Payee / description','Payment source','Recorded by','LKR'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.company)}</td><td>${esc(r.category)}</td><td>${esc(r.payee)}<small>${esc(r.description)}</small><small>${esc(r.notes)}</small></td><td>${esc(r.source)} · ${esc(r.floatName||r.paymentMethod)}<small>${esc(r.reference)}</small></td><td>${esc(r.recordedBy)}${r.paidBy?`<small>Paid by ${esc(r.paidBy)}</small>`:""}</td><td class="amount">${money(r.amount)}</td></tr>`).join('')||'<tr><td colspan="7">No personal expenses in this range.</td></tr>'}</tbody></table><h3>Category totals</h3>${data.byCategory.map(g=>`<p>${esc(g.name)}: LKR ${money(g.amount)}</p>`).join('')}</body></html>`;
}
export function installMdPersonalRoutes(router){
 router.get('/md-personal-expenses',auth,permit('finance.manage'),wrap(async(req,res)=>res.json(await list(filters(req)))));
 router.get('/md-personal-expenses/document',auth,permit('finance.manage'),wrap(async(req,res)=>{
  const data=await list(filters(req));return sendDocument(req,res,mdPersonalDocument(data),'MD-Personal-Expenses.pdf');
 }));
 router.get('/md-personal-expenses/export.xlsx',auth,permit('finance.manage'),wrap(async(req,res)=>{
  const data=await list(filters(req));res.setHeader('Content-Disposition','attachment; filename="MD-Personal-Expenses.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(writeWorkbook([{name:'MD Personal Expenses',columns:[14,28,24,28,45,20,26,22,20,20,45,28],freeze:1,rows:[['Date','Company','Category','Payee','Description','Source','Float / method','Reference','Amount (LKR)','Recorded by','Notes','Paid by'],...data.rows.map(r=>[r.date,r.company,r.category,r.payee,r.description,r.source,r.floatName||r.paymentMethod,r.reference,Number(r.amount),r.recordedBy,r.notes,r.paidBy]),[],['Total (LKR)',data.total]]}]));
 }));
 router.get('/md-personal-expenses/payments',auth,permit('finance.manage'),wrap(async(req,res)=>{
  const b=filters(req),params=[b.from,b.to,...(b.companyId?[b.companyId]:[])];
  const petty=await query(`SELECT e.id,'Petty cash' source,e.entry_date date,ABS(e.amount) amount,e.description,e.payee,f.name account,COALESCE(e.company_id,f.company_id) companyId
   FROM petty_cash_entries e JOIN petty_cash_floats f ON f.id=e.float_id WHERE e.kind='Spend' AND f.account_type='Office expenses' AND e.project_id IS NULL AND e.employee_id IS NULL AND e.fuel_record_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM supplier_payments p WHERE p.petty_cash_entry_id=e.id)
   AND NOT EXISTS(SELECT 1 FROM expenses x WHERE x.origin_type='petty_cash' AND BINARY x.origin_id=BINARY CAST(e.id AS CHAR))
   AND NOT EXISTS(SELECT 1 FROM md_personal_expenses m WHERE m.petty_cash_entry_id=e.id)
   AND e.entry_date BETWEEN ? AND ? ${b.companyId?'AND COALESCE(e.company_id,f.company_id)=?':''} ORDER BY e.id DESC LIMIT 500`,params);
  const direct=await query(`SELECT o.id,'Direct payment' source,o.payment_date date,o.amount,o.description,o.payee,o.payment_method account,o.company_id companyId FROM office_expense_payments o
   WHERE NOT EXISTS(SELECT 1 FROM md_personal_expenses m WHERE m.office_payment_id=o.id) AND o.payment_date BETWEEN ? AND ? ${b.companyId?'AND o.company_id=?':''} ORDER BY o.id DESC LIMIT 500`,params);
  res.json([...petty,...direct]);
 }));
 router.post('/md-personal-expenses/link',auth,permit('finance.manage'),validate(metadata.extend({source:z.enum(['Petty cash','Direct payment']),paymentId:z.number().int().positive()})),wrap(async(req,res)=>{
  const b=req.body;const id=await transaction(c=>linkMdPersonal(c,req.user,b.source,b.paymentId,b.category,b.notes,req.ip,b.paidBy));res.status(201).json({id});
 }));
 router.put('/md-personal-expenses/:id',auth,permit('finance.manage'),validate(metadata),wrap(async(req,res)=>{
  await transaction(async c=>{const [[before]]=await c.query('SELECT * FROM md_personal_expenses WHERE id=? FOR UPDATE',[req.params.id]);if(!before)throw fail(404,'Personal expense not found.');
   await c.query('UPDATE md_personal_expenses SET category=?,notes=?,paid_by=? WHERE id=?',[req.body.category,req.body.notes||null,req.body.paidBy===undefined?before.paid_by:req.body.paidBy||null,before.id]);await audit(c,req.user.id,'UPDATE','md_personal_expense',before.id,before,req.body,req.ip);});res.json({saved:true});
 }));
}
