import {Router} from 'express';
import {z} from 'zod';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {query,transaction,audit} from '../db.js';
import {documentTypes,formatDocumentNumber} from '../lib/document-numbering.js';
const router=Router();
const number=z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/);
router.get('/',auth,permit('finance.invoice'),wrap(async(req,res)=>{
  const companyId=Number(req.query.companyId);
  if(!Number.isSafeInteger(companyId)||companyId<1)throw fail(400,'Choose a company.');
  res.json({settings:await query('SELECT document_type type,format,padding,next_value nextValue FROM document_numbering WHERE company_id=?',[companyId]),
    quotations:await query('SELECT id,reference,title,status,revision_number revision FROM quotations_client WHERE company_id=? ORDER BY id DESC LIMIT 500',[companyId])});
}));
router.put('/:type',auth,permit('finance.invoice'),validate(z.object({companyId:z.number().int().positive(),format:z.string().trim().min(3).max(40),padding:z.number().int().min(1).max(10),nextValue:z.number().int().min(1).max(999999999),reason:z.string().trim().min(3).max(1000)}).strict()),wrap(async(req,res)=>{
  if(!Object.hasOwn(documentTypes,req.params.type))throw fail(400,'Unknown document type.');
  const {format,padding,nextValue,companyId,reason}=req.body;
  if((format.match(/\{N\}/g)||[]).length!==1||/[{}]/.test(format.replace(/\{(?:N|YYYY|YY|MM)\}/g,''))||!number.safeParse(formatDocumentNumber(format,nextValue,padding)).success)throw fail(400,'Use one {N}, with optional {YYYY}, {YY} or {MM}, and a valid number format.');
  await transaction(async connection=>{
    const [[company]]=await connection.query('SELECT id FROM companies WHERE id=? FOR UPDATE',[companyId]);
    if(!company)throw fail(404,'Company not found.');
    const [[before]]=await connection.query('SELECT * FROM document_numbering WHERE company_id=? AND document_type=? FOR UPDATE',[companyId,req.params.type]);
    await connection.query('INSERT INTO document_numbering(company_id,document_type,format,padding,next_value) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE format=VALUES(format),padding=VALUES(padding),next_value=VALUES(next_value)',[companyId,req.params.type,format,padding,nextValue]);
    await audit(connection,req.user.id,'UPDATE','document_numbering',companyId,before||null,{type:req.params.type,format,padding,nextValue,reason},req.ip);
  });res.json({saved:true});
}));
router.patch('/:type/:id',auth,permit('finance.invoice'),validate(z.object({reference:number,previousReference:z.string().max(60),reason:z.string().trim().min(3).max(1000)}).strict()),wrap(async(req,res)=>{
  const table=Object.hasOwn(documentTypes,req.params.type)?documentTypes[req.params.type]:null,id=Number(req.params.id);
  if(!table||!Number.isSafeInteger(id)||id<1)throw fail(400,'Invalid document.');
  await transaction(async connection=>{
    const [[initial]]=await connection.query(`SELECT * FROM ${table} WHERE id=?`,[id]);
    if(!initial)throw fail(404,'Document not found.');
    const root=initial.root_quotation_id||initial.id;
    // Quotation revisions and renumbering both lock the family root first.
    const [rows]=req.params.type==='QUO'
      ? await connection.query('SELECT * FROM quotations_client WHERE id=? OR root_quotation_id=? ORDER BY id FOR UPDATE',[root,root])
      : await connection.query(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[id]);
    const row=rows.find(item=>Number(item.id)===id);
    if(!row)throw fail(404,'Document not found.');
    const column=req.params.type==='RCPT'?'receipt_number':'reference';
    if(row[column]!==req.body.previousReference)throw fail(409,'Number changed. Refresh before editing.');
    const [conflicts]=await connection.query(`SELECT id,${req.params.type==='QUO'?'root_quotation_id':'id'} root FROM ${table} WHERE ${column}=?`,[req.body.reference]);
    if(conflicts.some(item=>Number(item.id)!==id&&!(req.params.type==='QUO'&&(Number(item.id)===Number(root)||Number(item.root)===Number(root)))))throw fail(409,'That document number already exists.');
    if(req.params.type==='QUO')await connection.query('UPDATE quotations_client SET reference=? WHERE id=? OR root_quotation_id=?',[req.body.reference,root,root]);
    else await connection.query(`UPDATE ${table} SET ${column}=? WHERE id=?`,[req.body.reference,id]);
    await audit(connection,req.user.id,'RENUMBER',table,id,{documents:rows.map(item=>({id:item.id,reference:item[column]}))},{reference:req.body.reference,reason:req.body.reason},req.ip);
  });res.json({reference:req.body.reference});
}));
export default router;
