import {Router} from 'express';
import {z} from 'zod';
import {query,getOne,transaction,audit,hashPassword} from '../db.js';
import {auth,permit,validate,wrap} from '../lib/http.js';
import {strongPassword} from '../lib/passwords.js';

const router=Router();
router.use(auth,permit('hr.hiring'));
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shape=z.object({name:z.string().trim().min(2).max(120),phone:z.string().max(40).default(''),address:z.string().max(1000).default(''),email:z.string().email().or(z.literal('')).default(''),position:z.string().max(120).default('')});
router.get('/',wrap(async(_req,res)=>res.json(await query('SELECT * FROM hiring_candidates ORDER BY id DESC'))));
router.get('/roles',wrap(async(req,res)=>{
  const roles=await query('SELECT id,name FROM roles WHERE is_system=0 ORDER BY name');
  const grants=await query('SELECT role_id,permission_key FROM role_permissions');
  res.json(roles.filter(role=>grants.filter(g=>g.role_id===role.id).every(g=>req.user.permissions.includes(g.permission_key))));
}));
router.get('/:id',wrap(async(req,res)=>{
  const candidate=await getOne('SELECT * FROM hiring_candidates WHERE id=?',[req.params.id]);
  if(!candidate)return res.status(404).json({error:'Candidate not found.'});
  res.json({...candidate,interviews:await query('SELECT * FROM hiring_interviews WHERE candidate_id=? ORDER BY scheduled_at DESC,id DESC',[candidate.id])});
}));
router.post('/',validate(shape),wrap(async(req,res)=>{
  const b=req.body;
  const r=await query('INSERT INTO hiring_candidates(name,phone,address,email,position,created_by) VALUES(?,?,?,?,?,?)',[b.name,b.phone,b.address,b.email,b.position,req.user.id]);
  res.status(201).json({id:r.insertId});
}));
router.patch('/:id',validate(shape.partial().extend({status:z.enum(['Shortlisted','Interviewing','Selected','Dropped']).optional(),decisionNotes:z.string().max(5000).optional()})),wrap(async(req,res)=>{
  const before=await getOne('SELECT * FROM hiring_candidates WHERE id=?',[req.params.id]);
  if(!before)return res.status(404).json({error:'Candidate not found.'});
  if(before.status==='Hired')return res.status(409).json({error:'This candidate is already an employee. Update their employee profile instead.'});
  const entries=Object.entries(req.body);
  if(entries.length)await query(`UPDATE hiring_candidates SET ${entries.map(([key])=>`${key==='decisionNotes'?'decision_notes':key}=?`).join(',')} WHERE id=?`,[...entries.map(([,v])=>v),before.id]);
  res.json({id:before.id});
}));
const interview=z.object({scheduledAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),interviewer:z.string().trim().min(2).max(120),location:z.string().max(300).default(''),status:z.enum(['Scheduled','Completed','Cancelled','No show']).default('Scheduled'),notes:z.string().max(5000).default('')});
router.post('/:id/interviews',validate(interview),wrap(async(req,res)=>{
  const c=await getOne('SELECT id,status FROM hiring_candidates WHERE id=?',[req.params.id]);
  if(!c)return res.status(404).json({error:'Candidate not found.'});
  if(['Hired','Dropped'].includes(c.status))return res.status(409).json({error:'Reopen a dropped candidate before adding an interview. Hired candidates are managed in Employees.'});
  const b=req.body;
  const result=await query('INSERT INTO hiring_interviews(candidate_id,scheduled_at,interviewer,location,status,notes,created_by) VALUES(?,?,?,?,?,?,?)',[c.id,b.scheduledAt.replace('T',' '),b.interviewer,b.location,b.status,b.notes,req.user.id]);
  await query("UPDATE hiring_candidates SET status='Interviewing' WHERE id=? AND status='Shortlisted'",[c.id]);
  res.status(201).json({id:result.insertId});
}));
router.patch('/:id/interviews/:interviewId',validate(interview),wrap(async(req,res)=>{
  const b=req.body;
  const result=await query('UPDATE hiring_interviews SET scheduled_at=?,interviewer=?,location=?,status=?,notes=? WHERE id=? AND candidate_id=?',[b.scheduledAt.replace('T',' '),b.interviewer,b.location,b.status,b.notes,req.params.interviewId,req.params.id]);
  if(!result.affectedRows)return res.status(404).json({error:'Interview not found for this candidate.'});
  res.json({id:Number(req.params.interviewId)});
}));
router.post('/:id/hire',validate(z.object({code:z.string().trim().min(2).max(40),startDate:date,workerType:z.enum(['Office','Site']),companyId:z.number().int().positive(),createAccess:z.boolean().default(false),roleId:z.number().int().positive().optional(),password:strongPassword.optional()})),wrap(async(req,res)=>{
  const b=req.body;
  const result=await transaction(async conn=>{
    const [rows]=await conn.query('SELECT * FROM hiring_candidates WHERE id=? FOR UPDATE',[req.params.id]);
    const c=rows[0];
    if(!c)throw Object.assign(new Error('Candidate not found.'),{status:404});
    if(c.status!=='Selected'||c.employee_id)throw Object.assign(new Error('Only a selected candidate can be hired, and each candidate can be converted once.'),{status:409});
    const [companies]=await conn.query('SELECT id FROM companies WHERE id=?',[b.companyId]);
    if(!companies.length)throw Object.assign(new Error('Choose an existing payroll company before creating the employee.'),{status:400});
    if(c.email){const [existing]=await conn.query('SELECT id FROM employees WHERE LOWER(email)=LOWER(?)',[c.email]);if(existing.length)throw Object.assign(new Error('An employee already uses this email. Check the existing profile before hiring to avoid duplicates.'),{status:409});}
    let userId=null;
    if(b.createAccess){
      if(!c.email||!b.roleId||!b.password)throw Object.assign(new Error('Enter a candidate email, access role and temporary password to create system access.'),{status:400});
      const [roles]=await conn.query('SELECT id,name,is_system FROM roles WHERE id=?',[b.roleId]);
      const [grants]=await conn.query('SELECT permission_key FROM role_permissions WHERE role_id=?',[b.roleId]);
      if(!roles[0]||roles[0].is_system||grants.some(g=>!req.user.permissions.includes(g.permission_key)))throw Object.assign(new Error('You cannot assign an access role with more authority than your own. Ask the Managing Director to assign that role.'),{status:403});
      const [user]=await conn.query('INSERT INTO users(name,email,password_hash,role,role_id) VALUES(?,?,?,?,?)',[c.name,c.email.toLowerCase(),hashPassword(b.password),roles[0].name,b.roleId]);userId=user.insertId;
    }
    const [employee]=await conn.query(`INSERT INTO employees(code,name,phone,email,residential_address,designation,join_date,worker_type,payroll_category,payroll_company_id,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[b.code,c.name,c.phone,c.email||null,c.address,c.position||'',b.startDate,b.workerType,b.workerType==='Office'?'Office employee':'Site labourer',b.companyId,userId]);
    await conn.query("UPDATE hiring_candidates SET status='Hired',employee_id=? WHERE id=?",[employee.insertId,c.id]);
    // Preserve the CV and other candidate files on the employee record without storing duplicate files.
    await conn.query("UPDATE attachments SET owner_type='employee',owner_id=? WHERE owner_type='candidate' AND owner_id=?",[employee.insertId,c.id]);
    await audit(conn,req.user.id,'HIRE','candidate',c.id,c,{employeeId:employee.insertId,userId},req.ip);
    return {employeeId:employee.insertId,userId};
  }).catch(error=>{if(error.code==='ER_DUP_ENTRY')throw Object.assign(new Error('That employee ID or login email already exists. Check the existing records and try again.'),{status:409});throw error;});
  res.status(201).json(result);
}));
export default router;
