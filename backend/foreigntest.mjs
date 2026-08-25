import fs from 'node:fs';
import crypto from 'node:crypto';
const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0;
const check=(ok,l,d='')=>{if(ok)pass++;else{fail++;console.log('   FAIL',l,d);}};
const md=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})})).json()).token;
const call=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${md}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};

const upload=async path=>{
  const buf=fs.readFileSync(path);
  const form=new FormData();
  form.append('file', new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), path.split('/').pop());
  const r=await fetch(BASE+'/boq/import',{method:'POST',headers:{authorization:`Bearer ${md}`},body:form});
  return {status:r.status, body:await r.json().catch(()=>null), sha:crypto.createHash('sha256').update(buf).digest('hex')};
};

const expected={
  a:{items:5, source:'Foreign', sheet:'BOQ'},
  b:{items:4, source:'Foreign', sheet:'Priced BOQ'},
  c:{items:3, source:'Foreign', sheet:'Sheet1'},
  d:{items:4, source:'Foreign', sheet:'Detail'}
};

for(const name of ['a','b','c','d']){
  const r=await upload(`/tmp/foreign-${name}.xlsx`);
  console.log(`\n=== foreign-${name} ===`);
  check(r.status===201, 'accepted', String(r.status)+' '+JSON.stringify(r.body).slice(0,110));
  if(r.status!==201) continue;
  const imp=r.body;
  check(imp.source===expected[name].source, 'recorded as a foreign layout', imp.source);
  check(imp.items.length===expected[name].items, `read ${expected[name].items} priced lines`, String(imp.items.length));
  check(imp.layout?.headerRow>0, 'noted which row held the headings', String(imp.layout?.headerRow));
  check(Boolean(imp.layout?.headings?.description), 'noted which column was the description', imp.layout?.headings?.description);
  console.log('   read as:', JSON.stringify(imp.layout?.headings));
  if(imp.layout?.notes?.length) console.log('   notes:', imp.layout.notes.join('; '));

  // evidence
  const f=await fetch(BASE+`/boq/imports/${imp.id}/file`,{headers:{authorization:`Bearer ${md}`}});
  const got=Buffer.from(await f.arrayBuffer());
  check(f.status===200, 'the original file can be downloaded again', String(f.status));
  check(crypto.createHash('sha256').update(got).digest('hex')===r.sha, 'byte-for-byte the file that was sent');
}

console.log('\n=== the original is refused to somebody without QS access ===');
const store=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'store@gkuc.lk',password:'GKUC@2026'})})).json()).token;
const list=(await call('GET','/boq/imports')).body;
const f2=await fetch(BASE+`/boq/imports/${list[0].id}/file`,{headers:{authorization:`Bearer ${store}`}});
check(f2.status===403,'store keeper refused',String(f2.status));

console.log('\n=== our own template still reads as before ===');
const t=await upload('/tmp/boq-filled.xlsx');
check(t.status===201,'template accepted',String(t.status));
check(t.body?.source==='Template','recorded as our template',t.body?.source);
check(t.body?.items.length===9,'nine lines',String(t.body?.items.length));

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
