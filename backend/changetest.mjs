const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0;
const check=(ok,l,d='')=>{if(ok)pass++;else{fail++;console.log('   FAIL',l,d);}};
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json()).token;
const call=async(t,m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};
const md=await login('owner@gkuc.lk'), coord=await login('manager@gkuc.lk');

/* A fresh bill each run, so the test says the same thing every time. */
const made=await call(md,'POST','/boq',{projectId:4,title:'Change-approval test bill',items:[
  {category:'Material',description:'Supply and lay 20mm aggregate base course',unit:'m3',quantity:250,rate:8750},
  {category:'Labour',description:'Skilled masons — kerb laying',unit:'day',quantity:48,rate:4500}
]});
const boq=made.body;
console.log('\ncreated BOQ',boq.reference,'status',boq.status);

console.log('\n=== a draft BOQ takes direct edits, not change requests ===');
let r=await call(md,'POST',`/boq/${boq.id}/changes`,{action:'Edit',itemId:1,reason:'Testing on a draft'});
check(r.status===409,'change request refused on a draft',String(r.status));
check(/not approved yet/.test(r.body?.error||''),'explains why',r.body?.error?.slice(0,60));

console.log('\n=== approve the BOQ, then it locks ===');
r=await call(md,'PATCH',`/boq/${boq.id}`,{status:'Approved'});
check(r.status===200,'BOQ approved',String(r.status)+JSON.stringify(r.body).slice(0,80));

const detail=(await call(md,'GET',`/boq/${boq.id}`)).body;
const line=detail.items[0];
console.log('   line 1:',line.description.slice(0,40),'| qty',line.quantity,'rate',line.rate,'amount',line.amount);
const totalBefore=Number(detail.total ?? detail.boq?.total ?? 0);

console.log('\n=== somebody without the permission asks for a change ===');
r=await call(md,'POST',`/boq/${boq.id}/changes`,{action:'Edit',itemId:line.id,reason:'Rate renegotiated with the supplier',item:{rate:9500}});
check(r.status===201,'change requested',String(r.status)+JSON.stringify(r.body).slice(0,90));
const changeId=r.body.id;

console.log('\n=== the figures must not have moved yet ===');
const midway=(await call(md,'GET',`/boq/${boq.id}`)).body;
check(Number(midway.items[0].rate)===Number(line.rate),'rate unchanged while pending',`${midway.items[0].rate} vs ${line.rate}`);

console.log('\n=== only a holder of qs.boqAmend may decide ===');
r=await call(coord,'PATCH',`/boq/changes/${changeId}`,{status:'Approved'});
check(r.status===403,'coordinator refused',String(r.status));

console.log('\n=== the MD approves it ===');
r=await call(md,'PATCH',`/boq/changes/${changeId}`,{status:'Approved',note:'Confirmed against the supplier email'});
check(r.status===200,'approved',String(r.status)+JSON.stringify(r.body).slice(0,80));

const after=(await call(md,'GET',`/boq/${boq.id}`)).body;
check(Number(after.items[0].rate)===9500,'rate now applied',String(after.items[0].rate));
const expected=Number(after.items[0].quantity)*9500;
check(Math.abs(Number(after.items[0].amount)-expected)<1,'line amount recomputed',`${after.items[0].amount} vs ${expected}`);
const sumOfLines=after.items.reduce((s,i)=>s+Number(i.amount),0);
check(Math.abs(Number(after.total ?? after.boq?.total ?? 0)-sumOfLines)<1,'BOQ total follows its lines',
  `${after.total ?? after.boq?.total} vs ${sumOfLines}`);

console.log('\n=== a decided request cannot be decided again ===');
r=await call(md,'PATCH',`/boq/changes/${changeId}`,{status:'Rejected'});
check(r.status===409,'second decision refused',String(r.status));

console.log('\n=== rejecting changes nothing ===');
r=await call(md,'POST',`/boq/${boq.id}/changes`,{action:'Remove',itemId:after.items[1].id,reason:'Duplicated line, please remove'});
const rejectId=r.body.id;
const before=(await call(md,'GET',`/boq/${boq.id}`)).body.items.length;
await call(md,'PATCH',`/boq/changes/${rejectId}`,{status:'Rejected',note:'Not a duplicate'});
const stillThere=(await call(md,'GET',`/boq/${boq.id}`)).body.items.length;
check(before===stillThere,'rejected removal left the line alone',`${before} -> ${stillThere}`);

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
