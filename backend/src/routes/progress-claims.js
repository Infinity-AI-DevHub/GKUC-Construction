import {Router} from 'express';
import {z} from 'zod';
import {query,getOne,transaction,audit,nextReference} from '../db.js';
import {auth,permit,can,validate,wrap,fail} from '../lib/http.js';
import {money,valueProgress,progressTotals} from '../lib/progress-valuation.js';
import {documentContext,invoiceDocument,progressDocument} from '../lib/documents.js';
import {sendDocument} from '../lib/document-pdf.js';
import {publishChange} from '../lib/realtime.js';
const router=Router();router.use(auth);
router.param('id',(req,res,next,id)=>{
  if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id)))return res.status(400).json({error:'Invalid record identifier.'});
  next();
});
const read=permit('qs.view','qs.boq','qs.approve','finance.view','finance.invoice');
const json=value=>typeof value==='string'?JSON.parse(value):value;
const snapshot=value=>{const row=json(value);return row?{...row,items:json(row.items)}:null;};
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const date=new Date(value);return !Number.isNaN(+date)&&date.toISOString().slice(0,10)===value;},'Enter a valid date');
const item=z.object({code:z.string().trim().regex(/^[A-Za-z0-9_.-]{1,30}$/),description:z.string().trim().min(1).max(300),
  unit:z.string().trim().min(1).max(30),quantity:z.number().positive().max(999999999).multipleOf(0.001),rate:z.number().nonnegative().max(999999999).multipleOf(0.01)})
  .refine(row=>row.quantity*row.rate<=9e12,{message:'Item value exceeds the supported amount.',path:['rate']});
const quantities=z.record(z.number().nonnegative().max(999999999).multipleOf(0.001));
const cash=z.number().nonnegative().max(9e12).multipleOf(0.01);
const lockedProject=async(connection,id)=>{const [rows]=await connection.execute('SELECT * FROM projects WHERE id=? AND active=1 FOR UPDATE',[id]);if(!rows.length)throw fail(404,'Active project not found.');return rows[0];};
async function previousCertificate(connection,projectId){
  const [rows]=await connection.execute("SELECT certified_items FROM progress_claims WHERE project_id=? AND status='Certified' ORDER BY id DESC LIMIT 1",[projectId]);
  return rows[0]?json(rows[0].certified_items):[];
}
function valued(items,amounts,previous){try{return valueProgress(items,amounts,previous);}catch(error){throw fail(400,error.message);}}
function validateRevision(items,previous){
  for(const before of previous){
    if(Number(before.quantity)===0)continue;
    const row=items.find(item=>item.code===before.code);
    if(!row)throw fail(409,'Retain all previously certified item codes in the revision.');
    if(Number(row.quantity)<Number(before.quantity))throw fail(409,`${row.code}: BOQ quantity cannot fall below certified quantity.`);
    if(before.quantity>0&&Number(row.rate)!==Number(before.rate))throw fail(409,`${row.code}: preserve the certified rate; add a new variation item code for revised pricing.`);
  }
}
router.get('/',read,wrap(async(req,res)=>{
  const companyId=Number(req.query.companyId);if(!Number.isSafeInteger(companyId)||companyId<1)throw fail(400,'Choose a company.');
  const projects=await query('SELECT id,name,client,client_id clientId,billing_route billingRoute FROM projects WHERE company_id=? AND active=1 ORDER BY name',[companyId]);
  const schedules=await query('SELECT s.* FROM progress_schedules s JOIN projects p ON p.id=s.project_id WHERE p.company_id=? ORDER BY s.id DESC',[companyId]);
  const claims=await query(`SELECT c.*,p.name project,i.net_payable netPayable,i.paid_amount paidAmount,i.reference receivableReference
    FROM progress_claims c JOIN projects p ON p.id=c.project_id LEFT JOIN client_invoices i ON i.id=c.invoice_id
    WHERE p.company_id=? ORDER BY c.id DESC`,[companyId]);
  res.json({projects,schedules:schedules.map(row=>({...row,items:json(row.items)})),claims:claims.map(row=>({...row,
    schedule_snapshot:snapshot(row.schedule_snapshot),submitted_items:json(row.submitted_items),certified_items:json(row.certified_items),certification:json(row.certification)}))});
}));
router.post('/schedules',permit('qs.boq'),validate(z.object({projectId:z.number().int().positive(),
  source:z.enum(['Client supplied','QS prepared']),contractReference:z.string().trim().max(180).default(''),
  revisionReason:z.string().trim().min(3).max(1000),items:z.array(item).min(1).max(500)})),wrap(async(req,res)=>{
  const b=req.body;if(new Set(b.items.map(row=>row.code)).size!==b.items.length)throw fail(400,'Item codes must be unique.');
  const id=await transaction(async connection=>{
    await lockedProject(connection,b.projectId);
    const [pending]=await connection.execute("SELECT id FROM progress_claims WHERE project_id=? AND status IN ('Draft','Submitted')",[b.projectId]);
    if(pending.length)throw fail(409,'Complete or withdraw the pending application before revising its BOQ.');
    const [versions]=await connection.execute('SELECT version_no,items,status FROM progress_schedules WHERE project_id=? ORDER BY version_no DESC LIMIT 1',[b.projectId]);
    if(!versions.length){
      const [invoices]=await connection.execute("SELECT id FROM client_invoices WHERE project_id=? AND status<>'Cancelled' LIMIT 1",[b.projectId]);
      if(invoices.length)throw fail(409,'This project already has invoice history. Reconcile its opening certified quantities before switching billing routes; no existing records were changed.');
    }
    if(versions[0]?.status==='Draft')throw fail(409,'Approve the existing draft valuation BOQ before creating another version.');
    const previous=await previousCertificate(connection,b.projectId);
    validateRevision(b.items,previous);
    const [result]=await connection.execute(`INSERT INTO progress_schedules(project_id,version_no,source,contract_reference,revision_reason,items,created_by)
      VALUES (?,?,?,?,?,?,?)`,[b.projectId,Number(versions[0]?.version_no||0)+1,b.source,b.contractReference||null,b.revisionReason,JSON.stringify(b.items),req.user.id]);
    await connection.execute("UPDATE projects SET billing_route='Progress claims' WHERE id=?",[b.projectId]);
    await audit(connection,req.user.id,'CREATE','progress_schedule',result.insertId,null,b,req.ip);return result.insertId;
  });publishChange('progress-claims',{});res.status(201).json({id});
}));
router.delete('/schedules/:id',permit('qs.boq'),validate(z.object({reason:z.string().trim().min(3).max(1000)})),wrap(async(req,res)=>{
  await transaction(async connection=>{
    const [initial]=await connection.execute('SELECT project_id FROM progress_schedules WHERE id=?',[req.params.id]);
    if(!initial.length)throw fail(404,'Valuation BOQ not found.');
    const project=await lockedProject(connection,initial[0].project_id);
    const [rows]=await connection.execute('SELECT * FROM progress_schedules WHERE id=? FOR UPDATE',[req.params.id]);
    const before=rows[0];if(!before)throw fail(404,'Valuation BOQ not found.');
    if(before.status!=='Draft'&&!can(req,'qs.approve'))throw fail(403,'Deleting an approved valuation BOQ requires QS approval permission.');
    const [latest]=await connection.execute('SELECT id FROM progress_schedules WHERE project_id=? ORDER BY version_no DESC LIMIT 1',[before.project_id]);
    if(latest[0].id!==before.id)throw fail(409,'Only the latest unused BOQ version can be deleted.');
    const [used]=await connection.execute('SELECT id FROM progress_claims WHERE schedule_id=? LIMIT 1',[before.id]);
    if(used.length)throw fail(409,'This BOQ is referenced by an application and cannot be deleted, including withdrawn applications.');
    await connection.execute('DELETE FROM progress_schedules WHERE id=?',[before.id]);
    const [remaining]=await connection.execute('SELECT id FROM progress_schedules WHERE project_id=? LIMIT 1',[before.project_id]);
    const restored=!remaining.length;
    if(restored)await connection.execute("UPDATE projects SET billing_route='Quotation and invoice' WHERE id=?",[before.project_id]);
    await audit(connection,req.user.id,'DELETE','progress_schedule',before.id,before,{reason:req.body.reason,
      projectId:before.project_id,billingRoute:restored?'Quotation and invoice':project.billing_route},req.ip);
  });publishChange('progress-claims',{});res.status(204).end();
}));
router.patch('/schedules/:id',permit('qs.approve'),validate(z.object({status:z.enum(['Internally approved','Client agreed']),reference:z.string().trim().min(3).max(500)})),wrap(async(req,res)=>{
  await transaction(async connection=>{
    const [rows]=await connection.execute('SELECT * FROM progress_schedules WHERE id=? FOR UPDATE',[req.params.id]);const before=rows[0];if(!before)throw fail(404,'Valuation BOQ not found.');
    if(before.status!==(req.body.status==='Client agreed'?'Internally approved':'Draft'))throw fail(409,'Approve the draft internally before recording client agreement.');
    const referenceColumn=req.body.status==='Client agreed'?'agreement_reference':'internal_reference';
    await connection.execute(`UPDATE progress_schedules SET status=?,${referenceColumn}=?,approved_by=? WHERE id=?`,[req.body.status,req.body.reference,req.user.id,before.id]);
    await audit(connection,req.user.id,'APPROVE','progress_schedule',before.id,before,req.body,req.ip);
  });publishChange('progress-claims',{});res.status(204).end();
}));
router.put('/schedules/:id',permit('qs.boq'),validate(z.object({source:z.enum(['Client supplied','QS prepared']),contractReference:z.string().trim().max(180).default(''),
  revisionReason:z.string().trim().min(3).max(1000),items:z.array(item).min(1).max(500)})),wrap(async(req,res)=>{
  if(new Set(req.body.items.map(row=>row.code)).size!==req.body.items.length)throw fail(400,'Item codes must be unique.');
  await transaction(async connection=>{
    const [rows]=await connection.execute('SELECT * FROM progress_schedules WHERE id=? FOR UPDATE',[req.params.id]);const before=rows[0];if(!before)throw fail(404,'Valuation BOQ not found.');
    if(before.status!=='Draft')throw fail(409,'Approved valuation BOQs are locked. Create a revision instead.');
    const previous=await previousCertificate(connection,before.project_id);
    validateRevision(req.body.items,previous);
    await connection.execute('UPDATE progress_schedules SET source=?,contract_reference=?,revision_reason=?,items=? WHERE id=?',
      [req.body.source,req.body.contractReference||null,req.body.revisionReason,JSON.stringify(req.body.items),before.id]);
    await audit(connection,req.user.id,'UPDATE','progress_schedule',before.id,before,req.body,req.ip);
  });publishChange('progress-claims',{});res.status(204).end();
}));
const applicationSchema=z.object({scheduleId:z.number().int().positive(),applicationDate:day,periodFrom:day,periodTo:day,
  quantities,notes:z.string().trim().max(1000).default('')});
router.put('/:id',permit('qs.boq'),validate(applicationSchema),wrap(async(req,res)=>{
  const b=req.body;if(b.periodFrom>b.periodTo||b.applicationDate<b.periodTo)throw fail(400,'Check the application date and work period.');
  await transaction(async connection=>{
    const [initial]=await connection.execute('SELECT project_id FROM progress_claims WHERE id=?',[req.params.id]);if(!initial.length)throw fail(404,'Application not found.');
    await lockedProject(connection,initial[0].project_id);
    const [rows]=await connection.execute('SELECT * FROM progress_claims WHERE id=? FOR UPDATE',[req.params.id]);const before=rows[0];
    if(before.status!=='Draft'||before.schedule_id!==b.scheduleId)throw fail(409,'Only draft applications can be edited against their original BOQ version.');
    const [previous]=await connection.execute("SELECT period_to FROM progress_claims WHERE project_id=? AND status='Certified' ORDER BY id DESC LIMIT 1",[before.project_id]);
    if(previous[0]&&b.periodTo<previous[0].period_to)throw fail(409,'The valuation cutoff cannot precede the previous certificate.');
    const schedule=json(before.schedule_snapshot),lines=valued(json(schedule.items),b.quantities,await previousCertificate(connection,before.project_id));
    const amount=money(lines.reduce((sum,line)=>sum+line.current,0));if(amount<=0)throw fail(400,'Enter additional completed quantities.');
    await connection.execute('UPDATE progress_claims SET application_date=?,period_from=?,period_to=?,submitted_items=?,submitted_amount=?,notes=? WHERE id=?',
      [b.applicationDate,b.periodFrom,b.periodTo,JSON.stringify(lines),amount,b.notes||null,before.id]);
    await audit(connection,req.user.id,'UPDATE','progress_claim',before.id,before,{...b,lines,amount},req.ip);
  });publishChange('progress-claims',{});res.status(204).end();
}));
router.post('/',permit('qs.boq'),validate(applicationSchema),wrap(async(req,res)=>{
  const b=req.body;if(b.periodFrom>b.periodTo||b.applicationDate<b.periodTo)throw fail(400,'Check the application date and work period.');
  const reference=await nextReference('IPA','progress_claims');
  const id=await transaction(async connection=>{
    const [schedules]=await connection.execute('SELECT * FROM progress_schedules WHERE id=?',[b.scheduleId]);const schedule=schedules[0];if(!schedule)throw fail(404,'Valuation BOQ not found.');
    await lockedProject(connection,schedule.project_id);
    const [latest]=await connection.execute('SELECT id FROM progress_schedules WHERE project_id=? ORDER BY version_no DESC LIMIT 1',[schedule.project_id]);
    if(latest[0].id!==schedule.id||schedule.status==='Draft')throw fail(409,'Use the latest internally approved or client-agreed valuation BOQ.');
    const [pending]=await connection.execute("SELECT id FROM progress_claims WHERE project_id=? AND status IN ('Draft','Submitted')",[schedule.project_id]);
    if(pending.length)throw fail(409,'Complete or withdraw the pending application first.');
    const [previous]=await connection.execute("SELECT period_to FROM progress_claims WHERE project_id=? AND status='Certified' ORDER BY id DESC LIMIT 1",[schedule.project_id]);
    if(previous[0]&&b.periodTo<previous[0].period_to)throw fail(409,'The valuation cutoff cannot precede the previous certificate.');
    const lines=valued(json(schedule.items),b.quantities,await previousCertificate(connection,schedule.project_id));
    const amount=money(lines.reduce((sum,line)=>sum+line.current,0));if(amount<=0)throw fail(400,'Enter additional completed quantities.');
    const [result]=await connection.execute(`INSERT INTO progress_claims(reference,project_id,schedule_id,application_date,period_from,period_to,submitted_items,schedule_snapshot,submitted_amount,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[reference,schedule.project_id,schedule.id,b.applicationDate,b.periodFrom,b.periodTo,JSON.stringify(lines),JSON.stringify(schedule),amount,b.notes||null,req.user.id]);
    await audit(connection,req.user.id,'CREATE','progress_claim',result.insertId,null,{...b,lines,amount},req.ip);return result.insertId;
  });publishChange('progress-claims',{});res.status(201).json({id,reference});
}));
router.patch('/:id/status',permit('qs.boq'),validate(z.object({status:z.enum(['Submitted','Withdrawn']),reason:z.string().trim().min(3).max(1000)})),wrap(async(req,res)=>{
  await transaction(async connection=>{
    const [rows]=await connection.execute('SELECT * FROM progress_claims WHERE id=? FOR UPDATE',[req.params.id]);const before=rows[0];if(!before)throw fail(404,'Application not found.');
    if(!['Draft','Submitted'].includes(before.status)||req.body.status==='Submitted'&&before.status!=='Draft')throw fail(409,'This application is locked.');
    await connection.execute('UPDATE progress_claims SET status=? WHERE id=?',[req.body.status,before.id]);
    await audit(connection,req.user.id,req.body.status.toUpperCase(),'progress_claim',before.id,before,req.body,req.ip);
  });publishChange('progress-claims',{});res.status(204).end();
}));
const certificationSchema=z.object({certificateReference:z.string().trim().min(1).max(180),certifiedDate:day,dueDate:day,
  retentionReleaseDate:day.optional(),
  quantities,retention:cash.default(0),advance:cash.default(0),other:cash.default(0),
  stampDuty:cash.default(0),
  vatRate:z.number().min(0).max(100).default(0),taxBasis:z.enum(['Gross','After recoveries']).default('Gross'),reason:z.string().trim().min(3).max(1000)});
router.post('/:id/certify',permit('finance.invoice'),validate(certificationSchema),wrap(async(req,res)=>{
  const b=req.body;if(b.dueDate<b.certifiedDate)throw fail(400,'Payment due must not precede certification.');
  if(b.retention>0&&(!b.retentionReleaseDate||b.retentionReleaseDate<b.certifiedDate))throw fail(400,'Enter a retention release date on or after certification.');
  const reference=await nextReference('IPC','client_invoices');
  const result=await transaction(async connection=>{
    const [initial]=await connection.execute('SELECT project_id FROM progress_claims WHERE id=?',[req.params.id]);if(!initial.length)throw fail(404,'Application not found.');
    const project=await lockedProject(connection,initial[0].project_id);
    await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[project.company_id]);
    const [filed]=await connection.execute("SELECT id FROM vat_periods WHERE company_id=? AND status='Filed' AND ? BETWEEN period_start AND period_end",[project.company_id,b.certifiedDate]);
    if(filed.length&&b.vatRate>0)throw fail(409,'This VAT period is filed. Record the adjustment through Finance before certifying taxable work in that period.');
    const [rows]=await connection.execute('SELECT * FROM progress_claims WHERE id=? FOR UPDATE',[req.params.id]);const claim=rows[0];
    if(claim.status!=='Submitted')throw fail(409,'Only a submitted application can be certified once.');
    if(b.certifiedDate<claim.application_date)throw fail(400,'Certificate date must not precede the application.');
    const [schedules]=await connection.execute('SELECT * FROM progress_schedules WHERE id=?',[claim.schedule_id]);
    const lines=valued(json(schedules[0].items),b.quantities,await previousCertificate(connection,claim.project_id));
    const submitted=json(claim.submitted_items);
    if(lines.some(line=>line.quantity>submitted.find(item=>item.code===line.code).quantity))throw fail(400,'Certified quantities cannot exceed the submitted quantities.');
    let totals;try{totals=progressTotals(lines,b);}catch(error){throw fail(400,error.message);}
    if(totals.gross<=0)throw fail(400,'Certified work value must be positive.');
    const [invoice]=await connection.execute(`INSERT INTO client_invoices(reference,project_id,company_id,client_id,client,document_type,kind,title,invoice_date,due_date,period_from,period_to,
      gross,tax_treatment,vat_rate,vat_amount,retention_amount,advance_recovery,other_deductions,deduction_note,net_payable,status,issued_at,created_by)
      VALUES (?,?,?,?,?,'Payment Certificate','Interim',?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Issued',NOW(),?)`,
      [reference,project.id,project.company_id,project.client_id||null,project.client,`${claim.reference} / ${b.certificateReference}`,b.certifiedDate,b.dueDate,claim.period_from,claim.period_to,
        totals.gross,b.vatRate?'Standard':'Exempt',b.vatRate,totals.vat,b.retention,b.advance,b.other+b.stampDuty,b.reason,totals.net,req.user.id]);
    for(const line of lines.filter(line=>line.current>0))await connection.execute('INSERT INTO client_invoice_items(invoice_id,description,unit,quantity,rate,amount) VALUES (?,?,?,?,?,?)',
      [invoice.insertId,line.description,line.unit,line.quantity-line.previousQuantity,line.rate,line.current]);
    await connection.execute('UPDATE client_invoices SET taxable_base=?,notes=? WHERE id=?',
      [b.taxBasis==='After recoveries'?totals.netBeforeVat:totals.gross,`VAT basis: ${b.taxBasis}. Client certificate ${b.certificateReference}. ${b.reason}`,invoice.insertId]);
    const [clients]=await connection.execute('SELECT COALESCE(NULLIF(tin,\'\'),tax_number) tin,vat_number,billing_address,phone FROM clients WHERE id=?',[project.client_id||0]);
    if(clients[0])await connection.execute('UPDATE client_invoices SET buyer_tin=?,buyer_vat_number=?,buyer_address=?,buyer_phone=? WHERE id=?',
      [clients[0].tin,clients[0].vat_number,clients[0].billing_address,clients[0].phone,invoice.insertId]);
    if(b.retention>0)await connection.execute(`INSERT INTO retentions(project_id,description,amount,held_from,release_date,notes,created_by) VALUES (?,?,?,?,?,?,?)`,
      [project.id,`${claim.reference} / ${b.certificateReference}`,b.retention,b.certifiedDate,b.retentionReleaseDate,`Receivable ${reference}`,req.user.id]);
    await connection.execute("UPDATE progress_claims SET status='Certified',certified_items=?,certification=?,certificate_reference=?,certified_date=?,invoice_id=? WHERE id=?",
      [JSON.stringify(lines),JSON.stringify({...totals,reason:b.reason}),b.certificateReference,b.certifiedDate,invoice.insertId,claim.id]);
    await audit(connection,req.user.id,'CERTIFY','progress_claim',claim.id,claim,{...b,totals,invoiceId:invoice.insertId},req.ip);
    return {id:claim.id,invoiceId:invoice.insertId,reference,...totals};
  });publishChange('receivables',{});res.status(201).json(result);
}));
router.post('/:id/invoice',permit('finance.invoice'),wrap(async(req,res)=>{
  const reference=await nextReference('INV','client_invoices');
  await transaction(async connection=>{
    const [rows]=await connection.execute('SELECT * FROM progress_claims WHERE id=? FOR UPDATE',[req.params.id]);const claim=rows[0];
    if(!claim||claim.status!=='Certified')throw fail(409,'Certify the application first.');
    if(claim.invoice_reference)throw fail(409,'An invoice already exists for this certificate.');
    await connection.execute('UPDATE progress_claims SET invoice_reference=? WHERE id=?',[reference,claim.id]);
    await audit(connection,req.user.id,'ISSUE_INVOICE','progress_claim',claim.id,null,{reference,receivableId:claim.invoice_id},req.ip);
  });publishChange('receivables',{});res.status(201).json({reference});
}));
router.get('/:id/document',read,wrap(async(req,res)=>{
  const claim=await getOne(`SELECT c.*,s.source,s.status approvalStatus,s.contract_reference contractReference,s.agreement_reference agreementReference,
    s.version_no versionNo,p.name project,p.client,p.company_id companyId FROM progress_claims c JOIN progress_schedules s ON s.id=c.schedule_id JOIN projects p ON p.id=c.project_id WHERE c.id=?`,[req.params.id]);
  if(!claim)throw fail(404,'Application not found.');
  const type=req.query.type||'application';if(!['application','letter','certificate','invoice'].includes(type))throw fail(400,'Unknown document type.');
  const context=await documentContext(getOne,claim.companyId);
  if(type==='invoice'){
    if(!claim.invoice_reference)throw fail(409,'Issue the optional invoice first.');
    const invoice=await getOne(`SELECT reference,client,title,invoice_date invoiceDate,due_date dueDate,gross,tax_treatment taxTreatment,vat_rate vatRate,
      buyer_tin buyerTin,buyer_vat_number buyerVatNumber,buyer_address buyerAddress,buyer_phone buyerPhone,notes,
      vat_amount vatAmount,retention_amount retentionAmount,advance_recovery advanceRecovery,other_deductions otherDeductions,net_payable netPayable FROM client_invoices WHERE id=?`,[claim.invoice_id]);
    const items=await query('SELECT description,unit,quantity,rate,amount FROM client_invoice_items WHERE invoice_id=?',[claim.invoice_id]);
    return sendDocument(req,res,invoiceDocument({...context,invoice:{...invoice,reference:claim.invoice_reference,project:claim.project,documentType:invoice.vatRate?'Tax Invoice':'Invoice'},items}),`${claim.invoice_reference}.pdf`);
  }
  if(type==='certificate'&&claim.status!=='Certified')throw fail(409,'The application has not been certified.');
  const snapshot=json(claim.schedule_snapshot);
  await sendDocument(req,res,progressDocument({...context,claim:{...claim,source:snapshot.source,approvalStatus:snapshot.status,contractReference:snapshot.contract_reference,
    agreementReference:snapshot.agreement_reference,internalReference:snapshot.internal_reference,versionNo:snapshot.version_no,
    submitted_items:json(claim.submitted_items),certified_items:json(claim.certified_items),certification:json(claim.certification)},type}),`${claim.reference}-${type}.pdf`);
}));
export default router;
