import crypto from 'node:crypto';
import {z} from 'zod';
import {query,getOne,pool,transaction,audit,nextReference} from '../db.js';
import {auth,permit,wrap,fail,validate} from '../lib/http.js';
import {readUpload,readUploadedFile} from '../lib/storage.js';
import {writeWorkbook,STYLE} from '../lib/xlsx-write.js';
import {bondColumns,bondData,bondSnapshot,parseBondWorkbook,dbFields} from '../lib/bond-import.js';

export function installBondImport(router,bondFields){
 const base='/receivables/bonds/import';
 const access=[auth,permit('finance.invoice')];
 const companySchema=z.coerce.number().int().positive();
 router.get(`${base}/template`,...access,wrap(async(req,res)=>{
   const companyId=companySchema.parse(req.query.companyId);
   const records=await query('SELECT * FROM bank_bonds WHERE company_id=? ORDER BY id',[companyId]);
   const rows=[bondColumns.map(([,label])=>({value:label,style:STYLE.HEADER})),...records.map(row=>{const data=bondData(row);return bondColumns.map(([key])=>data[key]);})];
   const bytes=writeWorkbook([{name:'Bonds',rows,freeze:1,columns:bondColumns.map(()=>24)}]);
   res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('bond-import.xlsx').send(bytes);
 }));
 router.post(`${base}/preview`,...access,wrap(async(req,res)=>{
   const {file,fields,discard}=await readUpload(req);
   try{
     const companyId=companySchema.parse(fields.companyId);
     if(!await getOne('SELECT id FROM companies WHERE id=? AND active=1',[companyId]))throw fail(400,'Choose an active company.');
     if(!/\.xlsx$/i.test(file.filename))throw fail(422,'Upload an Excel .xlsx workbook. Save older .xls files as .xlsx first.');
     const bytes=await readUploadedFile(file.path),checksum=crypto.createHash('sha256').update(bytes).digest('hex');
     const current=await query('SELECT * FROM bank_bonds WHERE company_id=? ORDER BY id',[companyId]);
     const rows=parseBondWorkbook(bytes).map(row=>{
       const d=row.data;
       const matches=d.reference?current.filter(b=>b.reference===d.reference):d.bondNumber?current.filter(b=>String(b.bond_number||'').toLowerCase()===d.bondNumber.toLowerCase()&&String(b.bank).toLowerCase()===String(d.bank||'').toLowerCase()):[];
       const target=matches.length===1?matches[0]:null;
       const data={kind:'Performance',marginHeld:0,commission:0,reminderDays:30,status:'Live',...(target?bondData(target):{}),...d};
       delete data.reference;
       const parsed=bondFields.safeParse({...data,companyId});
       return {...row,data,targetId:target?.id||null,needsMatch:Boolean((d.reference&&!target)||matches.length>1),errors:parsed.success?[]:parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`)};
     });
     const preview={companyId,rows,existing:current.map(row=>({id:row.id,reference:row.reference,bondNumber:row.bond_number,bank:row.bank,data:bondData(row),snapshot:bondSnapshot(row)}))};
     const created=await query('INSERT INTO bond_import_batches (company_id,filename,checksum,preview_json,uploaded_by) VALUES (?,?,?,?,?)',[companyId,file.filename.slice(0,190),checksum,JSON.stringify(preview),req.user.id]);
     await audit(pool,req.user.id,'IMPORT_PREVIEW','bond_import',created.insertId,null,{companyId,rows:rows.length,filename:file.filename},req.ip);
     res.status(201).json({id:created.insertId,...preview,columns:bondColumns});
   }finally{await discard();}
 }));
 const submission=z.object({rows:z.array(z.object({targetId:z.number().int().positive().nullable(),verified:z.literal(true),data:z.record(z.unknown())})).min(1).max(300)});
 router.post(`${base}/:id/submit`,...access,validate(submission),wrap(async(req,res)=>{
   const result=await transaction(async connection=>{
     const [[batch]]=await connection.execute('SELECT * FROM bond_import_batches WHERE id=? FOR UPDATE',[req.params.id]);
     if(!batch||Number(batch.uploaded_by)!==Number(req.user.id))throw fail(404,'Bond import review not found.');
     if(batch.status!=='Review')throw fail(409,'This workbook was already submitted.');
     const preview=JSON.parse(batch.preview_json);
     // Serialize imports for this company and recheck targets inside the saving transaction.
     await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[batch.company_id]);
     const [[previous]]=await connection.execute("SELECT id FROM bond_import_batches WHERE company_id=? AND checksum=? AND status='Imported' LIMIT 1",[batch.company_id,batch.checksum]);
     if(previous)throw fail(409,'This exact workbook has already been imported for this company.');
     const [current]=await connection.execute('SELECT * FROM bank_bonds WHERE company_id=? FOR UPDATE',[batch.company_id]);
     const targets=new Set();let created=0,updated=0;
     if(req.body.rows.length!==preview.rows.length)throw fail(400,'Review every uploaded row before submitting.');
     for(const [index,row] of req.body.rows.entries()){
       const parsed=bondFields.safeParse({...row.data,companyId:Number(batch.company_id)});
       if(!parsed.success)throw fail(400,`Row ${index+1}: ${parsed.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
       const data=parsed.data;
       if(data.projectId){const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND company_id=?',[data.projectId,batch.company_id]);if(!project)throw fail(400,`Row ${index+1}: choose a project in this company.`);}
       const before=row.targetId?current.find(b=>Number(b.id)===row.targetId):null;
       if(row.targetId){
         if(targets.has(row.targetId))throw fail(400,'The same bond cannot be updated twice in one workbook.');targets.add(row.targetId);
         const original=preview.existing.find(b=>Number(b.id)===row.targetId);
         if(!before||!original||bondSnapshot(before)!==original.snapshot)throw fail(409,`Row ${index+1}: this bond changed or was removed after upload. Upload again and review the latest record.`);
       }
       const duplicate=data.bondNumber&&current.find(b=>Number(b.id)!==row.targetId&&String(b.bond_number||'').toLowerCase()===data.bondNumber.toLowerCase()&&b.bank.toLowerCase()===data.bank.toLowerCase());
       if(duplicate)throw fail(409,`Row ${index+1}: that bond number and bank already exist. Select the existing bond.`);
       const keys=bondColumns.map(([key])=>key).filter(key=>key!=='reference');
       const values=keys.map(key=>data[key]??(key==='status'?'Live':null));
       let id=row.targetId,reference=before?.reference;
       if(before){
         await connection.execute(`UPDATE bank_bonds SET ${keys.map(key=>`${dbFields[key]||key}=?`).join(',')} WHERE id=?`,[...values,id]);updated++;
       }else{
         reference=await nextReference('BND','bank_bonds');
         const [inserted]=await connection.execute(`INSERT INTO bank_bonds (company_id,reference,created_by,${keys.map(key=>dbFields[key]||key).join(',')}) VALUES (${Array(keys.length+3).fill('?').join(',')})`,[batch.company_id,reference,req.user.id,...values]);
         id=inserted.insertId;created++;
         current.push({id,bank:data.bank,bond_number:data.bondNumber});
       }
       await audit(connection,req.user.id,before?'IMPORT_UPDATE':'IMPORT_CREATE','bank_bond',id,before,{...data,reference,importBatchId:batch.id},req.ip);
     }
     await connection.execute("UPDATE bond_import_batches SET status='Imported',confirmed_at=NOW() WHERE id=?",[batch.id]);
     await audit(connection,req.user.id,'IMPORT_SUBMIT','bond_import',batch.id,null,{created,updated},req.ip);
     return {created,updated};
   });res.json(result);
 }));
}
