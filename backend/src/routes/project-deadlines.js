import {z} from 'zod';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {transaction,query,getOne,audit} from '../db.js';
import {documentContext,projectExtensionDocument} from '../lib/documents.js';
import {sendDocument} from '../lib/document-pdf.js';
import {calendarDate} from '../lib/project-deadlines.js';
export const projectDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Enter a valid calendar date');
export function installProjectDeadlines(router){
 router.get('/:id/extensions',auth,permit('projects.view','projects.manage'),wrap(async(req,res)=>{
  res.json(await query('SELECT id,reference,previous_end_date previousEndDate,new_end_date newEndDate,reason,request_date requestDate,created_at createdAt FROM project_extensions WHERE project_id=? ORDER BY id DESC',[req.params.id]));
 }));
 router.post('/:id/extensions',auth,permit('projects.manage'),validate(z.object({
  previousEndDate:projectDate,newEndDate:projectDate,requestDate:projectDate,reason:z.string().trim().min(3).max(6000),
  recipientName:z.string().trim().min(2).max(1000),recipientAddress:z.string().trim().max(2000).default(''),
  signatoryName:z.string().trim().min(2).max(180),signatoryTitle:z.string().trim().min(2).max(180)
 })),wrap(async(req,res)=>{
  const b=req.body;
  if(b.newEndDate<=b.previousEndDate)throw fail(400,'The extended end date must be after the current end date.');
  const result=await transaction(async connection=>{
   const [[project]]=await connection.execute('SELECT * FROM projects WHERE id=? AND active=1 FOR UPDATE',[req.params.id]);
   if(!project)throw fail(404,'Project not found.');
   if(project.stage==='Completed'||project.site_status==='Completed'||project.health==='Completed')throw fail(409,'Reopen the completed project before extending it.');
   if(calendarDate(project.end_date)!==b.previousEndDate)throw fail(409,'The project end date changed. Reload and review the latest date.');
   if(project.start_date&&b.newEndDate<calendarDate(project.start_date))throw fail(400,'The revised end date cannot precede the project start date.');
   const count=Number(project.extension_count||0)+1,reference=`PEX-${project.id}-${count}`;
   const context=await documentContext(getOne,project.company_id);
   const html=projectExtensionDocument({...context,project,extension:{...b,reference}});
   const [created]=await connection.execute(`INSERT INTO project_extensions (project_id,reference,previous_end_date,new_end_date,reason,request_date,letter_html,created_by) VALUES (?,?,?,?,?,?,?,?)`,[project.id,reference,b.previousEndDate,b.newEndDate,b.reason,b.requestDate,html,req.user.id]);
   await connection.execute('UPDATE projects SET end_date=?,extension_count=? WHERE id=?',[b.newEndDate,count,project.id]);
   await audit(connection,req.user.id,'EXTEND','project',project.id,project,{...project,end_date:b.newEndDate,extension_count:count,extensionId:created.insertId,reason:b.reason},req.ip);
   await audit(connection,req.user.id,'CREATE','project_extension',created.insertId,null,{...b,reference,projectId:project.id},req.ip);
   return {id:created.insertId,reference,endDate:b.newEndDate};
  });res.status(201).json(result);
 }));
 router.get('/:id/extensions/:extensionId/letter',auth,permit('projects.view','projects.manage'),wrap(async(req,res)=>{
  const row=await getOne('SELECT reference,letter_html html FROM project_extensions WHERE id=? AND project_id=?',[req.params.extensionId,req.params.id]);
  if(!row)throw fail(404,'Extension letter not found.');
  await sendDocument(req,res,row.html,`${row.reference}.pdf`);
 }));
}
