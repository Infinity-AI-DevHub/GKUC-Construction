import {audit,nextReference} from '../db.js';
import {fail} from './http.js';
import {clean,inspectLinked,linkKind} from './linked-historical-import.js';

export async function saveLinked(connection,req,batch,preview){
 const run=async(sql,params=[])=> (await connection.execute(sql,params))[0];
 // Lock a shared, bounded set before resolving source keys, so two imports cannot race.
 await run('SELECT id FROM companies ORDER BY id FOR UPDATE');
 const checked=await inspectLinked(batch.kind,preview.rows,{employeeMap:preview.employeeMap},run);
 if(checked.counts.blocked)throw fail(409,'Resolve every highlighted issue and save the review before confirming.');
 const links=await run('SELECT kind,source_code sourceCode,target_id targetId FROM historical_import_links');
 const target=(kind,code)=>links.find(l=>l.kind===linkKind(kind)&&l.sourceCode===clean(code))?.targetId;
 const employee=code=>checked.context.employees.find(e=>checked.employeeMap[clean(code)]?Number(e.id)===Number(checked.employeeMap[clean(code)]):e.code===clean(code));
 let created=0,linked=0,skipped=0;
 const tables={clients:'clients',contacts:'client_contact_people',projects:'projects',team:'project_team',boqs:'boqs',items:'boq_items'};
 for(const record of checked.rows){
  const {type,data:d,code}=record;
  if(record.action==='skip'){
   const [exists]=await run(`SELECT id FROM ${tables[type]} WHERE id=?`,[target(type,code)]);
   if(!exists)throw fail(409,`${record.sheet} ${code}: the previously imported target no longer exists. Resolve the source link before importing.`);
   skipped++;continue;
  }
  let id=record.targetId||null;
  if(type==='clients'){
   if(!id){const result=await run(`INSERT INTO clients (type,name,registration_number,tin,vat_number,billing_address,site_address,phone,email,contact_person,active,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [clean(d.CLIENT_TYPE)==='Individual'?'Private':'Organisation',clean(d.CLIENT_NAME),clean(d.BUSINESS_REGISTRATION_NO)||null,clean(d.TIN)||null,clean(d.VAT_NUMBER)||null,clean(d.BILLING_ADDRESS),clean(d.SITE_ADDRESS)||null,clean(d.PHONE)||null,clean(d.EMAIL)||null,clean(d.CONTACT_PERSON)||null,d.ACTIVE==='Yes'?1:0,clean(d.NOTES)||null]);id=result.insertId;}
  }else if(type==='contacts'){
   const clientId=target('clients',d.CLIENT_CODE);if(!clientId)throw fail(409,'Import clients before contacts.');
   const result=await run('INSERT INTO client_contact_people (client_id,name,job_title,phone,email,is_primary,notes) VALUES (?,?,?,?,?,?,?)',
    [clientId,clean(d.CONTACT_NAME),clean(d.JOB_TITLE)||null,clean(d.PHONE)||null,clean(d.EMAIL)||null,d.PRIMARY_CONTACT==='Yes'?1:0,clean(d.NOTES)||null]);id=result.insertId;
   if(d.PRIMARY_CONTACT==='Yes'){
    const [primary]=await run('SELECT id FROM client_contact_people WHERE client_id=? AND is_primary=1 AND id<>? LIMIT 1',[clientId,id]);if(primary)throw fail(409,'This client already has a primary contact. Review the contact choice.');
    const [beforeClient]=await run('SELECT id,contact_person,phone,email FROM clients WHERE id=? FOR UPDATE',[clientId]);
    await run("UPDATE clients SET contact_person=COALESCE(NULLIF(contact_person,''),?),phone=COALESCE(NULLIF(phone,''),?),email=COALESCE(NULLIF(email,''),?) WHERE id=?",[clean(d.CONTACT_NAME),clean(d.PHONE)||null,clean(d.EMAIL)||null,clientId]);
    const [afterClient]=await run('SELECT id,contact_person,phone,email FROM clients WHERE id=?',[clientId]);
    if(JSON.stringify(beforeClient)!==JSON.stringify(afterClient))await audit(connection,req.user.id,'IMPORT_CONTACT','client',clientId,beforeClient,{...afterClient,importBatchId:batch.id},req.ip);
   }
  }else if(type==='projects'){
   const clientId=target('clients',d.CLIENT_CODE),manager=employee(d.PROJECT_MANAGER_EMPLOYEE_CODE);if(!clientId||!manager)throw fail(409,'Import the client and map the project manager first.');
   if(id){const [project]=await run('SELECT client_id FROM projects WHERE id=?',[id]);if(Number(project?.client_id)!==Number(clientId))throw fail(409,'The selected project belongs to a different client than CLIENT_CODE.');}
   else{
    const [client]=await run('SELECT name FROM clients WHERE id=?',[clientId]);if(!client)throw fail(409,'Linked client no longer exists.');
    const result=await run(`INSERT INTO projects (name,client,client_id,manager,manager_employee_id,progress,budget,health,stage,site,start_date,end_date,active,company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
     [clean(d.PROJECT_NAME),client.name,clientId,manager.name,manager.id,Number(d.PROGRESS_PERCENT),Number(d.CURRENT_BUDGET_LKR||0),d.STATUS==='Completed'?'Completed':clean(d.HEALTH),clean(d.STAGE),clean(d.SITE_ADDRESS),d.START_DATE,d.END_DATE||null,d.STATUS==='Archived'?0:1,d.COMPANY==='GKUC Readymix'?2:1]);id=result.insertId;
    if(d.AWARD_REFERENCE&&d.AWARD_DATE)await run('INSERT INTO project_awards (project_id,award_date,reference,notes,recorded_by) VALUES (?,?,?,?,?)',[id,d.AWARD_DATE,clean(d.AWARD_REFERENCE),clean(d.NOTES).slice(0,1000)||null,req.user.id]);
   }
  }else if(type==='team'){
   const projectId=target('projects',d.PROJECT_CODE),member=employee(d.EMPLOYEE_CODE);if(!projectId||!member)throw fail(409,'Import the project and map every team member first.');
   const [existing]=await run('SELECT id,project_role,released_at FROM project_team WHERE project_id=? AND employee_id=?',[projectId,member.id]);
   if(existing){if(existing.project_role!==clean(d.PROJECT_ROLE))throw fail(409,'The selected employee is already on this project with a different role. Review before linking.');id=existing.id;}
   else{const result=await run('INSERT INTO project_team (project_id,employee_id,project_role,assigned_at,released_at) VALUES (?,?,?,COALESCE(?,CURRENT_TIMESTAMP),?)',[projectId,member.id,clean(d.PROJECT_ROLE),d.ASSIGNED_DATE||null,d.RELEASED_DATE||null]);id=result.insertId;}
  }else if(type==='boqs'){
   const projectId=target('projects',d.PROJECT_CODE);if(!projectId)throw fail(409,'Import the project before its BOQs.');
   const reference=await nextReference('BOQ','boqs');
   const notes=[`Source reference: ${clean(d.ORIGINAL_REFERENCE)}`,`Source status: ${clean(d.STATUS)}`,`Source file: ${clean(d.SOURCE_FILENAME)}`,clean(d.NOTES)].filter(Boolean).join('\n').slice(0,1000);
   const result=await run("INSERT INTO boqs (project_id,reference,title,status,total,prepared_by,notes,terms) VALUES (?,?,?,'Draft',?,?,?,?)",[projectId,reference,clean(d.TITLE),Number(d.DECLARED_TOTAL_LKR),req.user.id,notes,clean(d.TERMS)||null]);id=result.insertId;
  }else if(type==='items'){
   const boqId=target('boqs',d.BOQ_CODE);if(!boqId)throw fail(409,'Every BOQ item must match a BOQ header.');
   // A header skipped from an earlier import must never receive new lines silently.
   const header=checked.rows.find(r=>r.type==='boqs'&&r.code===clean(d.BOQ_CODE));
   if(!header||header.action==='skip')throw fail(409,'New lines cannot be appended to a previously imported BOQ. Review it in QS instead.');
   const notes=[`Source line: ${clean(d.LINE_NO)}`,d.AREA_SECTION?`Area / section: ${clean(d.AREA_SECTION)}`:'',clean(d.NOTES)].filter(Boolean).join('\n');
   const result=await run('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,method,notes) VALUES (?,?,?,?,?,?,?,?,?)',[boqId,clean(d.CATEGORY),clean(d.DESCRIPTION),clean(d.UNIT),Number(d.QUANTITY),Number(d.RATE_LKR),Math.round(Number(d.QUANTITY)*Number(d.RATE_LKR)*100)/100,clean(d.METHOD_STATEMENT)||null,notes]);id=result.insertId;
  }
  await run('INSERT INTO historical_import_links (kind,source_code,target_id,batch_id,source_json) VALUES (?,?,?,?,?)',[linkKind(type),code,id,batch.id,JSON.stringify(d)]);
  links.push({kind:linkKind(type),sourceCode:code,targetId:id});
  await audit(connection,req.user.id,record.action==='link'?'IMPORT_LINK':'IMPORT_CREATE',tables[type],id,null,{sourceCode:code,importBatchId:batch.id,source:d},req.ip);
  if(record.action==='link')linked++;else created++;
 }
 await run("UPDATE historical_import_batches SET status='Imported',confirmed_by=?,confirmed_at=NOW() WHERE id=?",[req.user.id,batch.id]);
 await audit(connection,req.user.id,'IMPORT_CONFIRM','historical_import',batch.id,null,{kind:batch.kind,created,linked,skipped},req.ip);
 return {id:batch.id,status:'Imported',created,linked,skipped};
}
