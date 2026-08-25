import fs from 'node:fs';
const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   FAIL',l,d);}};
const md=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})})).json()).token;
const call=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${md}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};
const form=new FormData();
form.append('file', new Blob([fs.readFileSync('/tmp/foreign-a.xlsx')],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'rda-bill.xlsx');
const up=await (await fetch(BASE+'/boq/import',{method:'POST',headers:{authorization:`Bearer ${md}`},body:form})).json();
console.log('uploaded a foreign bill:',up.items.length,'lines,',up.problemCount,'need attention');
check(up.items.every(i=>!i.category),'no line arrived with a category');
check(up.items.every(i=>/No category/.test(i.problems||'')),'every line is flagged for it');

console.log('\n=== set every missing category at once ===');
const r=await call('POST',`/boq/imports/${up.id}/bulk`,{field:'category',value:'Subcontract',onlyMissing:true});
check(r.status===200,'accepted',String(r.status)+JSON.stringify(r.body).slice(0,80));
check(r.body.changed===5,'all five rows changed',String(r.body.changed));
check(r.body.items.every(i=>i.category==='Subcontract'),'all now carry the category');
check(r.body.items.every(i=>!/No category/.test(i.problems||'')),'and the flag is gone');
check(r.body.problemCount===0,'nothing left needing attention',String(r.body.problemCount));

console.log('\n=== a category that is not on the list is refused ===');
const bad=await call('POST',`/boq/imports/${up.id}/bulk`,{field:'category',value:'Invented'});
check(bad.status===400,'refused',String(bad.status));

console.log('\n=== it can now be committed ===');
const projects=(await call('GET','/projects')).body;
const projectId=projects[0].id;
const c=await call('POST',`/boq/imports/${up.id}/commit`,{projectId});
check(c.status===201,'committed',String(c.status)+JSON.stringify(c.body).slice(0,90));
check(c.body.items===5,'five lines became a bill',String(c.body.items));
const total=12500*85+9800*140+3400*950+2850*1150+1120*8750;
check(Math.abs(c.body.total-total)<1,'total matches their document',`${c.body.total} vs ${total}`);

console.log('\n=== the bill points back at the file it came from ===');
const boq=(await call('GET',`/boq/${c.body.boqId}`)).body;
check(Boolean(boq),'bill readable');
const f=await fetch(BASE+`/boq/imports/${up.id}/file`,{headers:{authorization:`Bearer ${md}`}});
check(f.status===200,'and the original spreadsheet is still there',String(f.status));
console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
