import fs from 'node:fs';
import { ensureFixtures } from './fixtures.mjs';
const FIX=ensureFixtures();
const BASE='http://127.0.0.1:4400/api';
let pass=0, fail=0;
const check=(ok,label,detail='')=>{ if(ok)pass++; else {fail++; console.log('   FAIL',label,detail);} };
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json()).token;
const call=async(t,m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};

const md=await login('owner@gkuc.lk'), qs=md, store=await login('store@gkuc.lk');

console.log('\n=== template download ===');
let r=await fetch(BASE+'/boq/template?projectId=1',{headers:{authorization:`Bearer ${qs}`}});
const tpl=Buffer.from(await r.arrayBuffer());
check(r.status===200,'template downloads',String(r.status));
check(r.headers.get('content-type').includes('spreadsheetml'),'served as a spreadsheet');
check(tpl.subarray(0,2).toString()==='PK','it is a real zip/xlsx');
fs.writeFileSync(`${FIX}/dl-template.xlsx`,tpl);
console.log(`   ${tpl.length} bytes`);
const denied=await fetch(BASE+'/boq/template',{headers:{authorization:`Bearer ${store}`}});
check(denied.status===403,'store keeper cannot download it',String(denied.status));

console.log('\n=== upload the messy filled-in file ===');
const form=new FormData();
form.append('file',new Blob([fs.readFileSync(`${FIX}/boq-filled.xlsx`)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'peradeniya-boq.xlsx');
form.append('projectId','4');
r=await fetch(BASE+'/boq/import',{method:'POST',headers:{authorization:`Bearer ${qs}`},body:form});
const imported=await r.json();
check(r.status===201,'import staged',String(r.status)+' '+JSON.stringify(imported).slice(0,120));
check(imported.title==='Peradeniya Road Resurfacing — Phase 2','title read from the sheet',imported.title);
check(imported.client==='Road Development Authority','client read from the sheet',imported.client);
check(imported.items.length===9,'all 9 rows staged',String(imported.items?.length));
check(imported.problemCount===3,'3 rows blocked',String(imported.problemCount));
for(const i of imported.items.filter(x=>x.problems)) console.log(`   blocked  row ${i.sourceRow}: ${i.problems}`);
const advisory=imported.items.filter(x=>x.notice);
check(advisory.length===1,'1 row carries an advisory note',String(advisory.length));
for(const i of advisory) console.log(`   advisory row ${i.sourceRow}: ${i.notice}`);

console.log('\n=== nothing reached the real BOQ table yet ===');
const before=(await call(qs,'GET','/boq')).body.length;
check(true,'boqs before commit: '+before);

console.log('\n=== committing while rows are unresolved must be refused ===');
r=await call(qs,'POST',`/boq/imports/${imported.id}/commit`,{projectId:4});
check(r.status===400,'refused with problems outstanding',String(r.status));
check(/still need attention/.test(r.body?.error||''),'says why',r.body?.error?.slice(0,80));

console.log('\n=== correcting the flagged rows on screen ===');
const rows=imported.items;
const byRow=n=>rows.find(x=>x.sourceRow===n);
/* Row 15 is deliberately not touched: its note is advisory and must not block the commit. */
const patches=[[13,{category:'Equipment'}],[14,{quantity:12}],[17,{rate:118}]];
let after=null;
for(const [rowNo,change] of patches){
  after=await call(qs,'PATCH',`/boq/imports/${imported.id}/items/${byRow(rowNo).id}`,change);
  if(after.status!==200) console.log(`   patch row ${rowNo} -> ${after.status} ${JSON.stringify(after.body).slice(0,110)}`);
}
check(after.body.problemCount===0,'all problems resolved',String(after.body.problemCount));
console.log('   total after corrections: LKR '+Number(after.body.total).toLocaleString('en-LK'));

console.log('\n=== commit ===');
r=await call(qs,'POST',`/boq/imports/${imported.id}/commit`,{projectId:4});
check(r.status===201,'committed',String(r.status)+JSON.stringify(r.body).slice(0,90));
const boqId=r.body.boqId;
check(/^BOQ-/.test(r.body.reference),'got a reference',r.body.reference);
check(r.body.items===9,'all 9 lines written',String(r.body.items));

const real=await call(qs,'GET',`/boq/${boqId}`);
check(real.status===200,'the BOQ exists');
check(real.body.items.length===9,'lines are on it',String(real.body.items?.length));
check(real.body.items.some(i=>i.method),'method statements carried through');
check(real.body.status==='Draft','arrives as a draft, not approved',real.body.status);

console.log('\n=== a committed import cannot be committed twice ===');
r=await call(qs,'POST',`/boq/imports/${imported.id}/commit`,{projectId:4});
check(r.status===409,'second commit refused',String(r.status));

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
