const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0;
const check=(ok,l,d='')=>{if(ok)pass++;else{fail++;console.log('   FAIL',l,d);}};
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json()).token;
const call=async(t,m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};
const md=await login('owner@gkuc.lk'), store=await login('store@gkuc.lk');
/* Unique per run, so the test says the same thing every time it is run. */
const tag=Math.random().toString(36).slice(2,7).toUpperCase();
const CAT=`Plant hire ${tag}`, CAT2=`Plant and machinery ${tag}`, LEAVE=`Study leave ${tag}`;

console.log('\n=== everyone can read the lists (they build the dropdowns) ===');
let r=await call(store,'GET','/options');
check(r.status===200,'store keeper can read',String(r.status));
check(r.body.length===10,'ten lists',String(r.body.length));

console.log('\n=== only admin.lists may change them ===');
r=await call(store,'POST','/options/boq.category',{value:'Plant'});
check(r.status===403,'store keeper refused',String(r.status));

console.log('\n=== adding a new BOQ category ===');
r=await call(md,'POST','/options/boq.category',{value:CAT});
check(r.status===201,'added',String(r.status)+JSON.stringify(r.body).slice(0,70));
const cats=(await call(md,'GET','/options')).body.find(l=>l.listKey==='boq.category');
check(cats.values.some(v=>v.value===CAT),'appears in the list');
check(cats.values.find(v=>v.value===CAT).isSystem===false,'marked as company-added');

console.log('\n=== the new category can now be used on a real BOQ ===');
r=await call(md,'POST','/boq',{projectId:4,title:'Option list test bill',items:[
  {category:CAT,description:'Excavator hire 20T',unit:'day',quantity:6,rate:32000}]});
check(r.status===201,'BOQ created with the new category',String(r.status)+JSON.stringify(r.body).slice(0,90));
const boqId=r.body?.id;

console.log('\n=== a category that is not on the list is refused ===');
r=await call(md,'POST','/boq',{projectId:4,title:'Bad category',items:[
  {category:'Invented',description:'Some work item',unit:'day',quantity:1,rate:1}]});
check(r.status===400,'refused',String(r.status));
check(/not one of the BOQ categories/.test(r.body?.error||''),'says why',r.body?.error?.slice(0,60));

console.log('\n=== duplicates are refused ===');
r=await call(md,'POST','/options/boq.category',{value:CAT});
check(r.status===400,'duplicate refused',String(r.status));

console.log('\n=== renaming carries through to the records using it ===');
const list=(await call(md,'GET','/options')).body.find(l=>l.listKey==='boq.category');
const plant=list.values.find(v=>v.value===CAT);
r=await call(md,'PATCH',`/options/boq.category/${plant.id}`,{value:CAT2});
check(r.status===200,'renamed',String(r.status));
const boq=(await call(md,'GET',`/boq/${boqId}`)).body;
check(boq.items[0].category===CAT2,'the BOQ line follows the rename',boq.items[0].category);

console.log('\n=== an option in use cannot be deleted, only retired ===');
const renamed=(await call(md,'GET','/options')).body.find(l=>l.listKey==='boq.category').values.find(v=>v.value===CAT2);
r=await call(md,'DELETE',`/options/boq.category/${renamed.id}`);
check(r.status===409,'delete refused while in use',String(r.status));
check(/Turn it off instead/.test(r.body?.error||''),'suggests retiring it',r.body?.error?.slice(0,60));

r=await call(md,'PATCH',`/options/boq.category/${renamed.id}`,{active:false});
check(r.status===200,'retired instead',String(r.status));
r=await call(md,'POST','/boq',{projectId:4,title:'Retired category',items:[
  {category:CAT2,description:'Some work item',unit:'day',quantity:1,rate:1}]});
check(r.status===400,'retired option can no longer be chosen',String(r.status));
const still=(await call(md,'GET',`/boq/${boqId}`)).body;
check(still.items[0].category===CAT2,'but the existing record still reads correctly',still.items[0].category);

console.log('\n=== options the system depends on are protected ===');
const leave=(await call(md,'GET','/options')).body.find(l=>l.listKey==='leave.type');
const unpaid=leave.values.find(v=>v.value==='Unpaid');
check(unpaid.locked===true,'Unpaid is locked');
r=await call(md,'PATCH',`/options/leave.type/${unpaid.id}`,{value:'No pay'});
check(r.status===409,'renaming it is refused',String(r.status));
check(/payroll/.test(r.body?.error||''),'explains that payroll depends on it',r.body?.error?.slice(0,70));
r=await call(md,'PATCH',`/options/leave.type/${unpaid.id}`,{active:false});
check(r.status===409,'turning it off is refused',String(r.status));

console.log('\n=== a system option cannot be deleted either ===');
const material=leave.values.find(v=>v.value==='Annual');
r=await call(md,'DELETE',`/options/leave.type/${material.id}`);
check(r.status===409,'system option delete refused',String(r.status));

console.log('\n=== other fields use their lists too ===');
r=await call(md,'POST','/options/leave.type',{value:LEAVE});
check(r.status===201,'new leave type added',String(r.status));
r=await call(md,'POST','/employees/1/leave',{leaveType:LEAVE,fromDate:'2026-09-01',toDate:'2026-09-03',reason:'Exams'});
check(r.status===201,'used on a leave request',String(r.status)+JSON.stringify(r.body).slice(0,80));
r=await call(md,'POST','/employees/1/leave',{leaveType:'Sabbatical',fromDate:'2026-09-05',toDate:'2026-09-06',reason:'x'});
check(r.status===400,'an unlisted leave type is refused',String(r.status));

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
