import mysql from 'mysql2/promise';
const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   FAIL',l,d);}};
const db=await mysql.createConnection({host:'127.0.0.1',port:8889,user:'root',password:'root',database:'gkuc_siteops'});
const md=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})})).json());
const call=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${md.token}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};
const [[proj]]=await db.query('SELECT id,name,client FROM projects WHERE active=1 LIMIT 1');
/* The suite shares one database with every other suite and with whatever a person has been
   clicking through. Anything it counts is stamped with this run so a second run counts its
   own rows and not the last one's. */
const run=Date.now().toString(36);

console.log('=== PHASE 2 — Finance: invoice creation with VAT/SVAT ===');
let r=await call('POST','/receivables/invoices',{
  projectId:proj.id, kind:'Interim', title:'IPA No. 3 — works to 25 August',
  invoiceDate:'2026-08-26', dueDate:'2026-09-25',
  taxTreatment:'Standard', vatRate:18, retentionPercent:10, advanceRecovery:450000,
  items:[{description:'Substructure works',unit:'item',quantity:1,rate:3000000},
         {description:'Reinforcement',unit:'kg',quantity:5000,rate:300}]});
check(r.status===201,'interim certificate raised',String(r.status)+JSON.stringify(r.body).slice(0,90));
const inv=r.body;
check(Math.abs(inv.gross-4500000)<1,'work certified adds up',String(inv.gross));
check(Math.abs(inv.vatAmount-810000)<1,'VAT at 18%',String(inv.vatAmount));
check(Math.abs(inv.retentionAmount-450000)<1,'retention at 10% held back',String(inv.retentionAmount));
check(Math.abs(inv.netPayable-4410000)<1,'net payable correct',String(inv.netPayable));

r=await call('POST','/receivables/invoices',{
  projectId:proj.id, title:'IPA No. 4 — SVAT', invoiceDate:'2026-08-26',
  taxTreatment:'SVAT', vatRate:18, retentionPercent:10,
  items:[{description:'Superstructure',quantity:1,rate:4500000}]});
check(r.status===201,'an SVAT certificate raised',String(r.status));
check(Math.abs(r.body.vatAmount-810000)<1,'VAT is still shown under SVAT',String(r.body.vatAmount));
check(Math.abs(r.body.netPayable-4050000)<1,'but not collected in the money due',String(r.body.netPayable));

console.log('\n=== the figures are the server\'s, not the browser\'s ===');
r=await call('POST','/receivables/invoices',{projectId:proj.id,title:'Tampered',invoiceDate:'2026-08-26',
  taxTreatment:'Standard',vatRate:18,retentionPercent:10,netPayable:1,gross:1,
  items:[{description:'Work',quantity:1,rate:1000000}]});
check(Math.abs(r.body.netPayable-1080000)<1,'a supplied total is ignored and recomputed',String(r.body.netPayable));

console.log('\n=== receipts and receivables ===');
check((await call('POST',`/receivables/invoices/${inv.id}/receipts`,{amount:100,receivedDate:'2026-08-26'})).status===409,'money cannot be recorded before the invoice is issued');
check((await call('POST',`/receivables/invoices/${inv.id}/issue`)).status===204,'issued');
r=await call('POST',`/receivables/invoices/${inv.id}/receipts`,{amount:99999999,receivedDate:'2026-08-26'});
check(r.status===400,'cannot receive more than is outstanding',String(r.status));
check((await call('POST',`/receivables/invoices/${inv.id}/receipts`,{amount:2000000,receivedDate:'2026-08-26',reference:`BOC-${run}`})).status===201,'part payment recorded');
const one=(await call('GET',`/receivables/invoices/${inv.id}`)).body;
check(one.status==='Part paid','status follows the money',one.status);
check(Number(one.paid_amount)===2000000,'paid amount tracked',String(one.paid_amount));
const [[inc]]=await db.query('SELECT COUNT(*) n FROM incomes WHERE reference=?',[`BOC-${run}`]);
check(Number(inc.n)===1,'and it lands as project income exactly once',String(inc.n));

const ageing=(await call('GET','/receivables/ageing')).body;
check(Number(ageing.totals.outstanding)>0,'ageing shows what is owed',String(ageing.totals.outstanding));
check(Number(ageing.totals.retentionHeld)>0,'and how much retention is held',String(ageing.totals.retentionHeld));

console.log('\n=== bonds ===');
r=await call('POST','/receivables/bonds',{projectId:proj.id,kind:'Advance payment',
  beneficiary:proj.client,bank:'Bank of Ceylon',bondNumber:'BG/2026/881',
  amount:4500000,marginHeld:450000,commission:22500,
  issuedDate:'2026-02-01',expiryDate:'2026-09-10'});
check(r.status===201,'bond recorded',String(r.status));
const bonds=(await call('GET','/receivables/bonds')).body;
check(bonds.some(b=>b.reference===r.body.reference),'and listed');
check(bonds.find(b=>b.reference===r.body.reference).daysLeft<=30,'with the days left to expiry');

console.log('\n=== petty cash ===');
r=await call('POST','/receivables/petty-cash',{name:'Kaduwela site float',holderName:'Dilan Fernando',
  projectId:proj.id,ceiling:100000,lowAt:20000});
check(r.status===201,'float created',String(r.status));
const float=r.body.id;
check((await call('POST',`/receivables/petty-cash/${float}/entries`,{kind:'Spend',amount:5000,entryDate:'2026-08-26',description:'Tea and sundries'})).status===400,'cannot spend from an empty float');
check((await call('POST',`/receivables/petty-cash/${float}/entries`,{kind:'Top up',amount:100000,entryDate:'2026-08-26',description:'Opening float'})).status===201,'topped up');
check((await call('POST',`/receivables/petty-cash/${float}/entries`,{kind:'Spend',amount:6500,entryDate:'2026-08-26',description:`Diesel for generator ${run}`,category:'Fuel'})).status===201,'spend recorded');
const floats=(await call('GET','/receivables/petty-cash')).body;
const mine=floats.find(f=>f.id===float);
check(Math.abs(Number(mine.balance)-93500)<1,'balance is the sum of what happened',String(mine.balance));
const [[pe]]=await db.query('SELECT COUNT(*) n FROM expenses WHERE description=?',[`Petty cash — Diesel for generator ${run}`]);
check(Number(pe.n)===1,'and a site spend becomes a project cost',String(pe.n));

console.log('\n=== PHASE 4 — tools not returned ===');
const [[eq]]=await db.query('SELECT id FROM equipment LIMIT 1');
await db.query("DELETE FROM equipment_assignments WHERE assigned_to='Overdue Holder'");
/* An asset may be out already — from the last run of this suite, or from somebody using the
   system. Only one lending of an asset may be open at a time (the database enforces it), so
   whatever is open is closed before this overdue one is staged. */
await db.query('UPDATE equipment_assignments SET returned_at=CURDATE() WHERE equipment_id=? AND returned_at IS NULL',[eq.id]);
await db.query(`INSERT INTO equipment_assignments (equipment_id,project_id,assigned_to,assigned_at,due_back,created_by)
                VALUES (?,?,'Overdue Holder',DATE_SUB(CURDATE(),INTERVAL 40 DAY),DATE_SUB(CURDATE(),INTERVAL 26 DAY),1)`,[eq.id,proj.id]);

console.log('=== PHASE 1 + running the scan so every new watch fires ===');
await db.query("DELETE FROM notifications WHERE dedupe_key LIKE 'bond:%' OR dedupe_key LIKE 'receivable:%' OR dedupe_key LIKE 'tool-return:%'");
r=await call('POST','/notifications/scan');
check(r.status===200,'scan ran',String(r.status));
const [raised]=await db.query(`SELECT dedupe_key k,title FROM notifications
  WHERE dedupe_key LIKE 'bond:%' OR dedupe_key LIKE 'receivable:%' OR dedupe_key LIKE 'tool-return:%'`);
const kinds=new Set(raised.map(x=>x.k.split(':')[0]));
check(kinds.has('bond'),'a bond expiry was raised');
check(kinds.has('tool-return'),'an unreturned tool was raised');
for(const x of raised.slice(0,3)) console.log('   •',x.title);

console.log('\n=== the evening summary ===');
r=await call('GET','/summary/preview');
check(r.status===200,'preview built',String(r.status));
check(r.body.text.includes('On site today'),'covers the site');
check(r.body.text.includes('Spent today'),'covers the money');
console.log('   --- what the MD would receive ---');
console.log(r.body.text.split('\n').map(l=>'   '+l).join('\n'));

console.log('\n=== permissions ===');
const store=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'store@gkuc.lk',password:'GKUC@2026'})})).json());
const asStore=async p=>(await fetch(BASE+p,{headers:{authorization:`Bearer ${store.token}`}})).status;
check(await asStore('/receivables/invoices')===403,'a storekeeper cannot see client invoices');
check(await asStore('/receivables/bonds')===403,'nor bonds');
check(await asStore('/summary/preview')===403,'nor the summary');

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
await db.end();
process.exit(fail?1:0);
