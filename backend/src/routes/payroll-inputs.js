import {Router} from 'express';
import {z} from 'zod';
import {query,getOne,transaction,audit,pool} from '../db.js';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {rulesFor,suggestOvertime,calculateMileage,calculateLongDistance,intervalsOverlap,minutes} from '../lib/hr-payroll-rules.js';
import {resolveOvertimeRate} from '../lib/payroll-policy.js';
const router=Router();router.use(auth,permit('hr.payroll'));
const parse=value=>typeof value==='string'?JSON.parse(value):value||{};
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
router.get('/',wrap(async(req,res)=>{
  const claims=await query(`SELECT c.*,e.name employee,p.name project FROM hr_payroll_claims c JOIN employees e ON e.id=c.employee_id LEFT JOIN projects p ON p.id=c.project_id ORDER BY c.work_date DESC,c.id DESC LIMIT 2000`);
  const attendance=await query(`SELECT a.*,e.payroll_company_id company_id,e.name employee,e.payroll_category,p.name project FROM attendance a JOIN employees e ON e.id=a.employee_id LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.work_date DESC LIMIT 2000`);
  const policies=await query('SELECT * FROM payroll_policies ORDER BY effective_from DESC,id DESC');
  const ot=await query('SELECT o.*,e.payroll_company_id company_id FROM overtime_records o JOIN employees e ON e.id=o.employee_id ORDER BY o.id DESC');
  const corrections=await query(`SELECT DISTINCT a.id,a.employee_id,a.work_date,a.project_id,'Attendance correction after draft' kind,'Needs review' status FROM attendance a JOIN audit_logs l ON l.entity='attendance' AND CAST(l.entity_id AS UNSIGNED)=a.id AND l.action='CORRECTION' JOIN payslips ps ON ps.employee_id=a.employee_id JOIN payroll_runs pr ON pr.id=ps.run_id AND pr.status='Draft' AND a.work_date BETWEEN pr.period_start AND pr.period_end WHERE l.created_at>pr.created_at`);
  const suggestions=attendance.map(a=>{
    const policy=policies.find(p=>p.company_id===a.company_id&&p.effective_from<=a.work_date);
    const suggestion=policy?suggestOvertime(a,rulesFor(policy)):{hours:0,warnings:['Configure an effective payroll policy.']};
    return {...a,suggestion,existing:ot.filter(o=>o.employee_id===a.employee_id&&o.work_date===a.work_date&&o.overtime_type!=='Travel')};
  });
  const issues=[...corrections];
  for(const row of attendance)if(!row.source||['Manual','Other'].includes(row.source)&&!row.source_notes)issues.push({...row,kind:'Missing supporting source',status:'Needs review'});
  const groups=new Map();for(const row of ot){const key=`${row.employee_id}:${row.work_date}:${row.overtime_type}`;groups.set(key,(groups.get(key)||0)+1);const policy=policies.find(p=>p.company_id===row.company_id&&p.effective_from<=row.work_date);if(policy&&row.hours>rulesFor(policy).maxDailyOt)issues.push({...row,kind:'High OT',status:'Needs review'});}
  for(const [key,count] of groups)if(count>1){const [employee_id,work_date]=key.split(':');issues.push({id:key,employee_id:Number(employee_id),work_date,kind:'Duplicate legacy OT',status:'Needs review'});}
  res.json({claims:claims.map(c=>({...c,detail:parse(c.detail),calculation:parse(c.calculation)})),suggestions,issues});
}));
const claimSchema=z.object({employeeId:z.number().int().positive(),workDate:date,projectId:z.number().int().positive().nullable().default(null),kind:z.enum(['Travel','Mileage','Special duty','Machine/operator']),departure:time.optional(),arrival:time.optional(),hours:z.number().nonnegative().max(24).default(0),distance:z.number().nonnegative().default(0),distanceType:z.enum(['One way','Return']).default('One way'),foodSupplied:z.boolean().default(false),startOdometer:z.number().nonnegative().optional(),endOdometer:z.number().nonnegative().optional(),approvedKm:z.number().nonnegative().optional(),fixedTravel:z.boolean().default(false),amount:z.number().nonnegative().default(0),source:z.string().trim().min(2).max(120),notes:z.string().max(2000).default(''),preview:z.boolean().default(false)});
router.post('/',validate(claimSchema),wrap(async(req,res)=>{
  const b=req.body;
  const id=await transaction(async conn=>{
    const q=async(sql,values)=>(await conn.query(sql,values))[0];
    const [employee]=await q('SELECT * FROM employees WHERE id=? FOR UPDATE',[b.employeeId]);if(!employee||employee.status==='Left')throw fail(400,'Select an active employee.');
    const [policy]=await q('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',[employee.payroll_company_id,b.workDate]);if(!policy)throw fail(409,'Configure an effective payroll policy before recording this claim.');
    if(b.projectId){const [project]=await q('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);if(!project)throw fail(400,'Choose an active project.');}
    const eligibility=parse(employee.allowance_eligibility);
    const key={Travel:'longDistance',Mileage:'motorcycle','Special duty':'specialDuty','Machine/operator':'machine'}[b.kind];
    if(b.kind!=='Travel'&&!eligibility[key])throw fail(409,'Enable the employee’s applicable allowance eligibility in Payroll settings before recording this claim.');
    const rules=rulesFor(policy);let calculation;
    if(b.kind==='Travel'){
      if(!b.projectId||!b.departure||!b.arrival||minutes(b.arrival)<=minutes(b.departure))throw fail(400,'Travel needs a project and return time after departure. Split overnight travel into separate dates.');
      if(b.hours>(minutes(b.arrival)-minutes(b.departure))/60)throw fail(400,'Travel OT hours cannot exceed the recorded travel interval.');
      const intervals=[[minutes(b.departure),minutes(b.arrival)]];
      const site=await q("SELECT input_detail FROM overtime_records WHERE employee_id=? AND work_date=? AND overtime_type IN ('Site','Office') AND status<>'Rejected'",[b.employeeId,b.workDate]);
      if(site.some(o=>!parse(o.input_detail).intervals||intervalsOverlap(intervals,parse(o.input_detail).intervals)))throw fail(409,'Travel overlaps Site/Office OT, or existing OT lacks intervals. Correct its intervals before recording travel.');
      calculation={allowance:eligibility.longDistance?calculateLongDistance(b.distance,rules):0,travelHours:b.hours,travelRate:resolveOvertimeRate(employee,'Travel',policy),intervals,qualifies:b.distance>rules.longDistanceKm,threshold:rules.longDistanceKm};
    }else if(b.kind==='Mileage'){
      try{calculation=calculateMileage(b,rules);}catch(e){throw fail(400,e.message);}
    }else calculation={amount:b.amount};
    if(b.preview)return {calculation,policyId:policy.id};
    const result=await q('INSERT INTO hr_payroll_claims(employee_id,work_date,project_id,kind,detail,calculation,policy_id,created_by) VALUES(?,?,?,?,?,?,?,?)',[b.employeeId,b.workDate,b.projectId,b.kind,JSON.stringify(b),JSON.stringify(calculation),policy.id,req.user.id]);
    await audit(conn,req.user.id,'CREATE','payroll_claim',result.insertId,null,{...b,calculation},req.ip);return result.insertId;
  });res.status(b.preview?200:201).json(b.preview?id:{id});
}));
router.patch('/:id/review',validate(z.object({status:z.enum(['Confirmed','Approved','Rejected']),reason:z.string().trim().min(3).max(1000)})),wrap(async(req,res)=>{
  await transaction(async conn=>{
    const [rows]=await conn.query('SELECT * FROM hr_payroll_claims WHERE id=? FOR UPDATE',[req.params.id]);const before=rows[0];if(!before)throw fail(404,'Claim not found.');
    const [paid]=await conn.query('SELECT id FROM payslip_components WHERE claim_id=?',[before.id]);if(paid.length||['Approved','Rejected'].includes(before.status))throw fail(409,'This reviewed claim is locked. Use a new adjustment rather than altering payroll history.');
    if(req.body.status==='Approved'&&before.status!=='Confirmed')throw fail(409,'Review and confirm this claim before final approval.');
    const [policyRows]=await conn.query('SELECT * FROM payroll_policies WHERE id=?',[before.policy_id]);
    if(req.body.status==='Approved'&&rulesFor(policyRows[0]).separateApproval&&before.created_by===req.user.id)throw fail(403,'This policy requires a different HR user to give final approval.');
    if(before.kind==='Travel'&&req.body.status==='Approved'){
      const c=parse(before.calculation);
      if(c.travelHours>0){const [existing]=await conn.query("SELECT id FROM overtime_records WHERE employee_id=? AND work_date=? AND overtime_type='Travel'",[before.employee_id,before.work_date]);if(existing.length)throw fail(409,'Travel OT already exists for this employee and date. Resolve the existing record first.');
        await conn.query("INSERT INTO overtime_records(employee_id,project_id,work_date,overtime_type,hours,rate,policy_id,status,approved_by,input_detail) VALUES(?,?,?,'Travel',?,?,?,'Approved',?,?)",[before.employee_id,before.project_id,before.work_date,c.travelHours,c.travelRate,before.policy_id,req.user.id,JSON.stringify({claimId:before.id,intervals:c.intervals})]);}
    }
    await conn.query('UPDATE hr_payroll_claims SET status=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?',[req.body.status,req.user.id,before.id]);
    await audit(conn,req.user.id,req.body.status.toUpperCase(),'payroll_claim',before.id,before,req.body,req.ip);
  });res.json({id:Number(req.params.id)});
}));
router.post('/suggestions/:attendanceId',validate(z.object({hours:z.number().positive().max(24),reason:z.string().trim().min(3).max(1000)})),wrap(async(req,res)=>{
  const attendance=await getOne('SELECT * FROM attendance WHERE id=?',[req.params.attendanceId]);if(!attendance)throw fail(404,'Attendance not found.');
  const employee=await getOne('SELECT * FROM employees WHERE id=?',[attendance.employee_id]);
  const policy=await getOne('SELECT * FROM payroll_policies WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',[employee.payroll_company_id,attendance.work_date]);if(!policy)throw fail(409,'Configure a payroll policy for this date.');
  const suggestion=suggestOvertime(attendance,rulesFor(policy));
  if(!suggestion.intervals.length)throw fail(409,'Valid attended times are required. No payable OT is allowed on absent or leave days.');
  const type=attendance.work_location==='Office'?'Office':'Site';
  await transaction(async conn=>{
    await conn.query('SELECT id FROM employees WHERE id=? FOR UPDATE',[employee.id]);
    const [existing]=await conn.query('SELECT * FROM overtime_records WHERE employee_id=? AND work_date=?',[employee.id,attendance.work_date]);
    if(existing.some(o=>o.overtime_type===type))throw fail(409,'OT of this type already exists for this employee and date.');
    const [claims]=await conn.query("SELECT calculation FROM hr_payroll_claims WHERE employee_id=? AND work_date=? AND kind='Travel' AND status<>'Rejected'",[employee.id,attendance.work_date]);
    if(claims.some(c=>intervalsOverlap(suggestion.intervals,parse(c.calculation).intervals||[])))throw fail(409,'Site/Office OT overlaps a travel interval. Correct the attendance or travel record first.');
    const [result]=await conn.query('INSERT INTO overtime_records(employee_id,project_id,work_date,overtime_type,hours,rate,policy_id,input_detail) VALUES(?,?,?,?,?,?,?,?)',[employee.id,attendance.project_id,attendance.work_date,type,req.body.hours,resolveOvertimeRate(employee,type,policy),policy.id,JSON.stringify({attendanceId:attendance.id,suggestion,intervals:suggestion.intervals,reason:req.body.reason})]);
    await audit(conn,req.user.id,'SUGGESTION_CONFIRMED','overtime',result.insertId,null,{...req.body,suggestion},req.ip);
  });res.status(201).json({message:'Pending OT recorded. HR must review and approve it before payroll.'});
}));
export default router;
