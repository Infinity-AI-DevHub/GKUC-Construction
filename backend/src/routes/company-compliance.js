import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reminder = z.discriminatedUnion('unit', [
  z.object({ unit: z.enum(['Days','Weeks','Months']), value: z.number().int().min(0).max(3650) }),
  z.object({ unit: z.literal('Date'), date })
]);
const fields = {
  companyId: z.number().int().positive(), reference: z.string().trim().max(120).optional(),
  issueDate: date.nullable().optional(), expiryDate: date,
  reminders: z.array(reminder).max(30).default([{ unit:'Days', value:30 }]),
  notes: z.string().trim().max(10000).optional()
};
const dateOrder = (body, context) => {
  if (body.issueDate && body.expiryDate < body.issueDate)
    context.addIssue({ code:'custom', path:['expiryDate'], message:'Expiry date cannot be before the issue date.' });
};
const bodySchema = z.object(fields).superRefine(dateOrder);
const renewalSchema = z.object({reference:fields.reference,issueDate:fields.issueDate,expiryDate:fields.expiryDate,
  reminders:fields.reminders,notes:fields.notes}).superRefine(dateOrder);

const selectRecord = `SELECT c.id,c.company_id companyId,co.name company,c.compliance_type complianceType,
  c.reference,DATE_FORMAT(c.issue_date,'%Y-%m-%d') issueDate,DATE_FORMAT(c.expiry_date,'%Y-%m-%d') expiryDate,
  c.reminders,c.status,c.notes,c.created_at createdAt,c.updated_at updatedAt,u.name createdBy,
  DATEDIFF(c.expiry_date,CURDATE()) daysUntil
  FROM company_compliance_records c JOIN companies co ON co.id=c.company_id JOIN users u ON u.id=c.created_by`;
const map = row => ({ ...row, reminders: typeof row.reminders === 'string' ? JSON.parse(row.reminders) : row.reminders });

router.get('/', auth, permit('finance.view','finance.manage'), wrap(async (req,res) => {
  const companyId=Number(req.query.companyId);
  if(!Number.isInteger(companyId)||companyId<1)return res.status(400).json({error:'Choose an operating company.'});
  const records=(await query(`${selectRecord} WHERE c.company_id=? ORDER BY c.status='Active' DESC,c.expiry_date DESC`,[companyId])).map(map);
  for(const record of records) record.renewals=await query(`SELECT r.id,r.reference,
    DATE_FORMAT(r.issue_date,'%Y-%m-%d') issueDate,DATE_FORMAT(r.expiry_date,'%Y-%m-%d') expiryDate,
    r.notes,r.recorded_at recordedAt,u.name recordedBy FROM company_compliance_renewals r
    JOIN users u ON u.id=r.recorded_by WHERE r.compliance_id=? ORDER BY r.expiry_date DESC,r.id DESC`,[record.id]);
  res.json(records);
}));

router.post('/',auth,permit('finance.manage'),validate(bodySchema),wrap(async(req,res)=>{
  const body=req.body;
  if(!await getOne('SELECT id FROM companies WHERE id=? AND active=1',[body.companyId]))return res.status(404).json({error:'Company not found.'});
  if(await getOne("SELECT id FROM company_compliance_records WHERE company_id=? AND compliance_type='VAT clearance' AND status='Active'",[body.companyId]))
    return res.status(409).json({error:'This company already has an active VAT clearance record. Renew that record instead.'});
  const id=await transaction(async conn=>{
    const [result]=await conn.query(`INSERT INTO company_compliance_records
      (company_id,compliance_type,reference,issue_date,expiry_date,reminders,notes,created_by)
      VALUES (?,'VAT clearance',?,?,?,?,?,?)`,[body.companyId,body.reference||null,body.issueDate||null,body.expiryDate,JSON.stringify(body.reminders),body.notes||null,req.user.id]);
    await conn.query(`INSERT INTO company_compliance_renewals
      (compliance_id,reference,issue_date,expiry_date,notes,recorded_by) VALUES (?,?,?,?,?,?)`,
      [result.insertId,body.reference||null,body.issueDate||null,body.expiryDate,body.notes||null,req.user.id]);
    return result.insertId;
  });
  await audit(pool,req.user.id,'CREATE','company_compliance',id,null,body,req.ip);
  res.status(201).json({id});
}));

router.put('/:id/renew',auth,permit('finance.manage'),validate(renewalSchema),wrap(async(req,res)=>{
  const before=await getOne('SELECT * FROM company_compliance_records WHERE id=?',[req.params.id]);
  if(!before)return res.status(404).json({error:'VAT clearance record not found.'});
  const body=req.body;
  await transaction(async conn=>{
    await conn.query(`UPDATE company_compliance_records SET reference=?,issue_date=?,expiry_date=?,reminders=?,notes=?,status='Active' WHERE id=?`,
      [body.reference||null,body.issueDate||null,body.expiryDate,JSON.stringify(body.reminders),body.notes||null,before.id]);
    await conn.query(`INSERT INTO company_compliance_renewals
      (compliance_id,reference,issue_date,expiry_date,notes,recorded_by) VALUES (?,?,?,?,?,?)`,
      [before.id,body.reference||null,body.issueDate||null,body.expiryDate,body.notes||null,req.user.id]);
  });
  await audit(pool,req.user.id,'RENEW','company_compliance',before.id,before,body,req.ip);
  res.json({id:before.id});
}));

export default router;
