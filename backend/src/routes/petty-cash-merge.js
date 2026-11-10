import {createHash} from 'node:crypto';
import {z} from 'zod';
import {query,transaction,audit} from '../db.js';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
const fields={targetId:z.number().int().positive(),sourceIds:z.array(z.number().int().positive()).min(1).max(20),name:z.string().trim().min(2).max(120).optional()};
const valid=b=>!b.sourceIds.includes(b.targetId)&&new Set(b.sourceIds).size===b.sourceIds.length;
const previewSchema=z.object(fields).refine(valid,'Choose different source accounts and one target account.');
const commitSchema=z.object({...fields,digest:z.string().length(64),clientRef:z.string().min(16).max(64),reason:z.string().trim().min(5).max(500)}).refine(valid,'Choose distinct accounts.');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
async function preview(run,b,lock=false){
 const ids=[b.targetId,...b.sourceIds].sort((a,c)=>a-c),marks=ids.map(()=>'?').join(',');
 const accounts=await run(`SELECT * FROM petty_cash_floats WHERE id IN (${marks}) ORDER BY id${lock?' FOR UPDATE':''}`,ids);
 if(accounts.length!==ids.length||accounts.some(f=>!f.active||f.merged_into_id))throw fail(409,'One of these accounts is no longer active. Refresh the accounts before merging.');
 const target=accounts.find(f=>Number(f.id)===b.targetId);
 if(accounts.some(f=>f.account_type!==target.account_type))throw fail(400,'Merge accounts of the same category only. Fuel, Office expenses and Salary advance stay separate.');
 const entries=await run(`SELECT id,float_id,amount,company_id FROM petty_cash_entries WHERE float_id IN (${marks}) ORDER BY id${lock?' FOR UPDATE':''}`,ids);
 const amounts=accounts.map(f=>{const rows=entries.filter(e=>Number(e.float_id)===Number(f.id));const cents=rows.reduce((s,e)=>s+Math.round(Number(e.amount)*100),0);if(!Number.isSafeInteger(cents)||Math.abs(cents)>999999999999999)throw fail(400,'Balance is too large to merge safely.');return {id:f.id,name:f.name,accountType:f.account_type,balance:cents/100,transactionCount:rows.length};});
 const total=amounts.reduce((s,f)=>s+Math.round(f.balance*100),0);if(!Number.isSafeInteger(total))throw fail(400,'Combined balance is too large to merge safely.');
 const digest=createHash('sha256').update(JSON.stringify({targetId:b.targetId,sourceIds:[...b.sourceIds].sort((a,c)=>a-c),name:b.name||null,accounts,entries})).digest('hex');
 return {targetId:b.targetId,name:b.name||target.name,accounts,summary:amounts,combinedBalance:total/100,transactionCount:entries.length,digest};
}
export function installPettyCashMerge(router){
 router.post('/receivables/petty-cash/merge/preview',auth,permit('finance.manage'),validate(previewSchema),wrap(async(req,res)=>{
  const p=await preview(query,req.body);const {accounts,...safe}=p;res.json(safe);
 }));
 router.post('/receivables/petty-cash/merge/commit',auth,permit('finance.manage'),validate(commitSchema),wrap(async(req,res)=>{
  const b=req.body,hash=createHash('sha256').update(JSON.stringify({...b,sourceIds:[...b.sourceIds].sort((a,c)=>a-c),userId:req.user.id})).digest('hex');
  const result=await transaction(async c=>{
   const run=async(sql,params=[])=>(await c.query(sql,params))[0];
   const [existing]=await run('SELECT * FROM petty_cash_float_merges WHERE client_ref=?',[b.clientRef]);
   if(existing){if(existing.request_hash!==hash)throw fail(409,'This merge reference belongs to a different request.');return {...parse(existing.summary),id:existing.id,replayed:true};}
   const p=await preview(run,b,true);
   if(p.digest!==b.digest)throw fail(409,'A balance or account changed after preview. Preview again before merging.');
   const [target]=p.accounts.filter(f=>Number(f.id)===b.targetId);
   const summary={targetId:b.targetId,name:p.name,sourceIds:b.sourceIds,accounts:p.summary,combinedBalance:p.combinedBalance,transactionCount:p.transactionCount,reason:b.reason};
   const saved=await run('INSERT INTO petty_cash_float_merges(target_float_id,client_ref,request_hash,summary,reason,created_by) VALUES (?,?,?,?,?,?)',[b.targetId,b.clientRef,hash,JSON.stringify(summary),b.reason,req.user.id]);
   const ids=[b.targetId,...b.sourceIds],all=ids.map(()=>'?').join(','),sources=b.sourceIds.map(()=>'?').join(',');
   // Freeze old payer attribution before changing an entry's float. No amount,
   // date, payment ID, fuel/supplier/MD link or payroll recovery is changed.
   await run(`UPDATE petty_cash_entries e JOIN petty_cash_floats f ON f.id=e.float_id SET e.company_id=COALESCE(e.company_id,f.company_id) WHERE e.float_id IN (${all})`,ids);
   await run(`INSERT INTO petty_cash_float_merge_entries(merge_id,entry_id,source_float_id) SELECT ?,id,float_id FROM petty_cash_entries WHERE float_id IN (${sources})`,[saved.insertId,...b.sourceIds]);
   await run(`UPDATE petty_cash_entries SET original_float_id=COALESCE(original_float_id,float_id) WHERE float_id IN (${sources})`,b.sourceIds);
   await run(`UPDATE petty_cash_entries SET float_id=? WHERE float_id IN (${sources})`,[b.targetId,...b.sourceIds]);
   const redirected=await run(`SELECT id,merged_into_id FROM petty_cash_floats WHERE merged_into_id IN (${sources}) FOR UPDATE`,b.sourceIds);
   await run(`UPDATE petty_cash_floats SET merged_into_id=? WHERE merged_into_id IN (${sources})`,[b.targetId,...b.sourceIds]);
   for(const source of p.accounts.filter(f=>Number(f.id)!==b.targetId)){
    const balance=p.summary.find(f=>Number(f.id)===Number(source.id)).balance;
    await run('UPDATE petty_cash_floats SET active=0,merged_into_id=?,merged_at=NOW(),merged_balance=? WHERE id=?',[b.targetId,balance,source.id]);
    await audit(c,req.user.id,'MERGE_ARCHIVE','petty_cash_float',source.id,source,{mergedIntoId:b.targetId,balanceAtMerge:balance,mergeId:saved.insertId,reason:b.reason},req.ip);
   }
   await run('UPDATE petty_cash_floats SET name=? WHERE id=?',[p.name,b.targetId]);
   await audit(c,req.user.id,'MERGE','petty_cash_float',b.targetId,{target,redirected},summary,req.ip);
   return {...summary,id:saved.insertId,replayed:false};
  }).catch(error=>{if(error.code==='ER_DUP_ENTRY'||error.code==='ER_LOCK_DEADLOCK')throw fail(409,'Another merge or payment changed these accounts. Refresh the preview; no partial merge was saved.');throw error;});
  res.status(result.replayed?200:201).json(result);
 }));
}
