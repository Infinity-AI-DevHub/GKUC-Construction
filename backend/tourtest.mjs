const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   FAIL',l,d);}};
const login=async e=>(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e,password:'GKUC@2026'})})).json());
const call=async(t,m,p)=>{const r=await fetch(BASE+p,{method:m,headers:{authorization:`Bearer ${t}`}});return r.status;};
const boot=async t=>(await(await fetch(BASE+'/bootstrap',{headers:{authorization:`Bearer ${t}`}})).json()).user;

console.log('=== a fresh account has not been shown round ===');
const store=await login('store@gkuc.lk');
await call(store.token,'POST','/auth/tour-reset');
let u=await boot(store.token);
check(u.tourSeenAt===null,'tourSeenAt is null before the tour',String(u.tourSeenAt));

console.log('\n=== finishing it is recorded on the account ===');
check(await call(store.token,'POST','/auth/tour-seen')===204,'marked seen');
u=await boot(store.token);
check(u.tourSeenAt!==null,'tourSeenAt is now set',String(u.tourSeenAt));

console.log('\n=== and it follows them to another device ===');
const second=await login('store@gkuc.lk');
const u2=await boot(second.token);
check(u2.tourSeenAt!==null,'a new session still knows',String(u2.tourSeenAt));

console.log('\n=== it can be asked for again ===');
check(await call(store.token,'POST','/auth/tour-reset')===204,'reset accepted');
u=await boot(store.token);
check(u.tourSeenAt===null,'ready to show again');

console.log('\n=== it is per person, not global ===');
const md=await login('owner@gkuc.lk');
await call(md.token,'POST','/auth/tour-seen');
const mdUser=await boot(md.token), storeUser=await boot(store.token);
check(mdUser.tourSeenAt!==null && storeUser.tourSeenAt===null,'one person seeing it does not affect another');

console.log('\n=== signing in is required ===');
const r=await fetch(BASE+'/auth/tour-seen',{method:'POST'});
check(r.status===401,'refused without a session',String(r.status));

await call(store.token,'POST','/auth/tour-seen');
console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail?1:0);
