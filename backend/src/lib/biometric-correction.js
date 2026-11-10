import {createHash} from 'node:crypto';
import {z} from 'zod';
import {query,transaction,audit} from '../db.js';
import {auth,permit,validate,wrap,fail} from './http.js';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Choose a valid date');
const fields={code:z.string().trim().min(1).max(40),sourceEmployeeId:z.number().int().positive(),targetEmployeeId:z.number().int().positive().optional(),
 newProfile:z.object({code:z.string().trim().min(1).max(40),name:z.string().trim().min(2).max(120),joinDate:date,companyId:z.number().int().positive(),workerType:z.enum(['Office','Site'])}).optional(),from:date,to:date};
const validTarget=value=>Boolean(value.targetEmployeeId)!==Boolean(value.newProfile)&&value.targetEmployeeId!==value.sourceEmployeeId&&value.to>=value.from;
const previewSchema=z.object(fields).refine(validTarget,'Choose a different existing employee or a new profile and a valid date range');
const commitSchema=z.object({...fields,digest:z.string().length(64),reason:z.string().trim().min(5).max(500),acknowledgeLegacy:z.boolean().default(false),acknowledgePayroll:z.boolean().default(false),
 selections:z.array(z.object({id:z.number().int().positive(),decision:z.enum(['Move','Keep target','Use imported'])})).min(1).max(5000)}).refine(validTarget,'Choose a different target and a valid date range');
const parse=value=>typeof value==='string'?JSON.parse(value):value||{};

async function preview(run,b,lock=false){
 const people=await run('SELECT id,name,code,designation,payroll_company_id FROM visible_employees WHERE id IN (?,?) AND status<>\'Left\' ORDER BY id'+(lock?' FOR UPDATE':''),[b.sourceEmployeeId,b.targetEmployeeId||b.sourceEmployeeId]);
 const source=people.find(p=>Number(p.id)===b.sourceEmployeeId),target=people.find(p=>Number(p.id)===b.targetEmployeeId);
 if(!source||b.targetEmployeeId&&!target)throw fail(404,'Choose active source and target employee profiles.');
 const mappings=await run('SELECT * FROM employee_biometric_ids WHERE code=?'+(lock?' FOR UPDATE':''),[b.code]);
 const mapping=mappings[0];
 if(!mapping||![b.sourceEmployeeId,b.targetEmployeeId].includes(Number(mapping.employee_id)))throw fail(409,'This device number belongs to a different profile. Refresh the scanner list.');
 if(b.newProfile){
  if((await run('SELECT id FROM employees WHERE code=?',[b.newProfile.code])).length)throw fail(409,'That employee code already exists. Choose another code or the existing employee.');
  if(!(await run('SELECT id FROM companies WHERE id=?',[b.newProfile.companyId])).length)throw fail(400,'Choose a payroll company.');
 }
 const records=await run(`SELECT * FROM attendance WHERE identity_archived_at IS NULL AND employee_id IN (?,?) AND work_date BETWEEN ? AND ? ORDER BY id LIMIT 10001${lock?' FOR UPDATE':''}`,[source.id,target?.id||source.id,b.from,b.to]);
 if(records.length>10000)throw fail(400,'Choose a smaller date range.');
 const candidates=records.filter(row=>Number(row.employee_id)===Number(source.id)&&(row.biometric_code?row.biometric_code.toLowerCase()===b.code.toLowerCase():row.source==='Biometric'));
 if(candidates.length>5000)throw fail(400,'Choose at most 5000 attendance days.');
 const payroll=await run(`SELECT r.id,r.reference,r.status,r.company_id companyId,r.period_start periodStart,r.period_end periodEnd,s.id payslipId,s.employee_id employeeId
 FROM payroll_runs r JOIN payslips s ON s.run_id=r.id WHERE s.employee_id IN (?,?) AND r.period_start<=? AND r.period_end>=? ORDER BY r.id,s.id${lock?' FOR UPDATE':''}`,[source.id,target?.id||source.id,b.to,b.from]);
 const related=await run(`SELECT 'Reviewed OT' kind,employee_id employeeId,work_date workDate,id,status FROM visible_overtime_records WHERE employee_id IN (?,?) AND work_date BETWEEN ? AND ?
 UNION ALL SELECT 'Payroll claim',employee_id,work_date,id,status FROM visible_hr_payroll_claims WHERE employee_id IN (?,?) AND work_date BETWEEN ? AND ? ORDER BY kind,id`,[source.id,target?.id||source.id,b.from,b.to,source.id,target?.id||source.id,b.from,b.to]);
 const rows=candidates.map(row=>({id:row.id,workDate:row.work_date,checkIn:row.check_in,siteStop:row.site_stop,checkOut:row.check_out,state:row.state,workLocation:row.work_location,projectId:row.project_id,legacy:!row.biometric_code,corrected:Boolean(row.correction_reason),
  conflict:records.find(other=>Number(other.employee_id)===Number(target?.id)&&other.work_date===row.work_date)||null}));
 const digest=createHash('sha256').update(JSON.stringify({source,target:target||b.newProfile,mapping,records,payroll,related})).digest('hex');
 return {source,target:target||{name:b.newProfile.name,code:b.newProfile.code,newProfile:true},mapping,rows,payroll,related,digest};
}

export function registerBiometricCorrections(router){
 router.get('/correction-mappings',auth,permit('hr.attendance'),wrap(async(_req,res)=>res.json(await query(`SELECT b.code,b.scanner_name scannerName,e.id employeeId,e.name employee,e.code employeeCode FROM employee_biometric_ids b JOIN visible_employees e ON e.id=b.employee_id WHERE e.status<>'Left' ORDER BY e.name,b.code`))));
 router.get('/corrections/history',auth,permit('hr.attendance'),wrap(async(_req,res)=>res.json(await query(`SELECT a.id,a.created_at createdAt,u.name correctedBy,a.after_json detail FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.action='IDENTITY_TRANSFER' AND a.entity='attendance' ORDER BY a.id DESC LIMIT 30`))));
 router.post('/corrections/preview',auth,permit('hr.attendance'),validate(previewSchema),wrap(async(req,res)=>{
  res.json(await preview(query,req.body));
 }));
 router.post('/corrections/commit',auth,permit('hr.attendance'),validate(commitSchema),wrap(async(req,res)=>{
  const b=req.body;
  const result=await transaction(async connection=>{
   const run=async(sql,params=[])=>(await connection.query(sql,params))[0];
   // Mapping, payroll-company and employee locks prevent concurrent imports/payroll
   // from observing a half-corrected identity. All writes and audit commit together.
   await run('SELECT code FROM employee_biometric_ids WHERE code=? FOR UPDATE',[b.code]);
   await run('SELECT id FROM companies ORDER BY id FOR UPDATE');
   const p=await preview(run,b,true);
   if(p.digest!==b.digest)throw fail(409,'Attendance, mapping or payroll changed after preview. Preview again before transferring.');
   if(new Set(b.selections.map(s=>s.id)).size!==b.selections.length)throw fail(400,'Choose each attendance day only once.');
   const selected=b.selections.map(selection=>{const row=p.rows.find(r=>Number(r.id)===selection.id);if(!row)throw fail(409,'A selected record is not part of this preview.');
    if(Boolean(row.conflict)===(selection.decision==='Move'))throw fail(400,'Choose how to resolve each conflicting day.');return {...selection,row};});
   const affectedPayroll=p.payroll.filter(r=>selected.some(s=>r.periodStart<=s.row.workDate&&r.periodEnd>=s.row.workDate));
   if(b.newProfile&&selected.some(s=>s.row.workDate<b.newProfile.joinDate))throw fail(400,'The new employment start date must be on or before the selected attendance days.');
   if(selected.some(s=>s.row.legacy)&&!b.acknowledgeLegacy)throw fail(400,'Confirm that selected legacy records belong to this scanner person. Their machine ID was not saved.');
   if(affectedPayroll.some(r=>r.status!=='Draft')&&!b.acknowledgePayroll)throw fail(400,'Acknowledge the saved Approved/Paid payroll. This transfer does not correct or repay historical payroll.');
   let targetId=b.targetEmployeeId;
   if(b.newProfile){
    const n=b.newProfile;
    const added=await run(`INSERT INTO employees(code,name,designation,worker_type,payroll_category,join_date,status,payroll_company_id,notes) VALUES (?,?,'Worker',?,?,?,'Active',?,?)`,[n.code,n.name,n.workerType,n.workerType==='Office'?'Office employee':'Site labourer',n.joinDate,n.companyId,'Created during audited fingerprint identity correction. HR must complete pay profile.']);targetId=added.insertId;
    await audit(connection,req.user.id,'CREATE','employee',targetId,null,{...n,source:'Fingerprint identity correction'},req.ip);
   }
   const archive=async(id)=>{
    const [before]=await run('SELECT * FROM attendance WHERE id=? FOR UPDATE',[id]);
    await run('UPDATE attendance SET identity_archived_at=NOW(),identity_archived_employee_id=employee_id,employee_id=NULL WHERE id=?',[id]);
    await audit(connection,req.user.id,'IDENTITY_ARCHIVE','attendance',id,before,{archived:true,originalEmployeeId:before.employee_id,reason:b.reason,targetEmployeeId:targetId},req.ip);
   };
   let moved=0,kept=0;
   for(const s of selected){
    if(s.decision==='Keep target'){await archive(s.id);kept++;continue;}
    if(s.row.conflict)await archive(s.row.conflict.id);
    const [before]=await run('SELECT * FROM attendance WHERE id=?',[s.id]);
    await run('UPDATE attendance SET employee_id=?,employee_name=?,role=?,biometric_code=?,confirmed_by=? WHERE id=?',[targetId,p.target.name,b.newProfile?'Worker':(await run('SELECT designation FROM employees WHERE id=?',[targetId]))[0].designation||'Worker',b.code,req.user.id,s.id]);
    await audit(connection,req.user.id,'IDENTITY_MOVE','attendance',s.id,before,{employeeId:targetId,employeeName:p.target.name,biometricCode:b.code,reason:b.reason},req.ip);moved++;
   }
   await run('UPDATE employees SET biometric_id=NULL WHERE id=? AND biometric_id=?',[p.mapping.employee_id,b.code]);
   // Preserve the actual scanner-export alias while correcting its owner.
   await run('UPDATE employee_biometric_ids SET employee_id=?,scanner_name=? WHERE code=?',[targetId,p.mapping.scanner_name||p.target.name,b.code]);
   await run('UPDATE employees SET biometric_id=? WHERE id=? AND biometric_id IS NULL',[b.code,targetId]);
   const draftIds=[];
   for(const slip of affectedPayroll.filter(r=>r.status==='Draft')){
    const [row]=await run('SELECT calculation_detail FROM payslips WHERE id=? FOR UPDATE',[slip.payslipId]);const detail=parse(row.calculation_detail);
    detail.warnings=[...(detail.warnings||[]),{code:'ATTENDANCE_IDENTITY_TRANSFER',blocksApproval:true,message:'Fingerprint attendance identity changed. Explicitly regenerate this Draft payroll for both affected profiles before approval.'}];
    await run('UPDATE payslips SET calculation_detail=? WHERE id=?',[JSON.stringify(detail),slip.payslipId]);draftIds.push(slip.id);
   }
   const summary={code:b.code,sourceEmployeeId:p.source.id,sourceEmployee:p.source.name,targetEmployeeId:targetId,targetEmployee:p.target.name,from:b.from,to:b.to,reason:b.reason,selections:b.selections,records:selected.map(s=>({...s.row,decision:s.decision})),moved,kept,legacyConfirmed:b.acknowledgeLegacy,payrollAcknowledged:b.acknowledgePayroll,draftRunIds:[...new Set(draftIds)],savedPayroll:affectedPayroll.filter(r=>r.status!=='Draft'),relatedInputs:p.related};
   await audit(connection,req.user.id,'IDENTITY_TRANSFER','attendance',null,{mapping:p.mapping},summary,req.ip);
   return summary;
  }).catch(error=>{if(error.code==='ER_DUP_ENTRY')throw fail(409,'A profile or attendance record changed. Refresh the preview; no correction was saved.');throw error;});
  res.status(201).json(result);
 }));
}
