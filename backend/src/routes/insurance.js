import {Router} from 'express';
import {z} from 'zod';
import {query,transaction,audit} from '../db.js';
import {auth,permit,validate,wrap} from '../lib/http.js';
const router=Router();
router.use(auth,permit('hr.insurance'));
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'Choose a valid calendar date');
const id=z.number().int().positive().nullable();
const schema=z.object({name:z.string().trim().min(2).max(180),kind:z.enum(['Work site','Employee life','Vehicle']),projectId:id.default(null),employeeId:id.default(null),vehicleId:id.default(null),insurer:z.string().max(180).default(''),policyNumber:z.string().max(120).default(''),startDate:date,endDate:date,expiryDate:date,premium:z.number().nonnegative().max(9999999999).default(0),contact:z.string().max(300).default(''),coverage:z.string().max(20000).default(''),notes:z.string().max(20000).default(''),status:z.enum(['Active','Archived']).default('Active'),reminders:z.array(z.discriminatedUnion('unit',[
  z.object({unit:z.literal('Date'),date}),...['Days','Weeks','Months'].map(unit=>z.object({unit:z.literal(unit),value:z.number().int().min(0).max(unit==='Months'?120:3650)}))
])).max(30)}).superRefine((b,ctx)=>{
  if(b.endDate<b.startDate||b.expiryDate<b.startDate)ctx.addIssue({code:'custom',message:'Policy end and expiry dates cannot be before the start date.'});
  if(!(b.kind==='Work site'?b.projectId:b.kind==='Employee life'?b.employeeId:b.vehicleId))ctx.addIssue({code:'custom',message:'Select the project, employee or vehicle covered by this insurance.'});
});
const select=`SELECT i.*,COALESCE(vd.expiry_date,i.expiry_date) effective_expiry,COALESCE(vd.reference,i.policy_number) effective_reference,COALESCE(vd.cost,i.premium) effective_premium,p.name project,e.name employee,f.registration vehicle FROM hr_insurance i
 LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN employees e ON e.id=i.employee_id LEFT JOIN fleet f ON f.id=i.vehicle_id
 LEFT JOIN vehicle_documents vd ON vd.vehicle_id=i.vehicle_id AND vd.doc_type='Insurance' AND i.status='Active'`;
const map=row=>({...row,expiry_date:row.effective_expiry,policy_number:row.effective_reference,premium:row.effective_premium,reminders:typeof row.reminders==='string'?JSON.parse(row.reminders):row.reminders});
router.get('/',wrap(async(_req,res)=>{
  const [policies,fleetOnly]=await Promise.all([
    query(`${select} ORDER BY i.id DESC`),
    query(`SELECT d.vehicle_id vehicleId,f.vehicle,f.registration,d.reference,d.expiry_date expiryDate,d.cost,
      (SELECT r.renewed_on FROM vehicle_document_renewals r WHERE r.vehicle_id=d.vehicle_id AND r.doc_type='Insurance'
        ORDER BY r.id DESC LIMIT 1) renewedOn
      FROM vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id WHERE d.doc_type='Insurance'
        AND NOT EXISTS(SELECT 1 FROM hr_insurance i WHERE i.vehicle_id=d.vehicle_id AND i.kind='Vehicle')
      ORDER BY f.registration`)
  ]);
  res.json([...policies.map(map),...fleetOnly.map(row=>({
    id:`fleet-${row.vehicleId}`,isFleetOnly:true,name:`${row.vehicle} (${row.registration}) insurance`,kind:'Vehicle',
    project_id:null,employee_id:null,vehicle_id:row.vehicleId,vehicle:row.registration,
    insurer:'',policy_number:row.reference||'',start_date:row.renewedOn||null,
    end_date:row.expiryDate,expiry_date:row.expiryDate,premium:row.cost,
    contact:'',coverage:'',notes:'This policy was recorded in Fleet. Add the remaining details and reminders here.',
    reminders:[],status:'Active'
  }))]);
}));
router.get('/options',wrap(async(_req,res)=>res.json({projects:await query('SELECT id,name FROM projects WHERE active=1 ORDER BY name'),employees:await query("SELECT id,name,code FROM employees WHERE status<>'Left' ORDER BY name"),vehicles:await query('SELECT id,registration name FROM fleet ORDER BY registration')})));
async function save(req,res){
  const b=req.body;
  const result=await transaction(async conn=>{
    let before=null;
    if(req.params.id){const [rows]=await conn.query('SELECT * FROM hr_insurance WHERE id=? FOR UPDATE',[req.params.id]);before=rows[0];if(!before)throw Object.assign(new Error('Insurance record not found.'),{status:404});}
    const projectId=b.kind==='Work site'?b.projectId:null,employeeId=b.kind==='Employee life'?b.employeeId:null,vehicleId=b.kind==='Vehicle'?b.vehicleId:null;
    const table=b.kind==='Work site'?'projects':b.kind==='Employee life'?'employees':'fleet';
    const [linked]=await conn.query(`SELECT id FROM ${table} WHERE id=? FOR UPDATE`,[projectId||employeeId||vehicleId]);
    if(!linked.length)throw Object.assign(new Error('The selected project, employee or vehicle no longer exists. Refresh and select another.'),{status:400});
    if(vehicleId&&b.status==='Active'){
      const [other]=await conn.query("SELECT id FROM hr_insurance WHERE vehicle_id=? AND status='Active' AND id<>?",[vehicleId,before?.id||0]);
      if(other.length)throw Object.assign(new Error('This vehicle already has an active HR insurance policy. Edit it or archive it before adding its replacement.'),{status:409});
      const [[current]]=await conn.query("SELECT reference,expiry_date expiryDate,cost FROM vehicle_documents WHERE vehicle_id=? AND doc_type='Insurance' FOR UPDATE",[vehicleId]);
      await conn.query(`INSERT INTO vehicle_documents(vehicle_id,doc_type,reference,expiry_date,cost) VALUES(?,'Insurance',?,?,?) ON DUPLICATE KEY UPDATE reference=VALUES(reference),expiry_date=VALUES(expiry_date),cost=VALUES(cost)`,[vehicleId,b.policyNumber,b.expiryDate,b.premium]);
      await conn.query("UPDATE fleet SET due_date=? WHERE id=? AND renewal_type='Insurance'",[b.expiryDate,vehicleId]);
      if(!current||(current.reference||'')!==b.policyNumber||String(current.expiryDate).slice(0,10)!==b.expiryDate||Number(current.cost)!==Number(b.premium)){
        const [[last]]=await conn.query(`SELECT reference,renewed_on renewedOn,expiry_date expiryDate,cost
          FROM vehicle_document_renewals WHERE vehicle_id=? AND doc_type='Insurance' ORDER BY id DESC LIMIT 1 FOR UPDATE`,[vehicleId]);
        if(!last||(last.reference||'')!==b.policyNumber||String(last.renewedOn).slice(0,10)!==b.startDate
          ||String(last.expiryDate).slice(0,10)!==b.expiryDate||Number(last.cost)!==Number(b.premium))
          await conn.query(`INSERT INTO vehicle_document_renewals
            (vehicle_id,doc_type,reference,renewed_on,expiry_date,cost,recorded_by)
            VALUES (?,'Insurance',?,?,?,?,?)`,[vehicleId,b.policyNumber||null,b.startDate,b.expiryDate,b.premium,req.user.id]);
      }
    }
    const values=[b.name,b.kind,projectId,employeeId,vehicleId,b.insurer,b.policyNumber,b.startDate,b.endDate,b.expiryDate,b.premium,b.contact,b.coverage,b.notes,JSON.stringify(b.reminders),b.status];
    let recordId=before?.id;
    if(before)await conn.query('UPDATE hr_insurance SET name=?,kind=?,project_id=?,employee_id=?,vehicle_id=?,insurer=?,policy_number=?,start_date=?,end_date=?,expiry_date=?,premium=?,contact=?,coverage=?,notes=?,reminders=?,status=? WHERE id=?',[...values,recordId]);
    else {const [result]=await conn.query('INSERT INTO hr_insurance(name,kind,project_id,employee_id,vehicle_id,insurer,policy_number,start_date,end_date,expiry_date,premium,contact,coverage,notes,reminders,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[...values,req.user.id]);recordId=result.insertId;}
    await audit(conn,req.user.id,before?'UPDATE':'CREATE','insurance',recordId,before,b,req.ip);
    return recordId;
  });
  res.status(req.params.id?200:201).json({id:result});
}
router.post('/',validate(schema),wrap(save));
router.patch('/:id',validate(schema),wrap(save));
export default router;
