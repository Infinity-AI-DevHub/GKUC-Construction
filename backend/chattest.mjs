const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   FAIL',l,d);}};
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json());
const call=async(t,m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${t}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};

const md=await login('owner@gkuc.lk'), store=await login('store@gkuc.lk'), qs=await login('finance@gkuc.lk');

/* A live listener, so "delivered" means something. */
const events={};
const listen=async(name,tok)=>{
  events[name]=[];
  const res=await fetch(BASE+'/events',{headers:{authorization:`Bearer ${tok}`}});
  const rd=res.body.getReader(); const dec=new TextDecoder(); let buf='';
  (async()=>{for(;;){const{value,done}=await rd.read(); if(done)break;
    buf+=dec.decode(value,{stream:true}); const fr=buf.split('\n\n'); buf=fr.pop();
    for(const f of fr){ if(!f.trim()||f.startsWith(':'))continue;
      let t='',d=''; for(const l of f.split('\n')){if(l.startsWith('event:'))t=l.slice(6).trim();else if(l.startsWith('data:'))d+=l.slice(5).trim();}
      try{events[name].push({type:t,data:JSON.parse(d)});}catch{}}}})();
  return res;
};

console.log('=== who you can talk to ===');
let r=await call(md.token,'GET','/chat/people');
check(r.status===200,'people list',String(r.status));
check(!r.body.some(p=>p.id===md.user.id),'you are not in your own list');
check(r.body.every(p=>'online' in p && 'lastActiveAt' in p),'each carries presence');

console.log('\n=== a direct conversation ===');
r=await call(md.token,'POST','/chat/direct',{userId:store.user.id});
/* 201 the first time, 200 on a re-run — the point is that there is exactly one. */
check(r.status===201||r.status===200,'opened',String(r.status)+JSON.stringify(r.body));
const direct=r.body.id;
const again=await call(md.token,'POST','/chat/direct',{userId:store.user.id});
check(again.body.id===direct && again.body.created===false,'opening it twice returns the same one');
check((await call(md.token,'POST','/chat/direct',{userId:md.user.id})).status===400,'cannot talk to yourself');

console.log('\n=== sending, with nobody listening: Sent ===');
r=await call(md.token,'POST',`/chat/conversations/${direct}/messages`,{body:'Did the cement arrive?'});
check(r.status===201,'sent',String(r.status));
check(r.body.status==='Sent','one tick — stored but not reached anybody',r.body.status);
const firstId=r.body.id;

console.log('\n=== the recipient connects: Delivered ===');
await listen('store',store.token);
await new Promise(x=>setTimeout(x,700));
const d=await call(store.token,'POST','/chat/delivered');
check(d.body.delivered>=1,'outstanding messages marked delivered',JSON.stringify(d.body));
r=await call(md.token,'GET',`/chat/conversations/${direct}/messages`);
check(r.body.at(-1).status==='Delivered','two ticks',r.body.at(-1).status);

console.log('\n=== they open it: Read ===');
await call(store.token,'POST',`/chat/conversations/${direct}/read`,{upToId:firstId});
r=await call(md.token,'GET',`/chat/conversations/${direct}/messages`);
check(r.body.at(-1).status==='Read','two filled ticks',r.body.at(-1).status);

console.log('\n=== a message to a listening recipient is delivered at once ===');
r=await call(md.token,'POST',`/chat/conversations/${direct}/messages`,{body:'Second message'});
check(r.body.status==='Delivered','delivered on send while they are connected',r.body.status);
await new Promise(x=>setTimeout(x,600));
check(events.store.some(e=>e.type==='chat:message'),'and it arrived over the live stream');

console.log('\n=== unread counts ===');
r=await call(store.token,'GET','/chat/conversations');
const convo=r.body.find(c=>c.id===direct);
check(Number(convo.unread)>=1,'the recipient has it unread',String(convo.unread));
check(convo.name===md.user.name,'a direct chat is named by the other person',convo.name);
check('online' in convo,'and shows whether they are there');
const mine=(await call(md.token,'GET','/chat/conversations')).body.find(c=>c.id===direct);
check(Number(mine.unread)===0,'nothing unread for the sender',String(mine.unread));

console.log('\n=== groups ===');
r=await call(md.token,'POST','/chat/groups',{name:'Kaduwela site team',topic:'Day to day',memberIds:[store.user.id,qs.user.id]});
check(r.status===201,'group created',String(r.status));
const group=r.body.id;
r=await call(md.token,'POST',`/chat/conversations/${group}/messages`,{body:'Pour moved to Thursday'});
check(r.status===201,'message sent to the group');
check(r.body.status==='Sent','not delivered while one member is away',r.body.status);
await listen('qs',qs.token); await new Promise(x=>setTimeout(x,600));
await call(qs.token,'POST','/chat/delivered');
await call(store.token,'POST','/chat/delivered');
r=await call(md.token,'GET',`/chat/conversations/${group}/messages`);
check(r.body.at(-1).status==='Delivered','delivered once it reaches everybody',r.body.at(-1).status);
await call(store.token,'POST',`/chat/conversations/${group}/read`,{upToId:r.body.at(-1).id});
r=await call(md.token,'GET',`/chat/conversations/${group}/messages`);
check(r.body.at(-1).status==='Delivered','still not read while one member has not opened it',r.body.at(-1).status);
check(r.body.at(-1).readBy===1,'and says how many have',String(r.body.at(-1).readBy));
await call(qs.token,'POST',`/chat/conversations/${group}/read`,{upToId:r.body.at(-1).id});
r=await call(md.token,'GET',`/chat/conversations/${group}/messages`);
check(r.body.at(-1).status==='Read','read once everybody has opened it',r.body.at(-1).status);

console.log('\n=== a conversation is private to its members ===');
const outsider=await login('manager@gkuc.lk');
check((await call(outsider.token,'GET',`/chat/conversations/${direct}/messages`)).status===404,'an outsider cannot read it');
check((await call(outsider.token,'POST',`/chat/conversations/${direct}/messages`,{body:'hello'})).status===404,'nor write to it');
check(!(await call(outsider.token,'GET','/chat/conversations')).body.some(c=>c.id===direct),'nor see it listed');

console.log('\n=== withdrawing ===');
const sent=await call(md.token,'POST',`/chat/conversations/${direct}/messages`,{body:'Ignore this'});
check((await call(store.token,'DELETE',`/chat/messages/${sent.body.id}`)).status===403,'only the sender may withdraw');
check((await call(md.token,'DELETE',`/chat/messages/${sent.body.id}`)).status===204,'the sender may');
r=await call(store.token,'GET',`/chat/conversations/${direct}/messages`);
check(r.body.at(-1).deletedAt!==null,'it is marked withdrawn, not erased');

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
