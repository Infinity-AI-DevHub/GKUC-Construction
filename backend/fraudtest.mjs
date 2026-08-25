import mysql from 'mysql2/promise';
const BASE='http://127.0.0.1:4400/api';
let pass=0,fail=0; const check=(o,l,d='')=>{if(o)pass++;else{fail++;console.log('   MISS',l,d);}};
const db=await mysql.createConnection({host:'127.0.0.1',port:8889,user:'root',password:'root',database:'gkuc_siteops'});
const md=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})})).json());
const call=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json',authorization:`Bearer ${md.token}`},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>null)}};

const [[proj]]=await db.query('SELECT id FROM projects WHERE active=1 LIMIT 1');
const [[user]]=await db.query('SELECT id FROM users WHERE email=? LIMIT 1',['store@gkuc.lk']);
const P=proj.id, U=user.id;
await db.query("DELETE FROM risk_findings");
/* Re-runnable: the planted rows are removed before they are planted again. */
await db.query("DELETE FROM attendance WHERE employee_name LIKE '%(ghost)%' OR employee_name LIKE 'Copied Worker%'");
await db.query("DELETE FROM expenses WHERE description IN ('Diesel — bulk','Gang wages','Site works') OR description LIKE 'Diesel top-up%' OR description LIKE 'Gang wages week%'");
await db.query("DELETE FROM purchase_orders WHERE reference LIKE 'SPLIT-%'");
await db.query("DELETE FROM supplier_invoices WHERE invoice_no LIKE 'INV-%' OR invoice_no LIKE 'OVER-%'");
await db.query("DELETE FROM stock_movements WHERE quantity = 999999");

console.log('planting known fraud and errors into the data…\n');

/* 1. A normal run of fuel costs, then one ten times the size. */
for(let i=0;i<12;i++) await db.query(
 "INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by) VALUES (?,'Fuel',?,?,CURDATE(),?)",
 [P,`Diesel top-up ${i}`, 45000+Math.round(Math.random()*3000), U]);
/* Deliberately not a decimal shift: 320,000 divided by 10 or 100 is nowhere near the
   usual 45,000, so it cannot be explained as a typing slip — it is simply a large cost. */
const [outlier]=await db.query(
 "INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by) VALUES (?,'Fuel','Diesel — bulk',320000,CURDATE(),?)",[P,U]);

/* 2. A decimal slip: a hundred times the usual labour cost. */
for(let i=0;i<10;i++) await db.query(
 "INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by) VALUES (?,'Labour',?,?,CURDATE(),?)",
 [P,`Gang wages week ${i}`, 82000+Math.round(Math.random()*4000), U]);
const [slip]=await db.query(
 "INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by) VALUES (?,'Labour','Gang wages',8400000,CURDATE(),?)",[P,U]);

/* 3. Split purchases: four orders just under the 250,000 limit, one supplier, one week. */
const [[sup]]=await db.query('SELECT id FROM suppliers LIMIT 1');
for(let i=0;i<4;i++) await db.query(
 "INSERT INTO purchase_orders (reference,supplier_id,project_id,order_date,total,status,issued_by) VALUES (?,?,?,DATE_SUB(CURDATE(), INTERVAL ? DAY),?, 'Issued',?)",
 [`SPLIT-${Date.now()}-${i}`,sup.id,P,i,238000+i*1000,U]);

/* 4. The same invoice twice. */
const stamp=Date.now();
await db.query("INSERT INTO supplier_invoices (supplier_id,invoice_no,amount,paid_amount,invoice_date,status,recorded_by) VALUES (?,?,?,0,CURDATE(),'Unpaid',?)",[sup.id,`INV-${stamp}`,675400,U]);
/* The same bill re-entered under a slightly different reference — the exact-duplicate
   number is already refused by a unique key, so this is the case that gets through. */
await db.query("INSERT INTO supplier_invoices (supplier_id,invoice_no,amount,paid_amount,invoice_date,status,recorded_by) VALUES (?,?,?,0,DATE_SUB(CURDATE(),INTERVAL 3 DAY),'Unpaid',?)",[sup.id,`INV-${stamp}-A`,675400,U]);

/* 5. Paid more than invoiced. */
const [over]=await db.query("INSERT INTO supplier_invoices (supplier_id,invoice_no,amount,paid_amount,invoice_date,status,recorded_by) VALUES (?,?,?,?,CURDATE(),'Paid',?)",[sup.id,`OVER-${stamp}`,300000,455000,U]);

/* 6. A ghost worker: days booked against a name on no employee record.
      (One person on two sites the same day is already impossible — the attendance table
       has a unique key on name and date, which refuses it at the database.) */
for(let d=0;d<6;d++) await db.query(
 "INSERT INTO attendance (employee_name,role,project_id,work_date,state,check_in) VALUES ('S. Kumara (ghost)','Mason',?,DATE_SUB(CURDATE(),INTERVAL ? DAY),'On site','07:30:00')",[P,d+10]);

/* 7. A whole gang checked in at the identical second. */
for(let i=0;i<8;i++) await db.query(
 "INSERT INTO attendance (employee_name,role,project_id,work_date,state,check_in) VALUES (?,'Labourer',?,DATE_SUB(CURDATE(),INTERVAL 2 DAY),'On site','07:00:00')",
 [`Copied Worker ${i}`,P]);

/* 8. Impossible stock: issue more than was ever received. */
const [[mat]]=await db.query('SELECT id FROM materials LIMIT 1');
await db.query("INSERT INTO stock_movements (material_id,movement_type,quantity,project_id,user_id) VALUES (?,'Issue',999999,?,?)",[mat.id,P,U]);

/* 9. A very round large figure. */
await db.query("INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by) VALUES (?,'Subcontractor','Site works',2000000,CURDATE(),?)",[P,U]);

console.log('running the sweep…');
const scan=await call('POST','/integrity/scan');
check(scan.status===200,'sweep ran',String(scan.status));
console.log(`  ${scan.body.rules} rules, ${scan.body.failures.length} failed\n`);
if(scan.body.failures.length) console.log('  failures:',JSON.stringify(scan.body.failures));

const findings=(await call('GET','/integrity/findings')).body;
const has=rule=>findings.filter(f=>f.rule===rule);
const show=rule=>{const f=has(rule)[0]; return f?`${f.severity} — ${f.title}`:'';};

console.log('=== what it caught ===');
for(const [rule,label] of [
 ['expense.outlier','a fuel cost far outside the usual range'],
 ['expense.decimal.slip','decimal point in the wrong place'],
 ['purchase.split','orders split under the approval limit'],
 ['invoice.duplicate','the same invoice twice'],
 ['payment.overpaid','paid more than invoiced'],
 ['attendance.unknown.person','a worker who is on no employee record'],
 ['attendance.identical','a gang with identical check-ins'],
 ['stock.impossible','more issued than received'],
 ['expense.round','a suspiciously round figure']]){
  const got=has(rule).length>0;
  check(got, label, got?'':'NOT DETECTED');
  if(got) console.log(`  ✓ ${label}\n      ${show(rule)}`);
}

console.log('\n=== the detail a reviewer actually gets ===');
const slipFinding=has('expense.decimal.slip')[0];
if(slipFinding){ console.log('  '+slipFinding.title); console.log('  '+slipFinding.detail); console.log('  evidence: '+JSON.stringify(slipFinding.evidence)); }

console.log('\n=== ranking ===');
check(findings.length>0,'findings returned');
const order=findings.map(f=>f.severity);
const rank={Critical:0,High:1,Medium:2,Low:3};
check(order.every((s,i)=>i===0||rank[order[i-1]]<=rank[s]),'worst first',order.slice(0,6).join(','));
console.log('  '+findings.slice(0,5).map(f=>`${f.severity}(${f.score})`).join('  '));

console.log('\n=== summary for the dashboard ===');
const sum=(await call('GET','/integrity/summary')).body;
console.log('  open:',sum.totals.open,'| urgent:',sum.totals.urgent,'| by category:',JSON.stringify(sum.byCategory));
check(Number(sum.totals.open)>0,'summary counts findings');

console.log('\n=== a sweep run twice does not duplicate ===');
const before=(await call('GET','/integrity/findings')).body.length;
await call('POST','/integrity/scan');
const after=(await call('GET','/integrity/findings')).body.length;
check(before===after,'same count after a second sweep',`${before} then ${after}`);

console.log('\n=== reviewing ===');
const one=findings[0];
check((await call('POST',`/integrity/findings/${one.id}/review`,{status:'Dismissed'})).status===400,'dismissing needs a reason');
check((await call('POST',`/integrity/findings/${one.id}/review`,{status:'Dismissed',note:'Checked against the invoice — genuine bulk delivery'})).status===204,'dismissing with a reason works');
const openNow=(await call('GET','/integrity/findings')).body;
check(!openNow.some(f=>f.id===one.id),'and it leaves the open list');

console.log('\n=== only those who may see the audit trail may see findings ===');
const store=(await(await fetch(BASE+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'store@gkuc.lk',password:'GKUC@2026'})})).json());
const r=await fetch(BASE+'/integrity/findings',{headers:{authorization:`Bearer ${store.token}`}});
check(r.status===403,'store keeper refused',String(r.status));

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
await db.end();
process.exit(fail?1:0);
