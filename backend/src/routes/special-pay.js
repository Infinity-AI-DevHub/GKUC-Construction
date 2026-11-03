import {Router} from 'express';
import {z} from 'zod';
import {query,transaction,audit} from '../db.js';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {SPECIAL_PAY_RATES} from '../lib/special-pay.js';
import {publishChange} from '../lib/realtime.js';
const router=Router();router.use(auth,permit('hr.payroll'));
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Enter a valid date');
const employeeId=z.number().int().positive();
const reason=z.string().trim().min(3).max(500);
router.get('/',wrap(async(req,res)=>{
  const companyId=Number(req.query.companyId);
  if(!Number.isInteger(companyId)||companyId<1)throw fail(400,'Choose a payroll company.');
  const [profiles,days]=await Promise.all([
    query(`SELECT r.*,e.name employee,e.code employeeCode FROM employee_special_pay_rules r JOIN visible_employees e ON e.id=r.employee_id WHERE e.payroll_company_id=? ORDER BY r.effective_from DESC,r.id DESC`,[companyId]),
    query(`SELECT d.*,e.name employee,e.code employeeCode FROM employee_special_pay_days d JOIN visible_employees e ON e.id=d.employee_id WHERE e.payroll_company_id=? AND d.active=1 ORDER BY d.work_date DESC,d.id DESC LIMIT 1000`,[companyId])]);
  res.json({profiles,days,rates:SPECIAL_PAY_RATES});
}));
async function save(req,res,table,key,body){
  const id=await transaction(async conn=>{
    const [[employee]]=await conn.execute("SELECT id FROM visible_employees WHERE id=? AND status<>'Left' FOR UPDATE",[body.employeeId]);
    if(!employee)throw fail(404,'Active employee not found.');
    const [[before]]=await conn.execute(`SELECT * FROM ${table} WHERE employee_id=? AND ${key}=? FOR UPDATE`,[body.employeeId,body.date]);
    if(table==='employee_special_pay_days'){
      const [[rule]]=await conn.execute('SELECT mode FROM employee_special_pay_rules WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',[body.employeeId,body.date]);
      if(!rule||rule.mode==='Standard')throw fail(409,'Save an effective special pay rule for this employee first.');
      if(rule.mode==='Work role'&&!['Bass','Gola'].includes(body.kind)||rule.mode==='Machine operator'&&!['Machine','Standby'].includes(body.kind))throw fail(400,'Choose a work type matching the employee’s effective pay rule.');
    }
    let result;
    if(table==='employee_special_pay_rules'){
      [result]=await conn.execute(`INSERT INTO employee_special_pay_rules(employee_id,effective_from,mode,rates,reason,recorded_by)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE mode=VALUES(mode),rates=VALUES(rates),reason=VALUES(reason),recorded_by=VALUES(recorded_by)`,
        [body.employeeId,body.date,body.mode,JSON.stringify(SPECIAL_PAY_RATES),body.reason,req.user.id]);
    }else{
      [result]=await conn.execute(`INSERT INTO employee_special_pay_days(employee_id,work_date,work_kind,start_meter,end_meter,hours,reason,recorded_by)
        VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE active=1,work_kind=VALUES(work_kind),start_meter=VALUES(start_meter),end_meter=VALUES(end_meter),hours=VALUES(hours),reason=VALUES(reason),recorded_by=VALUES(recorded_by)`,
        [body.employeeId,body.date,body.kind,body.startMeter??null,body.endMeter??null,body.hours??null,body.reason,req.user.id]);
    }
    const [[after]]=await conn.execute(`SELECT * FROM ${table} WHERE employee_id=? AND ${key}=?`,[body.employeeId,body.date]);
    await audit(conn,req.user.id,before?'UPDATE':'CREATE',table,after.id,before||null,after,req.ip);
    return after.id;
  });
  publishChange('payroll',{});res.status(200).json({id});
}
router.post('/rules',validate(z.object({employeeId,date,mode:z.enum(['Work role','Machine operator','Standard']),reason})),wrap((req,res)=>save(req,res,'employee_special_pay_rules','effective_from',req.body)));
router.post('/days',validate(z.object({employeeId,date,kind:z.enum(['Bass','Gola','Machine','Standby']),
  startMeter:z.number().nonnegative().max(999999999).optional(),endMeter:z.number().nonnegative().max(999999999).optional(),
  hours:z.number().positive().max(24).optional(),reason}).superRefine((b,c)=>{
    if(b.kind==='Machine'&&(!(b.endMeter>b.startMeter)||b.endMeter-b.startMeter>24||b.hours!==undefined))c.addIssue({code:'custom',message:'Enter an end meter greater than the start meter, without standby hours.'});
    if(b.kind==='Standby'&&(b.hours===undefined||b.startMeter!==undefined||b.endMeter!==undefined))c.addIssue({code:'custom',message:'Enter standby attendance hours without meter readings.'});
    if(['Bass','Gola'].includes(b.kind)&&(b.hours!==undefined||b.startMeter!==undefined||b.endMeter!==undefined))c.addIssue({code:'custom',message:'Bass/Gola hours come from saved attendance.'});
  })),wrap((req,res)=>save(req,res,'employee_special_pay_days','work_date',req.body)));
router.post('/days/:id/archive',validate(z.object({reason})),wrap(async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)throw fail(400,'Choose a daily record.');
  await transaction(async conn=>{
    const [[record]]=await conn.execute('SELECT d.* FROM employee_special_pay_days d JOIN visible_employees e ON e.id=d.employee_id WHERE d.id=? FOR UPDATE',[id]);
    if(!record)throw fail(404,'Daily record not found.');
    await conn.execute('UPDATE employee_special_pay_days SET active=0 WHERE id=?',[id]);
    await audit(conn,req.user.id,'ARCHIVE','employee_special_pay_days',id,record,{...record,active:0,archiveReason:req.body.reason},req.ip);
  });res.json({id});
}));
export default router;
