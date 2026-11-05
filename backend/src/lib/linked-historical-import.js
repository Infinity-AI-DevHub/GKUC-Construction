import {readWorkbook,serialToDate} from './xlsx.js';
import {query} from '../db.js';
import {fail} from './http.js';
export const clean=value=>String(value??'').trim();
export const specs={
 clients:{sheet:'Clients',key:['CLIENT_CODE'],required:['CLIENT_CODE','CLIENT_TYPE','CLIENT_NAME','BILLING_ADDRESS','ACTIVE'],fields:['CLIENT_CODE','CLIENT_TYPE','CLIENT_NAME','BUSINESS_REGISTRATION_NO','TIN','VAT_NUMBER','BILLING_ADDRESS','SITE_ADDRESS','PHONE','EMAIL','CONTACT_PERSON','ACTIVE','NOTES']},
 contacts:{sheet:'Contacts',key:['CLIENT_CODE','CONTACT_NAME'],required:['CLIENT_CODE','CONTACT_NAME','PRIMARY_CONTACT'],fields:['CLIENT_CODE','CONTACT_NAME','JOB_TITLE','PHONE','EMAIL','PRIMARY_CONTACT','NOTES']},
 projects:{sheet:'Projects',key:['PROJECT_CODE'],required:['PROJECT_CODE','COMPANY','PROJECT_NAME','CLIENT_CODE','SITE_ADDRESS','PROJECT_MANAGER_EMPLOYEE_CODE','STAGE','STATUS','HEALTH','PROGRESS_PERCENT','START_DATE'],fields:['PROJECT_CODE','COMPANY','PROJECT_NAME','CLIENT_CODE','SITE_ADDRESS','PROJECT_MANAGER_EMPLOYEE_CODE','STAGE','STATUS','HEALTH','PROGRESS_PERCENT','START_DATE','END_DATE','CONTRACT_VALUE_LKR','CURRENT_BUDGET_LKR','AWARD_REFERENCE','AWARD_DATE','NOTES']},
 team:{sheet:'Project Team',key:['PROJECT_CODE','EMPLOYEE_CODE'],required:['PROJECT_CODE','EMPLOYEE_CODE','PROJECT_ROLE'],fields:['PROJECT_CODE','EMPLOYEE_CODE','PROJECT_ROLE','ASSIGNED_DATE','RELEASED_DATE','NOTES']},
 boqs:{sheet:'BOQ Headers',key:['BOQ_CODE'],required:['BOQ_CODE','PROJECT_CODE','ORIGINAL_REFERENCE','TITLE','STATUS','DECLARED_TOTAL_LKR','SOURCE_FILENAME'],fields:['BOQ_CODE','PROJECT_CODE','ORIGINAL_REFERENCE','TITLE','VERSION','STATUS','DOCUMENT_DATE','APPROVED_DATE','DECLARED_TOTAL_LKR','SOURCE_FILENAME','TERMS','NOTES']},
 items:{sheet:'BOQ Items',key:['BOQ_CODE','LINE_NO'],required:['BOQ_CODE','LINE_NO','CATEGORY','DESCRIPTION','UNIT','QUANTITY','RATE_LKR','AMOUNT_LKR'],fields:['BOQ_CODE','LINE_NO','CATEGORY','AREA_SECTION','DESCRIPTION','UNIT','QUANTITY','RATE_LKR','AMOUNT_LKR','METHOD_STATEMENT','NOTES']}
};
const groups={clients:['clients','contacts'],projects:['projects','team'],boqs:['boqs','items']};
export const linkKind=type=>({contacts:'client_contacts',team:'project_team',items:'boq_items'}[type]||type);
export const recordCode=(type,d)=>specs[type].key.length===1?clean(d[specs[type].key[0]]):JSON.stringify(specs[type].key.map(k=>clean(d[k])));
const dateFields=new Set(['START_DATE','END_DATE','AWARD_DATE','ASSIGNED_DATE','RELEASED_DATE','DOCUMENT_DATE','APPROVED_DATE']);
export const sourceDate=value=>typeof value==='number'?serialToDate(value):clean(value);
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value))&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function isLinkedWorkbook(kind,buffer){const w=readWorkbook(buffer);return groups[kind]?.every(type=>w.names.includes(specs[type].sheet));}
export function readLinkedWorkbook(kind,buffer){
 const w=readWorkbook(buffer),rows=[];
 for(const type of groups[kind]||[]){const spec=specs[type],sheet=w.sheet(spec.sheet);if(!sheet)throw fail(422,`${spec.sheet} sheet is missing.`);
  const h=sheet.rows.findIndex(row=>row?.some(c=>clean(c).replace(/^\*\s*/,'')===spec.key[0]));if(h<0)throw fail(422,`${spec.sheet}: column headings not found.`);
  const headings=sheet.rows[h].map(c=>clean(c).replace(/^\*\s*/,''));
  const defined=headings.filter(Boolean);if(new Set(defined).size!==defined.length)throw fail(422,`${spec.sheet}: duplicate column headings.`);
  const missing=spec.required.filter(k=>!headings.includes(k));if(missing.length)throw fail(422,`${spec.sheet}: missing columns ${missing.join(', ')}.`);
  sheet.rows.slice(h+1).forEach((cells,index)=>{if(!cells?.some(c=>clean(c)))return;
   const data={};headings.forEach((field,col)=>{if(spec.fields.includes(field))data[field]=dateFields.has(field)?sourceDate(cells[col]):cells[col]??'';});
   rows.push({type,sheet:spec.sheet,row:h+index+1,data,targetId:null});
  });
 }
 if(!rows.length)throw fail(422,'No records found in the template.');if(rows.length>3000)throw fail(422,'Import up to 3,000 source rows at a time.');return rows;
}
export async function linkedContext(run=query){
 const [clients,projects,employees,categories]=await Promise.all([
  run('SELECT id,name,type FROM clients ORDER BY name'),run('SELECT id,name,company_id companyId,client_id clientId FROM projects ORDER BY name'),
  run("SELECT id,code,name FROM visible_employees WHERE status<>'Left' ORDER BY name"),run("SELECT value FROM option_values WHERE list_key='boq.category' AND active=1 ORDER BY sort_order,id")
 ]);return {clients,projects,employees,categories:categories.map(r=>r.value)};
}
export async function inspectLinked(kind,source,{employeeMap={}}={},run=query){
 const context=await linkedContext(run),links=await run('SELECT kind,source_code sourceCode,target_id targetId FROM historical_import_links');
 const linked=(type,code)=>links.find(l=>l.kind===linkKind(type)&&l.sourceCode===code);
 const employee=code=>context.employees.find(e=>employeeMap[clean(code)]?Number(e.id)===Number(employeeMap[clean(code)]):e.code===clean(code));
 const seen=new Set(),rows=source.map(record=>{
  const spec=specs[record.type];if(!spec||!groups[kind].includes(record.type))throw fail(400,'Unexpected sheet in the review.');
  const d=Object.fromEntries(spec.fields.map(k=>{const value=record.data?.[k]??'';return [k,dateFields.has(k)?sourceDate(value):typeof value==='string'?value.trim():value];}));
  if(record.type==='projects'&&clean(d.COMPANY).toLowerCase().replaceAll(' ','')==='gkucreadymix')d.COMPANY='GKUC Readymix';
  const code=recordCode(record.type,d),errors=[],warnings=[];
  for(const k of spec.required)if(!clean(d[k]))errors.push(`${k} is required.`);
  if(code.length>120)errors.push('The combined source key must not exceed 120 characters.');
  const unique=record.type+':'+code;if(seen.has(unique))errors.push('Duplicate source key in this workbook.');seen.add(unique);
  for(const field of spec.fields){if(dateFields.has(field)&&clean(d[field])&&!validDate(d[field]))errors.push(`${field}: use a valid YYYY-MM-DD or Excel date.`);}
  const number=(field,{positive=false,max=9999999999999.99}={})=>{const n=Number(d[field]);if(!clean(d[field])||!Number.isFinite(n)||(positive?n<=0:n<0)||n>max)errors.push(`${field}: enter a valid ${positive?'positive':'nonnegative'} amount.`);};
  const max=(field,length)=>{if(clean(d[field]).length>length)errors.push(`${field}: maximum ${length} characters.`);};
  for(const field of spec.fields)max(field,field==='DESCRIPTION'?2000:field==='NOTES'||field==='TERMS'||field==='METHOD_STATEMENT'?10000:field==='PROJECT_NAME'||field==='TITLE'?1000:field==='BILLING_ADDRESS'||field==='SITE_ADDRESS'?500:1000);
  if(record.type==='clients'){
   if(!['Organisation','Individual'].includes(clean(d.CLIENT_TYPE)))errors.push('CLIENT_TYPE must be Organisation or Individual.');
   if(!['Yes','No'].includes(clean(d.ACTIVE)))errors.push('ACTIVE must be Yes or No.');max('CLIENT_NAME',180);max('CONTACT_PERSON',120);
  }
  if(record.type==='contacts'){
   if(!['Yes','No'].includes(clean(d.PRIMARY_CONTACT)))errors.push('PRIMARY_CONTACT must be Yes or No; enter phone numbers in PHONE.');max('CONTACT_NAME',120);max('JOB_TITLE',180);
  }
  for(const f of ['PHONE'])if(f in d)max(f,40);
  if('EMAIL'in d)max('EMAIL',190);
  for(const field of ['BUSINESS_REGISTRATION_NO','TIN','VAT_NUMBER'])if(field in d)max(field,100);
  if('EMAIL'in d&&clean(d.EMAIL)&&!/^\S+@\S+\.\S+$/.test(clean(d.EMAIL)))errors.push('EMAIL is not valid.');
  if(record.type==='projects'){
   if(!['GKUC Construction','GKUC Readymix'].includes(clean(d.COMPANY)))errors.push('Choose GKUC Construction or GKUC Readymix.');
   if(!['Current','Completed','Archived'].includes(clean(d.STATUS)))errors.push('STATUS must be Current, Completed or Archived.');
   if(!['On track','Watch','At risk'].includes(clean(d.HEALTH)))errors.push('HEALTH must be On track, Watch or At risk.');
   number('PROGRESS_PERCENT',{max:100});for(const f of ['CURRENT_BUDGET_LKR','CONTRACT_VALUE_LKR'])if(clean(d[f]))number(f);
   if(!employee(d.PROJECT_MANAGER_EMPLOYEE_CODE))errors.push(`Map project manager ${clean(d.PROJECT_MANAGER_EMPLOYEE_CODE)} to a saved employee.`);
   if(d.START_DATE&&d.END_DATE&&d.END_DATE<d.START_DATE)errors.push('END_DATE precedes START_DATE.');max('SITE_ADDRESS',180);max('STAGE',150);max('AWARD_REFERENCE',120);
  }
  if(record.type==='team'){if(!employee(d.EMPLOYEE_CODE))errors.push(`Map team employee ${clean(d.EMPLOYEE_CODE)} to a saved employee.`);max('PROJECT_ROLE',120);}
  if(record.type==='boqs'){
   number('DECLARED_TOTAL_LKR');if(!['Draft','Submitted','Approved','Rejected'].includes(clean(d.STATUS)))errors.push('Invalid source BOQ STATUS.');
   warnings.push(`Source status ${clean(d.STATUS)} is retained as history; imported BOQs are Draft until normal QS approval.`);
  }
  if(record.type==='items'){
   number('QUANTITY',{positive:true,max:99999999999.999});number('RATE_LKR',{max:999999999999.99});number('AMOUNT_LKR');
   const calculated=Math.round(Number(d.QUANTITY)*Number(d.RATE_LKR)*100)/100;
   if(Number.isFinite(calculated)&&Math.abs(calculated-Number(d.AMOUNT_LKR))>.011)errors.push(`AMOUNT_LKR differs from quantity × rate (${calculated.toFixed(2)}). Correct the source values.`);
   if(context.categories.length&&!context.categories.includes(clean(d.CATEGORY)))errors.push('CATEGORY is not configured in the BOQ category list.');max('CATEGORY',60);max('UNIT',30);
   if(Math.abs(Number(d.QUANTITY)*1000-Math.round(Number(d.QUANTITY)*1000))>.00001)errors.push('QUANTITY supports up to three decimal places.');
   if(Math.abs(Number(d.RATE_LKR)*100-Math.round(Number(d.RATE_LKR)*100))>.00001)errors.push('RATE_LKR supports up to two decimal places.');
  }
  const existing=linked(record.type,code);
  let targetId=record.targetId?Number(record.targetId):null;
  if(existing)targetId=Number(existing.targetId);
  if(targetId&&['clients','projects'].includes(record.type)){
   const target=context[record.type].find(r=>Number(r.id)===targetId);if(!target)errors.push('Selected existing record no longer exists.');
   if(record.type==='projects'&&target&&Number(target.companyId)!==(clean(d.COMPANY)==='GKUC Readymix'?2:1))errors.push('Selected project belongs to another company.');
  }else if(record.targetId&&!existing)errors.push('Existing record selection is only supported for clients and projects.');
  if(!existing&&!targetId&&record.type==='clients'&&context.clients.some(c=>c.name.toLowerCase()===clean(d.CLIENT_NAME).toLowerCase()&&c.type===(clean(d.CLIENT_TYPE)==='Individual'?'Private':'Organisation')))errors.push('A matching client exists. Select it to link this source code.');
  if(!existing&&!targetId&&record.type==='projects'&&context.projects.some(p=>p.name.toLowerCase()===clean(d.PROJECT_NAME).toLowerCase()&&Number(p.companyId)===(clean(d.COMPANY)==='GKUC Readymix'?2:1)))errors.push('A matching project exists. Select it to link this source code.');
  return {type:record.type,sheet:spec.sheet,row:record.row,data:d,code,targetId,errors,warnings,action:existing?'skip':targetId?'link':'create'};
 });
 const hasParent=(type,code)=>rows.some(r=>r.type===type&&r.code===clean(code))||linked(type,clean(code));
 for(const row of rows){const d=row.data;
  const parent={contacts:['clients','CLIENT_CODE'],projects:['clients','CLIENT_CODE'],team:['projects','PROJECT_CODE'],boqs:['projects','PROJECT_CODE'],items:['boqs','BOQ_CODE']}[row.type];
  if(parent&&!hasParent(parent[0],d[parent[1]]))row.errors.push(`${parent[1]} ${clean(d[parent[1]])} has no matching imported or workbook record. Correct the key or import its parent first.`);
  if(row.type==='boqs'){
   const items=rows.filter(r=>r.type==='items'&&clean(r.data.BOQ_CODE)===row.code);
   if(!items.length)row.errors.push('No BOQ Items match this BOQ_CODE.');
   const total=Math.round(items.reduce((s,r)=>s+Number(r.data.AMOUNT_LKR||0),0)*100)/100;
   if(Math.abs(total-Number(d.DECLARED_TOTAL_LKR))>.011)row.errors.push(`Declared total ${d.DECLARED_TOTAL_LKR} does not match items total ${total.toFixed(2)}.`);
  }
  if(row.type==='contacts'&&clean(d.PRIMARY_CONTACT)==='Yes'&&rows.filter(r=>r.type==='contacts'&&clean(r.data.CLIENT_CODE)===clean(d.CLIENT_CODE)&&clean(r.data.PRIMARY_CONTACT)==='Yes').length>1)row.errors.push('Only one primary contact per client is allowed.');
  if(row.errors.length)row.action='blocked';
 }
 const counts=Object.fromEntries(['create','link','skip','blocked'].map(action=>[action,rows.filter(r=>r.action===action).length]));
 return {mode:'linked-workbook',kind,sheets:groups[kind].map(t=>specs[t].sheet),rows,counts,employeeMap,context,fields:Object.fromEntries(groups[kind].map(t=>[t,specs[t].fields])),sourceTotal:rows.filter(r=>r.type==='boqs').reduce((s,r)=>s+Number(r.data.DECLARED_TOTAL_LKR||0),0)};
}
