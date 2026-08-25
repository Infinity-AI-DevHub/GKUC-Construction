const BASE='http://127.0.0.1:4400/api', ROOT='http://127.0.0.1:4400';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   FAIL',l,d);}};
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json());
const call=async(t,m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};
const upload=async(tok,name,bytes,parentId)=>{
  const form=new FormData();
  form.append('file', new Blob([bytes]), name);
  if(parentId) form.append('parentId', String(parentId));
  const r=await fetch(BASE+'/drive/files',{method:'POST',headers:{authorization:`Bearer ${tok}`},body:form});
  return {status:r.status, body:await r.json().catch(()=>null)};
};

const owner=await login('owner@gkuc.lk');       // Kasun, MD
const store=await login('store@gkuc.lk');       // Rashmi, storekeeper
const finance=await login('finance@gkuc.lk');   // Shalini

console.log('=== folders ===');
let r=await call(owner.token,'POST','/drive/folders',{name:`Tenders ${Date.now()}`});
check(r.status===201,'folder created',String(r.status));
const folder=r.body.id;
r=await call(owner.token,'POST','/drive/folders',{name:'2026',parentId:folder});
check(r.status===201,'nested folder');
const sub=r.body.id;

console.log('\n=== uploading what a construction company actually has ===');
const dwg=Buffer.concat([Buffer.from('AC1032'),Buffer.alloc(4000)]);
r=await upload(owner.token,'Site layout.dwg',dwg,sub);
check(r.status===201,'a CAD drawing is accepted',String(r.status)+JSON.stringify(r.body).slice(0,80));
check(r.body?.family==='drawing','and recognised as a drawing',r.body?.family);
const file=r.body.id;
r=await upload(owner.token,'Tender pack.zip',Buffer.concat([Buffer.from([0x50,0x4b,3,4]),Buffer.alloc(2000)]),sub);
check(r.status===201,'an archive is accepted',String(r.status));

console.log('\n=== programs are refused, however they are dressed ===');
r=await upload(owner.token,'setup.exe',Buffer.from([0x4d,0x5a,0x90,0]),sub);
check(r.status===415,'an executable',String(r.status));
r=await upload(owner.token,'drawing.dwg',Buffer.from([0x4d,0x5a,0x90,0,0,0,0,0]),sub);
check(r.status===415,'an executable renamed as a drawing',String(r.status));
check(/whatever it is named/.test(r.body?.error||''),'and says so plainly',r.body?.error?.slice(0,50));
r=await upload(owner.token,'invoice.exe.pdf',Buffer.from('%PDF-1.4 xx'),sub);
check(r.status===415,'a program extension hidden mid-name',String(r.status));

console.log('\n=== private by default ===');
check((await call(store.token,'GET',`/drive?folder=${sub}`)).status===404,'nobody else can open the folder');
check((await call(store.token,'GET',`/drive/items/${file}/download`)).status===404,'nor download the file');
const theirs=(await call(store.token,'GET','/drive')).body.items;
check(!theirs.some(i=>i.id===folder),'nor see it listed');

console.log('\n=== sharing a folder reaches what is inside it ===');
r=await call(owner.token,'PATCH',`/drive/items/${folder}/sharing`,{visibility:'People',add:[{userId:store.user.id,role:'View'}]});
check(r.status===204,'shared the top folder with one person',String(r.status));
check((await call(store.token,'GET',`/drive?folder=${sub}`)).status===200,'they can now open the subfolder');
check((await call(store.token,'GET',`/drive/items/${file}/download`)).status===200,'and download the file inside it');
check((await call(finance.token,'GET',`/drive/items/${file}/download`)).status===404,'somebody else still cannot');

console.log('\n=== a viewer cannot change anything ===');
check((await call(store.token,'PATCH',`/drive/items/${file}`,{name:'Renamed.dwg'})).status===403,'cannot rename');
check((await upload(store.token,'Sneak.txt',Buffer.from('x'),sub)).status===403,'cannot upload into it');
check((await call(store.token,'DELETE',`/drive/items/${file}`)).status===403,'cannot delete');
check((await call(store.token,'PATCH',`/drive/items/${file}/sharing`,{add:[{userId:finance.user.id,role:'Edit'}]})).status===403,'and cannot pass access on');

console.log('\n=== an editor can change but still not re-share ===');
await call(owner.token,'PATCH',`/drive/items/${folder}/sharing`,{add:[{userId:store.user.id,role:'Edit'}]});
check((await upload(store.token,'Survey notes.txt',Buffer.from('levels'),sub)).status===201,'an editor can upload');
check((await call(store.token,'PATCH',`/drive/items/${file}/sharing`,{add:[{userId:finance.user.id,role:'View'}]})).status===403,"but the guest list is still the owner's");

console.log('\n=== the whole company ===');
await call(owner.token,'PATCH',`/drive/items/${folder}/sharing`,{visibility:'Organisation',orgRole:'View'});
check((await call(finance.token,'GET',`/drive/items/${file}/download`)).status===200,'anybody signed in can now view');
check((await upload(finance.token,'x.txt',Buffer.from('x'),sub)).status===403,'but not edit, since it was shared as view');

console.log('\n=== a public link ===');
r=await call(owner.token,'POST',`/drive/items/${file}/public`,{});
check(r.status===201,'created',String(r.status));
const link=r.body.link, token=link.split('/').pop();
const meta=await (await fetch(ROOT+link+'/meta')).json();
check(meta.name==='Site layout.dwg','anyone can see what it is without signing in',JSON.stringify(meta).slice(0,70));
check(!('owner' in meta) && !('ownerId' in meta) && !('parentId' in meta),'and learns nothing about the company',JSON.stringify(meta));
const dl=await fetch(ROOT+link+'/download');
check(dl.status===200,'and can download it',String(dl.status));
check(dl.headers.get('content-disposition')?.includes('attachment'),'served as a download, never rendered');
check(dl.headers.get('x-robots-tag')?.includes('noindex'),'and asks not to be indexed');

console.log('\n=== the public link does not spread ===');
const sibling=(await call(owner.token,'GET',`/drive?folder=${sub}`)).body.items.find(i=>i.name==='Tender pack.zip');
const sh=(await call(owner.token,'GET',`/drive/items/${sibling.id}/sharing`)).body;
check(sh.publicLink===null,'a file beside a published one is not itself published',String(sh.publicLink));
const folderPub=await call(owner.token,'POST',`/drive/items/${folder}/public`,{});
check(folderPub.status===400,'a folder cannot be published at all',String(folderPub.status));

console.log('\n=== bad and withdrawn links ===');
check((await fetch(ROOT+'/s/'+'A'.repeat(43)+'/meta')).status===404,'a guessed token');
check((await fetch(ROOT+'/s/short/meta')).status===404,'a malformed token');
await call(owner.token,'DELETE',`/drive/items/${file}/public`);
const after=await fetch(ROOT+link+'/download');
check(after.status===404,'a withdrawn link stops working',String(after.status));

console.log('\n=== only the owner publishes ===');
await call(owner.token,'PATCH',`/drive/items/${folder}/sharing`,{add:[{userId:finance.user.id,role:'Edit'}]});
check((await call(finance.token,'POST',`/drive/items/${file}/public`,{})).status===403,'an editor cannot publish');

console.log('\n=== asking to be let in ===');
const outsider=await login('manager@gkuc.lk');
const priv=await call(outsider.token,'POST','/drive/folders',{name:'Outsider folder'});
const mine=await call(owner.token,'POST','/drive/folders',{name:`Private ${Date.now()}`});
r=await call(outsider.token,'POST',`/drive/items/${mine.body.id}/request`,{role:'View',message:'Need the survey for the RDA bid'});
check(r.status===201,'a request can be made',String(r.status));
const sharing=(await call(owner.token,'GET',`/drive/items/${mine.body.id}/sharing`)).body;
check(sharing.requests.length===1,'the owner sees it',String(sharing.requests.length));
check(sharing.requests[0].message.includes('RDA'),'with what they said');
check((await call(owner.token,'POST',`/drive/requests/${sharing.requests[0].id}/decide`,{grant:true})).status===204,'and can grant it');
check((await call(outsider.token,'GET',`/drive?folder=${mine.body.id}`)).status===200,'after which they are in');

console.log('\n=== a folder cannot be moved inside itself ===');
check((await call(owner.token,'PATCH',`/drive/items/${folder}`,{parentId:sub})).status===400,'refused');

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
