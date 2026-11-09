import {z} from 'zod';
export const boqAdjustmentSchema=z.object({label:z.string().trim().min(1).max(180),direction:z.enum(['Add','Deduct']),mode:z.enum(['Percent','Amount']),value:z.number().finite().nonnegative().max(999999999999),source:z.string().max(300).optional()}).superRefine((b,c)=>{if(b.mode==='Percent'&&b.value>100)c.addIssue({code:'custom',message:'Percentage must be between 0 and 100.'});});
export const boqAdjustmentsSchema=z.array(boqAdjustmentSchema).max(50);
export const parseAdjustments=value=>typeof value==='string'?JSON.parse(value):(value||[]);
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
export function calculateBoqFinancials(subtotal,adjustments=[]){
 const rows=boqAdjustmentsSchema.parse(parseAdjustments(adjustments)).map(row=>({...row,amount:money(row.mode==='Percent'?Number(subtotal)*row.value/100:row.value)}));
 const total=money(money(Number(subtotal))+rows.reduce((sum,row)=>sum+(row.direction==='Deduct'?-row.amount:row.amount),0));
 if(!Number.isFinite(total)||total<0||total>9999999999999.99)throw Object.assign(new Error('BOQ adjustments produce an invalid or negative total.'),{status:400});
 return {subtotal:money(Number(subtotal)),adjustments:rows,total};
}
export async function refreshBoqFinancials(connection,id){
 const [[boq]]=await connection.query('SELECT financial_adjustments FROM boqs WHERE id=?',[id]);
 const [[sum]]=await connection.query('SELECT COALESCE(SUM(amount),0) subtotal FROM boq_items WHERE boq_id=?',[id]);
 const result=calculateBoqFinancials(Number(sum.subtotal),boq.financial_adjustments);
 await connection.execute('UPDATE boqs SET total=? WHERE id=?',[result.total,id]);return result;
}
/** Conservative proposals. Source value/base must always be reviewed before commit. */
export function detectFinancialRows(rows,source='Document'){
 const result=[];
 for(let i=0;i<rows.length;i++){
  const cells=(rows[i]||[]).filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').map(v=>typeof v==='object'?String(v.value??''):String(v).trim());
  if(!cells.length)continue;
  const structured=cells.some(v=>/^(Add|Deduct)$/i.test(v))&&cells.some(v=>/^(Percent|Amount)$/i.test(v));
  const label=structured?cells[0]:cells.find(v=>/^(?:less[:\s-]*|add[:\s-]*|deduct[:\s-]*)?(?:VAT|SVAT|SSCL|NBT|WHT|tax|income tax|withholding tax|other deductions?|deductions?|discount|retention|advance recovery|cess|levy|stamp duty)\b/i.test(v));
  if(!label||label.length>180)continue;
  const text=cells.join(' '),percent=text.match(/(\d+(?:\.\d+)?)\s*%/);
  let numbers=cells.slice(cells.indexOf(label)+1).flatMap(v=>/^\(?-?[\d,]+(?:\.\d+)?\)?$/.test(v)?[Math.abs(Number(v.replace(/[(),]/g,'')))]:[]);
  if(!percent&&!numbers.length){const trailing=text.match(/(?:^|\s)([\d,]+(?:\.\d+)?)\s*$/);if(trailing)numbers=[Number(trailing[1].replaceAll(',',''))];}
  if(!percent&&!numbers.length)continue;
  const percentField=/\b(?:rate|percent|percentage)\b|%/.test(label.toLowerCase())||cells.some(v=>/^(?:percent|percentage|%)$/i.test(v));
  const mode=percent||percentField?'Percent':'Amount',value=percent?Number(percent[1]):(cells.includes('%')&&numbers.length>=2?numbers[1]:numbers[0]);
  const direction=cells.some(v=>/^deduct$/i.test(v))||/less|deduct|discount|retention|recovery|withholding|\bwht\b/i.test(label)?'Deduct':'Add';
  result.push({label:label.slice(0,180),direction,mode,value:mode==='Percent'&&value>100?0:value,source:`${source}, row ${i+1}: ${text}`.slice(0,300)});
 }
 return result;
}

/** Explicit financial column headers; retain per-row proposals rather than guessing a common rate. */
export function detectFinancialColumns(rows,source='Workbook'){
 const result=[];
 const number=value=>{const text=String(value??'').trim();return /^-?[\d,]+(?:\.\d+)?%?$/.test(text)?Math.abs(Number(text.replace(/[,%]/g,''))):null;};
 for(let i=0;i<rows.length;i++){
  const header=rows[i]||[];
  if(header.some(value=>number(value)!==null))continue;
  for(let col=0;col<header.length;col++){
   const label=String(header[col]||'').trim(),key=label.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2');
   if(!/\b(VAT|SVAT|SSCL|NBT|WHT|tax|deduction|discount|retention|levy)\b/i.test(key)||!/rate|percent|amount|%/i.test(key))continue;
   for(let at=i+1;at<rows.length;at++){
    const raw=rows[at]?.[col],value=number(raw);if(value===null){if(raw==null||String(raw).trim()==='')continue;break;}
    const mode=/rate|percent|%/i.test(key)||String(raw).includes('%')?'Percent':'Amount';
    result.push({label:label.slice(0,180),direction:/deduct|discount|retention|withholding|\bwht\b/i.test(key)?'Deduct':'Add',mode,value:mode==='Percent'&&value>100?0:value,source:`${source}, row ${at+1}, ${label}: ${raw}`.slice(0,300)});
   }
  }
 }
 return result;
}
