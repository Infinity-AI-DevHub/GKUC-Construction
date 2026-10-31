import {getOne,query} from '../db.js';

export function colomboClock(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return {day:`${fields.year}-${fields.month}-${fields.day}`,time:`${fields.hour}:${fields.minute}`};
}

export async function missingCheckouts(companyId,{details=false,offset=0,now=new Date()}={}){
  const {day,time}=colomboClock(now);
  const policy=await getOne('SELECT hr_rules FROM payroll_policies WHERE archive_key=0 AND company_id=? AND effective_from<=? ORDER BY effective_from DESC,id DESC LIMIT 1',[companyId,day]);
  const rules=typeof policy?.hr_rules==='string'?JSON.parse(policy.hr_rules):policy?.hr_rules;
  const end=rules?.normalEnd||'16:30';
  const from=`FROM visible_attendance a JOIN visible_employees e ON a.employee_id=e.id
    OR (a.employee_id IS NULL AND a.employee_name=e.name AND (SELECT COUNT(*) FROM visible_employees n WHERE n.name=e.name)=1)
    LEFT JOIN projects p ON p.id=a.project_id
    WHERE e.payroll_company_id=? AND e.status<>'Left' AND a.check_in IS NOT NULL AND a.check_out IS NULL
      AND a.state NOT IN ('Absent','On leave','Business trip')
      AND (a.work_date<? OR (a.work_date=? AND ?>=?))`;
  const params=[companyId,day,day,time,end];
  const counts=await getOne(`SELECT COUNT(DISTINCT e.id) employeeCount,COUNT(*) recordCount ${from}`,params);
  // mysql2 sends numeric parameters as DOUBLE; MySQL OFFSET needs an integer-compatible binding.
  const records=details?await query(`SELECT a.id,e.id employeeId,e.name,e.code employeeCode,DATE_FORMAT(a.work_date,'%Y-%m-%d') workDate,
    a.check_in \`in\`,a.check_out \`out\`,a.state,a.work_location workLocation,a.project_id projectId,
    COALESCE(p.name,'Head office') site,a.source ${from} ORDER BY a.work_date,e.name,a.id LIMIT 50 OFFSET ?`,[...params,String(offset)]):[];
  return {employeeCount:Number(counts.employeeCount),recordCount:Number(counts.recordCount),records,offset,
    hasMore:details&&offset+records.length<Number(counts.recordCount),day,shiftEnd:end};
}
