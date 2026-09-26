import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const port = 43971;
const base = `http://127.0.0.1:${port}/api`;
const testDatabase = 'gkuc_siteops_test';
let server;
let serverOutput = '';
let admin;
let testUploadDir;

const today = () => new Date().toISOString().slice(0, 10);
const shift = days => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

before(async () => {
  testUploadDir = await mkdtemp(path.join(os.tmpdir(), 'gkuc-api-uploads-'));
  admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.query(`CREATE DATABASE \`${testDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  server = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DB_NAME: testDatabase, UPLOAD_DIR: testUploadDir }, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput += chunk.toString(); });
  /* A cold schema build can take more than nine seconds on the bundled MySQL runtime.
     Give it enough room without weakening the health check itself. */
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Test server did not start: ${serverOutput.slice(-2000)}`);
});

after(async () => {
  server?.kill('SIGTERM');
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.end();
  if (testUploadDir) await rm(testUploadDir, { recursive: true, force: true });
});

async function login(email = 'owner@gkuc.lk') {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'GKUC@2026' }) });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

const call = async (token, method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

test('employee needs only name and code and personal details remain editable', async () => {
  const owner = await login();
  const created = await call(owner, 'POST', '/employees', { name:'Personal Test', code:'PERSONAL-TEST' });
  assert.equal(created.status,201);
  const id = created.body.id;
  const details = {birthDate:'1995-04-12',nicNumber:'951234567V',additionalPhone1:'0711111111',additionalPhone2:'0722222222',residentialAddress:'Current home',permanentAddress:'Permanent home'};
  const updated = await call(owner,'PATCH',`/employees/${id}`,details);
  assert.equal(updated.status,200);
  for (const key of Object.keys(details).filter(key=>key!=='birthDate')) assert.equal(updated.body[key],details[key]);
  const cleared = await call(owner,'PATCH',`/employees/${id}`,{birthDate:null,nicNumber:''});
  assert.equal(cleared.status,200);
  assert.equal(cleared.body.birthDate,null);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[id]);
});

test('creating system access creates or links an employee without duplicating their profile', async () => {
  const owner = await login();
  const roles = await call(owner, 'GET', '/users/roles');
  const role = roles.body[0];
  const created = await call(owner, 'POST', '/users', { name: 'Profile Link Test', email: 'profile.link.test@gkuc.lk', password: 'TempPass2026!', roleId: role.id });
  assert.equal(created.status, 201);
  const [employees] = await admin.query(`SELECT * FROM ${testDatabase}.employees WHERE user_id=?`, [created.body.id]);
  assert.equal(employees.length, 1);
  assert.equal(Number(employees[0].basic_salary), 0);
  assert.equal(Number(employees[0].epf_eligible), 0);
  const linkedAgain = await call(owner, 'POST', '/users', { name: 'Second Access', email: 'second.access@gkuc.lk', password: 'TempPass2026!', roleId: role.id, employeeId: employees[0].id });
  assert.equal(linkedAgain.status, 409);
  await admin.query(`DELETE FROM ${testDatabase}.audit_log WHERE entity_id=? AND entity='employee'`, [employees[0].id]).catch(() => {});
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`, [employees[0].id]);
  await admin.query(`DELETE FROM ${testDatabase}.users WHERE id=?`, [created.body.id]);
});

function testPdf(lines) {
  const stream = `BT /F1 12 Tf 45 750 Td ${lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('reviews and saves a PDF subcontractor quotation against a selected project', async () => {
  const token = await login();
  const pdf = testPdf(['From: PDF Test Electrical', 'Quotation No: Q-123', 'Date: 2026-09-18',
    'Scope of work: Lighting', '1 Cable installation      m  12  450.00  5400.00', 'Total 5,400.00']);
  const previewForm = new FormData();
  previewForm.append('file', new Blob([pdf], { type: 'application/pdf' }), 'quote.pdf');
  const previewResponse = await fetch(`${base}/qs/subcontract-quotations/pdf/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: previewForm
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.items.length, 1);
  assert.equal(preview.subcontractor.name, 'PDF Test Electrical');

  const commitForm = new FormData();
  commitForm.append('file', new Blob([pdf], { type: 'application/pdf' }), 'quote.pdf');
  commitForm.append('review', JSON.stringify({ companyId: 1, projectId: 1,
    subcontractor: { mode: 'new', name: preview.subcontractor.name, trade: 'Electrical', contactType: 'Company' },
    quotation: { ...preview.quotation, package: 'Lighting' },
    items: preview.items.map(({ description, unit, quantity, rate, discount }) => ({ description, unit, quantity, rate, discount }))
  }));
  const createdResponse = await fetch(`${base}/qs/subcontract-quotations/pdf/commit`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: commitForm
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created.projectId, 1);
  assert.equal(created.sourceFilename, 'quote.pdf');
  assert.equal((await call(token, 'GET', `/qs/subcontract-quotations/${created.id}`)).body.items.length, 1);
  assert.equal((await fetch(`${base}/qs/subcontract-quotations/${created.id}/pdf`, {
    headers: { authorization: `Bearer ${token}` }
  })).status, 200);
});

test('reviews and saves a PDF tender while linking an existing client', async () => {
  const token = await login();
  const clientResponse = await call(token, 'POST', '/clients', { type: 'Organisation', name: 'Road Development Authority Test' });
  assert.equal(clientResponse.status, 201);
  const client = clientResponse.body;
  assert.ok(client);
  const pdf = testPdf([`Employer: ${client.name}`, 'Name of Work: Improvement of a test road',
    'Contract No: PDF-TEST-2026-01', 'Closing date: 18/09/2026 10:30', 'Bid validity: 91 days']);
  const previewForm = new FormData();
  previewForm.append('file', new Blob([pdf], { type: 'application/pdf' }), 'tender.pdf');
  const previewResponse = await fetch(`${base}/qs/tenders/pdf/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: previewForm
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.fields.contractNo, 'PDF-TEST-2026-01');
  assert.ok(preview.matches.some(match => match.id === client.id));
  const commitForm = new FormData();
  commitForm.append('file', new Blob([pdf], { type: 'application/pdf' }), 'tender.pdf');
  commitForm.append('review', JSON.stringify({ companyId: 1,
    clientSelection: { mode: 'existing', id: client.id },
    ...preview.fields, biddingEntity: 'GKUC Construction'
  }));
  const createdResponse = await fetch(`${base}/qs/tenders/pdf/commit`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: commitForm
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created.clientId, client.id);
  assert.equal(created.sourceFilename, 'tender.pdf');
  assert.equal((await fetch(`${base}/qs/tenders/${created.id}/pdf`, {
    headers: { authorization: `Bearer ${token}` }
  })).status, 200);
  const duplicate = new FormData();
  duplicate.append('file', new Blob([pdf], { type: 'application/pdf' }), 'tender.pdf');
  duplicate.append('review', JSON.stringify({ companyId: 1,
    clientSelection: { mode: 'existing', id: client.id },
    ...preview.fields, biddingEntity: 'GKUC Construction'
  }));
  assert.equal((await fetch(`${base}/qs/tenders/pdf/commit`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: duplicate
  })).status, 409);

  const newClientForm = new FormData();
  newClientForm.append('file', new Blob([pdf], { type: 'application/pdf' }), 'tender.pdf');
  newClientForm.append('review', JSON.stringify({ companyId: 1,
    clientSelection: { mode: 'new', name: 'PDF Import New Employer', type: 'Organisation' },
    ...preview.fields, contractNo: 'PDF-TEST-2026-02', biddingEntity: 'GKUC Construction'
  }));
  const newClientResponse = await fetch(`${base}/qs/tenders/pdf/commit`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: newClientForm
  });
  const newClientTender = await newClientResponse.json();
  assert.equal(newClientResponse.status, 201, JSON.stringify(newClientTender));
  assert.equal(newClientTender.client, 'PDF Import New Employer');
});

test('task reminders reach selected users once per schedule and stop on completion',async()=>{
  const owner=await login();
  const people=(await call(owner,'GET','/tasks/reminder-users')).body;
  const recipient=people[0];
  const created=await call(owner,'POST','/tasks',{title:'Reminder delivery test',projectId:1,
    assignee:'Test crew',due:'2026-10-01 at 16:00',dueDate:'2026-10-01',dueTime:'16:00',priority:'Medium',
    reminderAt:'2020-01-01T09:00',reminderFrequency:'Daily',reminderUserIds:[recipient.id]});
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal((await call(owner,'POST','/notifications/scan',{})).status,200);
  const [[first]]=await admin.query(`SELECT COUNT(*) total FROM ${testDatabase}.notifications
    WHERE dedupe_key LIKE ? AND user_id=?`,[`task-reminder:${created.body.id}:%`,recipient.id]);
  assert.equal(Number(first.total),1);
  await call(owner,'POST','/notifications/scan',{});
  const [[second]]=await admin.query(`SELECT COUNT(*) total FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`,[`task-reminder:${created.body.id}:%`]);
  assert.equal(Number(second.total),1);
  await call(owner,'PATCH',`/tasks/${created.body.id}`,{status:'Completed'});
  await admin.query(`UPDATE ${testDatabase}.task_reminders SET next_due='2020-01-01' WHERE task_id=?`,[created.body.id]);
  await call(owner,'POST','/notifications/scan',{});
  const [[stopped]]=await admin.query(`SELECT active FROM ${testDatabase}.task_reminders WHERE task_id=?`,[created.body.id]);
  assert.equal(Number(stopped.active),0);
  await admin.query(`DELETE FROM ${testDatabase}.tasks WHERE id=?`,[created.body.id]);
});

test('requires authentication for operational data', async () => {
  assert.equal((await fetch(`${base}/bootstrap`)).status, 401);
});

test('authenticates and returns database-backed operational data', async () => {
  const token = await login();
  const { status, body } = await call(token, 'GET', '/bootstrap');
  assert.equal(status, 200);
  assert.equal(body.data.projects.length, 3);
  assert.equal(body.data.tasks.length, 5);
  assert.equal(body.data.employees.length, 8);
  assert.equal(body.data.equipment.length, 5);
  assert.equal(body.user.role, 'Managing Director', 'PID v3 §2.1 role names');
  assert.ok(body.user.permissions.length > 30, 'the MD holds every permission');
});

test('enforces role permissions and records authorized changes', async () => {
  const store = await login('store@gkuc.lk');
  assert.equal((await call(store, 'PATCH', '/tasks/1', { status: 'Completed' })).status, 403);

  const owner = await login();
  assert.equal((await call(owner, 'PATCH', '/tasks/1', { status: 'Completed' })).status, 200);
  const audit = await call(owner, 'GET', '/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some(entry => entry.entity === 'task' && entry.action === 'UPDATE'));
});

test('only management can approve completed work', async () => {
  const supervisor = await login('supervisor@gkuc.lk');
  assert.equal((await call(supervisor, 'PATCH', '/tasks/1', { status: 'Approved' })).status, 403);
  const manager = await login('manager@gkuc.lk');
  assert.equal((await call(manager, 'PATCH', '/tasks/1', { status: 'Approved' })).status, 200);
});

test('purchase request, order, goods receipt and stock stay in step', async () => {
  const store = await login('store@gkuc.lk');
  const owner = await login();

  const before = (await call(owner, 'GET', '/materials')).body.find(material => material.id === 1);

  const request = await call(store, 'POST', '/purchasing/requests', {
    projectId: 1,
    neededBy: shift(7),
    items: [{ materialId: 1, description: 'Portland cement 50kg', unit: 'bags', quantity: 100, estimatedRate: 2450 }]
  });
  assert.equal(request.status, 201);

  /* A storekeeper raises the request; approving it is a management decision. */
  assert.equal((await call(store, 'PATCH', `/purchasing/requests/${request.body.id}`, { status: 'Approved' })).status, 403);
  assert.equal((await call(owner, 'PATCH', `/purchasing/requests/${request.body.id}`, { status: 'Approved' })).status, 200);

  const order = await call(store, 'POST', '/purchasing/orders', {
    requestId: request.body.id,
    supplierId: 1,
    projectId: 1,
    orderDate: today(),
    items: [{ materialId: 1, description: 'Portland cement 50kg', unit: 'bags', quantity: 100, rate: 2500 }]
  });
  assert.equal(order.status, 201);

  const detail = await call(owner, 'GET', `/purchasing/orders/${order.body.id}`);
  const line = detail.body.items[0];

  const over = await call(store, 'POST', `/purchasing/orders/${order.body.id}/receive`, { lines: [{ itemId: line.id, quantity: 150 }] });
  assert.equal(over.status, 409, 'cannot receive more than was ordered');

  assert.equal((await call(store, 'POST', `/purchasing/orders/${order.body.id}/receive`, { lines: [{ itemId: line.id, quantity: 100 }] })).status, 200);

  const after = (await call(owner, 'GET', '/materials')).body.find(material => material.id === 1);
  assert.equal(Number(after.stock), Number(before.stock) + 100);

  /*
   * Stock received into the store is not a project cost yet — it becomes one when it is
   * issued to a site. Charging it here as well billed the project twice for the same
   * material, so a stocked line deliberately raises no expense on receipt.
   */
  const expenses = await call(owner, 'GET', '/finance/expenses?projectId=1');
  assert.ok(!expenses.body.some(expense => expense.originType === 'purchase_order'),
    'receiving stocked material does not charge the project');

  const issued = await call(store, 'POST', '/materials/1/movements', { type: 'Issue', quantity: 10, projectId: 1 });
  assert.equal(issued.status, 201);
  const afterIssue = await call(owner, 'GET', '/finance/expenses?projectId=1');
  assert.ok(afterIssue.body.some(expense => expense.originType === 'stock_movement'),
    'issuing it to the site is what charges the site');
});

test('issuing stock cannot drive a balance negative', async () => {
  const store = await login('store@gkuc.lk');
  const result = await call(store, 'POST', '/materials/4/movements', { type: 'Issue', quantity: 100000 });
  assert.equal(result.status, 409);
});

test('an unreceived store transfer cannot make stock disappear from the location register', async () => {
  const store = await login('store@gkuc.lk');
  const result = await call(store, 'POST', '/materials/4/movements', { type: 'Transfer', quantity: 1, destination: 'Other store' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /receiving stock record/);
});

test('project coordination, subcontract rates and site stock custody stay linked',async()=>{
  const owner=await login(),store=await login('store@gkuc.lk'),qs=await login('qs@gkuc.lk');
  const project=await call(owner,'POST','/projects',{name:'Construction Operations Test Site',client:'Test Client',manager:'Project Manager',
    site:'Colombo Test Site',stage:'Execution',budget:500000,progress:10,health:'Watch'});
  assert.equal(project.status,201);const projectId=project.body.id;
  const issue=await call(owner,'POST',`/projects/${projectId}/updates`,{kind:'Issue',title:'Cement delivery delayed',
    details:'Supplier has not passed the cement to the site.',category:'Materials delay',priority:'High',owner:'Project Coordinator'});
  assert.equal(issue.status,201);
  assert.equal((await call(owner,'PATCH',`/projects/updates/${issue.body.id}`,{status:'In progress'})).status,200);
  const projectDetail=await call(owner,'GET',`/projects/${projectId}`);
  assert.ok(projectDetail.body.updates.some(row=>row.title==='Cement delivery delayed'&&row.status==='In progress'));
  const assigned=await call(owner,'POST','/tasks',{projectId,title:'Confirm cement arrival',assignee:'Project Coordinator',
    due:today(),dueDate:today(),priority:'High',status:'Not started',notes:'Call supplier and confirm gate pass.'});
  assert.equal(assigned.status,201);
  const revised=await call(owner,'PATCH',`/tasks/${assigned.body.id}`,{assignee:'Site Manager',priority:'Medium',
    notes:'Escalate with the supplier and update the project issue.'});
  assert.equal(revised.status,200);
  assert.equal(revised.body.assignee,'Site Manager');

  const subcontractor=await call(owner,'POST','/qs/subcontractors',{name:`Waterproofing Test ${Date.now()}`,trade:'Waterproofing',
    contactType:'Company',contact:'Site Foreman',phone:'0770000000',address:'Homagama',businessId:'PV-TEST-100'});
  assert.equal(subcontractor.status,201);
  const rate=await call(owner,'POST','/qs/subcontractor-rates',{projectId,subcontractorId:subcontractor.body.id,
    workItem:'Membrane installation',unit:'m2',rate:850,agreedOn:today()});
  assert.equal(rate.status,201);
  const material=await call(store,'POST','/materials',{name:'Test waterproofing compound',unit:'bags',stock:100,
    minimum:10,site:'Central store',unitCost:4000,stockKind:'Consumable'});
  assert.equal(material.status,201);
  const boq=await call(qs,'POST','/boq',{projectId,title:'Waterproofing package',items:[
    {category:'Subcontract',description:'Membrane installation',unit:'m2',quantity:20,rate:1,subcontractRateId:rate.body.id},
    {category:'Material',description:'Waterproofing compound',unit:'bags',quantity:10,rate:4000,materialId:material.body.id}
  ]});
  assert.equal(boq.status,201);
  const boqDetail=await call(qs,'GET',`/boq/${boq.body.id}`);
  assert.equal(Number(boqDetail.body.items[0].rate),850,'the agreed project rate overrides an entered subcontract cost');
  assert.equal(Number(boqDetail.body.items[0].amount),17000);
  assert.equal((await call(owner,'PATCH',`/boq/${boq.body.id}`,{status:'Approved'})).status,200);
  const quote=await call(qs,'POST','/qs/quotations',{boqId:boq.body.id,markupPercent:10,vatPercent:0});
  assert.equal(quote.status,201);
  const quoted=(await call(qs,'GET',`/qs/quotations/${quote.body.id}`)).body;
  assert.ok(quoted.items.some(row=>Number(row.materialId)===Number(material.body.id)),
    'the quotation snapshot retains its linked material identity');
  const subcontractLine=quoted.items.find(row=>row.category==='Subcontract'&&Number(row.rate)===850);
  assert.ok(subcontractLine,
    'the agreed rate flows through the BOQ into the quotation snapshot');
  assert.equal((await call(qs,'PATCH',`/qs/quotations/${quote.body.id}`,{status:'Accepted'})).status,200);
  const invoice=await call(owner,'POST','/receivables/invoices',{projectId,kind:'Interim',title:'Certified membrane works',
    invoiceDate:today(),taxTreatment:'Exempt',retentionPercent:0,advanceRecovery:0,otherDeductions:0,
    items:[{description:'Membrane installation',unit:'m2',quantity:2,rate:1,quotationItemId:subcontractLine.id}]});
  assert.equal(invoice.status,201);
  assert.equal(Number(invoice.body.gross),1870,'invoicing uses the accepted client quotation rate, including its markup');
  assert.equal((await call(store,'POST',`/materials/${material.body.id}/movements`,{
    type:'Issue',quantity:12,projectId,reference:'SITE-ISSUE-12'})).status,201);

  const tool=await call(store,'POST','/materials',{name:'Test concrete drill',unit:'items',stock:5,
    minimum:1,site:'Central store',unitCost:35000,stockKind:'Returnable'});
  assert.equal(tool.status,201);
  assert.equal((await call(store,'POST',`/materials/${tool.body.id}/movements`,{type:'Issue',quantity:1,projectId})).status,400,
    'returnable tools must use a named handover');
  const loan=await call(store,'POST','/materials/loans',{materialId:tool.body.id,projectId,quantity:2,
    takenBy:'Site Supervisor',handedOverBy:'Storekeeper',conditionOut:'Good'});
  assert.equal(loan.status,201);
  let inventory=await call(store,'GET','/materials/inventory');
  assert.equal(inventory.status,200);
  assert.equal(Number(inventory.body.materials.find(row=>Number(row.id)===Number(tool.body.id)).stock),3);
  assert.equal(Number(inventory.body.loans.find(row=>Number(row.id)===Number(loan.body.id)).outstanding),2);
  const usage=inventory.body.siteIssues.find(row=>Number(row.projectId)===Number(projectId)&&Number(row.materialId)===Number(material.body.id));
  assert.equal(usage.allowedQuantity,10);
  assert.equal(usage.quotedQuantity,10,'accepted quotation carries the BOQ material link and quantity');
  assert.equal(usage.quantity,12);
  assert.equal(usage.overrun,true);
  assert.equal(usage.quoteOverrun,true);
  assert.equal((await call(store,'POST','/materials/site-consumption',{
    materialId:material.body.id,projectId,quantity:5,consumedOn:today(),notes:'Waterproofing completed'})).status,201);
  assert.equal((await call(store,'POST','/materials/site-consumption',{
    materialId:material.body.id,projectId,quantity:8,consumedOn:today()})).status,409,
    'a site cannot consume more than its received and unconsumed balance');
  inventory=await call(store,'GET','/materials/inventory');
  assert.equal(Number(inventory.body.siteIssues.find(row=>Number(row.projectId)===Number(projectId)&&Number(row.materialId)===Number(material.body.id)).siteBalance),7);
  assert.equal((await call(store,'POST','/materials/site-counts',{
    materialId:material.body.id,projectId,countedQuantity:4,notes:'Physical site count'})).status,201);
  inventory=await call(store,'GET','/materials/inventory');
  let counted=inventory.body.siteIssues.find(row=>Number(row.projectId)===Number(projectId)&&Number(row.materialId)===Number(material.body.id));
  assert.equal(Number(counted.siteBalance),4);
  assert.equal(counted.balanceVerified,true);
  assert.equal((await call(store,'POST',`/materials/${material.body.id}/movements`,{
    type:'Issue',quantity:1,projectId,reference:'AFTER-COUNT'})).status,201);
  inventory=await call(store,'GET','/materials/inventory');
  counted=inventory.body.siteIssues.find(row=>Number(row.projectId)===Number(projectId)&&Number(row.materialId)===Number(material.body.id));
  assert.equal(Number(counted.siteBalance),5,'later movements carry forward from the confirmed physical count');
  assert.equal((await call(store,'POST',`/materials/loans/${loan.body.id}/returns`,{
    quantity:1,receivedBackBy:'Storekeeper',conditionIn:'Good'})).status,201);
  assert.equal((await call(store,'POST',`/materials/loans/${loan.body.id}/returns`,{
    quantity:2,receivedBackBy:'Storekeeper'})).status,409,'cannot return more than remains on site');
  assert.equal((await call(store,'POST',`/materials/loans/${loan.body.id}/returns`,{
    quantity:1,receivedBackBy:'Storekeeper'})).status,201);
  inventory=await call(store,'GET','/materials/inventory');
  assert.equal(Number(inventory.body.materials.find(row=>Number(row.id)===Number(tool.body.id)).stock),5);
  assert.equal(Number(inventory.body.loans.find(row=>Number(row.id)===Number(loan.body.id)).outstanding),0);
});

test('client directory links projects, quotations, invoices and payments without deleting history', async () => {
  const owner = await login();
  const name = `Client Profile ${Date.now()}`;
  const created = await call(owner, 'POST', '/clients', { type: 'Private', name,
    contactPerson: 'Client contact', phone: '0771234567', email: 'client@example.com',
    billingAddress: '1 Main Street', siteAddress: 'Site Road', city: 'Kandy', notes: 'Prefers email updates',
    tin: 'TIN-12345', vatNumber: 'VAT-98765' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clientId = created.body.id;
  assert.equal((await call(owner, 'POST', '/clients', { type: 'Private', name })).status, 409);
  const project = await call(owner, 'POST', '/projects', { companyId: 1, name: `Client-linked works ${Date.now()}`,
    clientId, manager: 'Project Manager', site: 'Site Road', stage: 'Planning', budget: 10000 });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  assert.equal(project.body.clientId, clientId);
  const boq = await call(owner, 'POST', '/boq', { projectId: project.body.id, title: 'Client-linked package',
    items: [{ category: 'Labour', description: 'Construction labour', unit: 'day', quantity: 2, rate: 1000 }] });
  assert.equal(boq.status, 201, JSON.stringify(boq.body));
  const quote = await call(owner, 'POST', '/qs/quotations', { boqId: boq.body.id, clientId,
    markupPercent: 0, vatPercent: 0 });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  assert.equal(quote.body.clientId, clientId);
  const quotationPage = await fetch(`${base}/qs/quotations/${quote.body.id}/document`, { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(quotationPage.status, 200);
  assert.match(await quotationPage.text(), /TIN-12345/);
  const quotationPdfResponse = await fetch(`${base}/qs/quotations/${quote.body.id}/document?download=pdf`, {
    headers: { authorization: `Bearer ${owner}` }
  });
  assert.equal(quotationPdfResponse.status, 200);
  assert.match(quotationPdfResponse.headers.get('content-type'), /^application\/pdf/);
  const quotationPdf = Buffer.from(await quotationPdfResponse.arrayBuffer());
  assert.equal(quotationPdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(quotationPdf.subarray(-1024).toString().includes('%%EOF'));
  const invoiceBody = { projectId: project.body.id, clientId, kind: 'Interim', title: 'Client-linked invoice',
    invoiceDate: today(), deliveryDate: today(), placeOfSupply: 'Project Site Road', paymentMode: 'Cheque',
    taxTreatment: 'Exempt', retentionPercent: 0, advanceRecovery: 0,
    otherDeductions: 0, items: [{ description: 'Construction labour', quantity: 2, rate: 1000 }] };
  const wrong = await call(owner, 'POST', '/receivables/invoices', { ...invoiceBody, clientId: clientId + 99999 });
  assert.equal(wrong.status, 400);
  const invoice = await call(owner, 'POST', '/receivables/invoices', invoiceBody);
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
  const invoicePage = await fetch(`${base}/receivables/invoices/${invoice.body.id}/document`, { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(invoicePage.status, 200);
  const invoiceHtml = await invoicePage.text();
  for (const detail of ['TIN-12345', 'VAT-98765', 'Project Site Road', 'Mode of payment: Cheque', 'Total amount in words']) {
    assert.ok(invoiceHtml.includes(detail), `${detail} should appear on the invoice`);
  }
  const pdfResponse = await fetch(`${base}/receivables/invoices/${invoice.body.id}/document?download=pdf`, {
    headers: { authorization: `Bearer ${owner}` }
  });
  assert.equal(pdfResponse.status, 200);
  const invoicePdf = Buffer.from(await pdfResponse.arrayBuffer());
  assert.equal(invoicePdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${invoice.body.id}/issue`)).status, 204);
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${invoice.body.id}/receipts`, {
    amount: 500, receivedDate: today(), method: 'Bank transfer', reference: `CLI-${Date.now()}`
  })).status, 201);
  let profile = await call(owner, 'GET', `/clients/${clientId}`);
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body.projects.length, 1);
  assert.equal(profile.body.quotations.length, 1);
  assert.equal(profile.body.invoices.length, 1);
  assert.equal(profile.body.payments.length, 1);
  assert.equal(profile.body.summary.received, 500);
  const renamed = await call(owner, 'PATCH', `/clients/${clientId}`, { name: `${name} Updated`, phone: '0777654321' });
  assert.equal(renamed.status, 200);
  assert.equal((await call(owner, 'GET', `/projects/${project.body.id}`)).body.client, `${name} Updated`);
  assert.equal((await call(owner, 'DELETE', `/clients/${clientId}`)).status, 409);
  assert.equal((await call(owner, 'PATCH', `/clients/${clientId}`, { active: false })).status, 200);
  assert.equal((await call(owner, 'GET', '/clients?archived=1')).body.some(row => row.id === clientId), true);
  profile = await call(owner, 'GET', `/clients/${clientId}`);
  assert.equal(profile.body.invoices.length, 1, 'archiving keeps commercial history');
});

test('Finance invoices support approved BOQ lines, standalone work and several capped payments', async () => {
  const owner = await login();
  const client = await call(owner, 'POST', '/clients', { type: 'Organisation', name: `Invoice Client ${Date.now()}`,
    tin: 'TIN-900', vatNumber: 'VAT-900', billingAddress: 'Kandy' });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const project = await call(owner, 'POST', '/projects', { companyId: 1,
    name: `Invoice Project ${Date.now()}`, clientId: client.body.id,
    manager: 'Project Manager', site: 'Kandy', stage: 'Planning', budget: 10000 });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const boq = await call(owner, 'POST', '/boq', { projectId: project.body.id, title: 'Measured work',
    items: [{ category: 'Labour', description: 'Measured labour', unit: 'day', quantity: 4, rate: 1000 }] });
  assert.equal(boq.status, 201, JSON.stringify(boq.body));
  assert.equal((await call(owner, 'PATCH', `/boq/${boq.body.id}`, { status: 'Approved' })).status, 200);
  const source = await call(owner, 'GET', `/receivables/boq-lines?projectId=${project.body.id}`);
  assert.equal(source.status, 200);
  const item = source.body.find(row => row.description === 'Measured labour');
  assert.ok(item);
  const taxInvoice = await call(owner, 'POST', '/receivables/invoices', {
    companyId: 1, projectId: project.body.id, clientId: client.body.id, kind: 'Interim',
    documentType: 'Tax Invoice', taxTreatment: 'Standard', vatRate: 18,
    title: 'Measured work to date', invoiceDate: today(), retentionPercent: 0,
    items: [{ boqItemId: item.id, description: item.description, unit: item.unit, quantity: 2, rate: 1 }]
  });
  assert.equal(taxInvoice.status, 201, JSON.stringify(taxInvoice.body));
  assert.equal(Number(taxInvoice.body.gross), 2000, 'BOQ rate comes from the approved record, not the browser');
  assert.equal(Number(taxInvoice.body.netPayable), 2360);
  const tooManyBoqUnits = await call(owner, 'POST', '/receivables/invoices', {
    companyId: 1, projectId: project.body.id, clientId: client.body.id, kind: 'Interim',
    documentType: 'Tax Invoice', taxTreatment: 'Standard', title: 'More work', invoiceDate: today(),
    items: [{ boqItemId: item.id, description: item.description, quantity: 3, rate: 1000 }]
  });
  assert.equal(tooManyBoqUnits.status, 409);
  const standard = await call(owner, 'POST', '/receivables/invoices', {
    companyId: 1, projectId: null, clientId: client.body.id, kind: 'Other',
    documentType: 'Invoice', taxTreatment: 'Exempt', title: 'Separate supply', invoiceDate: today(),
    items: [{ description: 'Non-project supply', quantity: 1, rate: 1000 }]
  });
  assert.equal(standard.status, 201, JSON.stringify(standard.body));
  assert.equal(Number(standard.body.netPayable), 1000);
  const noVatOnStandard = await call(owner, 'POST', '/receivables/invoices', {
    companyId: 1, projectId: null, clientId: client.body.id, kind: 'Other',
    documentType: 'Invoice', taxTreatment: 'Standard', title: 'Invalid tax choice', invoiceDate: today(),
    items: [{ description: 'Item', quantity: 1, rate: 100 }]
  });
  assert.equal(noVatOnStandard.status, 400);
  const standalonePage = await fetch(`${base}/receivables/invoices/${standard.body.id}/document`,
    { headers: { authorization: `Bearer ${owner}` } });
  assert.match(await standalonePage.text(), /Separate supply/);
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${standard.body.id}/issue`)).status, 204);
  const first = await call(owner, 'POST', `/receivables/invoices/${standard.body.id}/receipts`,
    { amount: 400, receivedDate: today(), method: 'Cash', reference: `PART-A-${Date.now()}` });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const overpay = await call(owner, 'POST', `/receivables/invoices/${standard.body.id}/receipts`,
    { amount: 601, receivedDate: today(), method: 'Cash', reference: `OVER-${Date.now()}` });
  assert.equal(overpay.status, 409);
  const second = await call(owner, 'POST', `/receivables/invoices/${standard.body.id}/receipts`,
    { amount: 600, receivedDate: today(), method: 'Bank transfer', reference: `PART-B-${Date.now()}` });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const detail = await call(owner, 'GET', `/receivables/invoices/${standard.body.id}`);
  assert.equal(detail.body.status, 'Paid');
  assert.equal(detail.body.receipts.length, 2);
  const listing = await call(owner, 'GET', '/receivables/invoices?companyId=1');
  assert.equal(listing.body.find(row => row.id === standard.body.id).project, 'No project');
  const profile = await call(owner, 'GET', `/clients/${client.body.id}`);
  assert.equal(profile.body.invoices.length, 2);
  assert.equal(profile.body.payments.length, 2);
  const reporting = await call(owner, 'GET', '/finance/reporting?companyId=1');
  assert.equal(reporting.status, 200);
  assert.equal(reporting.body.clientInvoices.find(row => row.id === standard.body.id).project, null);
  assert.equal(reporting.body.clientReceipts.filter(row => row.invoiceReference === standard.body.reference).length, 2);
  assert.equal(reporting.body.incomes.filter(row => row.description.includes(standard.body.reference)).length, 2);
});

test('QS creates a manual quotation without a BOQ and the server calculates every amount', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const client = await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Manual Quote Client ${Date.now()}`, contactPerson: 'Commercial Manager',
    phone: '077 123 4567', email: 'original-client@example.lk',
    billingAddress: 'Original client billing address', siteAddress: 'Original worksite'
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const project = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Manual quotation works ${Date.now()}`, clientId: client.body.id,
    manager: 'Project Manager', site: 'Colombo', stage: 'Pricing'
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const bank = await call(owner, 'POST', '/company-bank-accounts', {
    companyId: 1, label: 'Quotation account', bankName: 'Test Bank', branch: 'Colombo',
    accountName: 'GKUC Construction', accountNumber: `TEST-${Date.now()}`
  });
  assert.equal(bank.status, 201, JSON.stringify(bank.body));

  const noteTemplate = await call(qs, 'POST', '/qs/quotation-note-templates', {
    name: `Site preparation ${Date.now()}`, body: 'Client to provide site access'
  });
  assert.equal(noteTemplate.status, 201, JSON.stringify(noteTemplate.body));
  const editedNote = await call(qs, 'PATCH', `/qs/quotation-note-templates/${noteTemplate.body.id}`, {
    name: noteTemplate.body.name, body: 'Client to provide site access\nClear the working area'
  });
  assert.equal(editedNote.status, 200, JSON.stringify(editedNote.body));
  const savedNotes = await call(qs, 'GET', '/qs/quotation-note-templates');
  assert.equal(savedNotes.body.find(row => row.id === noteTemplate.body.id).body, editedNote.body.body);
  const visibility = {
    company: { logo: true, name: false, address: true, telephone: true, email: false,
      tin: true, vatNumber: true, svatNumber: true, bankDetails: true },
    client: { name: true, billingAddress: true, siteAddress: false, contactPerson: true,
      phone: true, alternatePhone: true, email: false, city: true, district: true,
      province: true, country: true, registrationNumber: true, tin: true, vatNumber: true, project: true }
  };
  const availableIdentity = await call(qs, 'GET',
    `/qs/quotation-identity?companyId=1&clientId=${client.body.id}`);
  assert.equal(availableIdentity.status, 200);
  assert.equal(availableIdentity.body.client.phone, '077 123 4567');

  const quotation = await call(qs, 'POST', '/qs/quotations/manual', {
    companyId: 1, clientId: client.body.id, projectId: project.body.id,
    title: 'Manually priced drainage works', quoteDate: today(), markupPercent: 10, vatPercent: 18,
    notes: `${editedNote.body.body}\nFree-form quotation test`, paymentTerms: '70% upfront\n30% on delivery',
    additionalNotes: 'Access must be available', bankAccountId: bank.body.id, visibility, lines: [
      { category: 'Labour', area: 'Drain line', description: 'Drain excavation',
        methodStatement: 'Set out the line\nExcavate to level', unit: 'm', quantity: 10, rate: 1250 },
      { category: 'Material', description: 'Concrete drain', unit: 'm', quantity: 10, rate: 2750 }
    ]
  });
  assert.equal(quotation.status, 201, JSON.stringify(quotation.body));
  assert.equal(quotation.body.boqId, null);
  assert.equal(Number(quotation.body.subtotal), 40000);
  assert.equal(Number(quotation.body.total), 51920);

  const detail = await call(qs, 'GET', `/qs/quotations/${quotation.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.items.length, 2);
  assert.equal(detail.body.bankAccountId, bank.body.id);
  assert.equal(detail.body.paymentTerms, '70% upfront\n30% on delivery');
  assert.equal(detail.body.items[0].area, 'Drain line');
  assert.equal(detail.body.presentation.show.company.name, false);
  assert.equal(detail.body.presentation.client.phone, '077 123 4567');
  assert.match(detail.body.items[0].methodStatement, /Excavate to level/);
  assert.deepEqual(detail.body.items.map(item => Number(item.amount)), [12500, 27500]);
  const updatedClient = await call(owner, 'PATCH', `/clients/${client.body.id}`, { phone: '077 999 9999' });
  assert.equal(updatedClient.status, 200, JSON.stringify(updatedClient.body));
  const document = await fetch(`${base}/qs/quotations/${quotation.body.id}/document`, {
    headers: { authorization: `Bearer ${qs}` }
  });
  const html = await document.text();
  assert.match(html, /<th class="ref">Area<\/th>/);
  assert.match(html, /Payment terms/);
  assert.match(html, /70% upfront/);
  assert.match(html, /Test Bank/);
  assert.match(html, /Excavate to level/);
  assert.match(html, /Client to provide site access/);
  assert.match(html, /Clear the working area/);
  assert.match(html, /Free-form quotation test/);
  assert.match(html, /077 123 4567/);
  assert.doesNotMatch(html, /077 999 9999/);
  assert.doesNotMatch(html, /original-client@example.lk/);
  assert.doesNotMatch(html, /Original worksite/);
  assert.doesNotMatch(html, /data-piece="companyName"/);
  const reworded = await call(qs, 'PATCH', `/qs/quotations/${quotation.body.id}`, {
    visibility: { ...visibility, client: { ...visibility.client, phone: false, email: true } }
  });
  assert.equal(reworded.status, 200, JSON.stringify(reworded.body));
  const revisedDocument = await fetch(`${base}/qs/quotations/${quotation.body.id}/document`, {
    headers: { authorization: `Bearer ${qs}` }
  });
  const revisedHtml = await revisedDocument.text();
  assert.match(revisedHtml, /original-client@example.lk/);
  assert.doesNotMatch(revisedHtml, /077 999 9999/);
  assert.equal((await call(qs, 'PATCH', `/qs/quotations/${quotation.body.id}`, { status: 'Accepted' })).status, 200);
  assert.equal((await call(qs, 'PATCH', `/qs/quotations/${quotation.body.id}`, { visibility })).status, 409);
  const acceptedProject = await call(owner, 'GET', `/projects/${project.body.id}`);
  assert.equal(Number(acceptedProject.body.budget), 51920);
});

test('quotation templates prefill traceable lines and project subcontractor amounts stay authoritative', async () => {
  const owner = await login();
  const suffix = Date.now();
  const client = await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Template Client ${suffix}`, contactPerson: 'Estimator'
  });
  const project = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Template Project ${suffix}`, clientId: client.body.id,
    manager: 'Project Manager', site: 'Nawinna', stage: 'Pricing'
  });
  const template = await call(owner, 'POST', '/qs/methods', {
    code: `T${String(suffix).slice(-8)}`, name: `Asphalt template ${suffix}`, category: 'Road works',
    description: 'Supply and lay asphalt', unit: 'sq.ft', defaultRate: 350,
    methodStatement: 'Clean the surface\nApply tack coat\nLay and compact asphalt'
  });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const edited = await call(owner, 'PATCH', `/qs/methods/${template.body.id}`, {
    code: `E${String(suffix).slice(-8)}`, name: `Edited asphalt template ${suffix}`,
    category: 'Surfacing', unit: 'm2', description: 'Edited standard description', defaultRate: 425,
    methodStatement: 'Prepare\nLay\nCompact'
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.name, `Edited asphalt template ${suffix}`);
  const methodQuote = await call(owner, 'POST', '/qs/quotations/from-methods', {
    companyId: 1, clientId: client.body.id, projectId: project.body.id,
    vatPercent: 0, visibility: {
      company: { logo: false, name: true, address: true, telephone: true, email: true,
        tin: true, vatNumber: true, svatNumber: true, bankDetails: false },
      client: { name: true, billingAddress: true, siteAddress: true, contactPerson: true,
        phone: true, alternatePhone: true, email: true, city: true, district: true,
        province: true, country: true, registrationNumber: true, tin: true, vatNumber: true, project: true }
    },
    lines: [{ methodId: template.body.id, quantity: 2, rate: 425 }]
  });
  assert.equal(methodQuote.status, 201, JSON.stringify(methodQuote.body));
  const methodDetail = await call(owner, 'GET', `/qs/quotations/${methodQuote.body.id}`);
  assert.equal(methodDetail.body.presentation.show.company.logo, false);
  assert.equal(methodDetail.body.presentation.client.project, project.body.name);

  const subcontractor = await call(owner, 'POST', '/qs/subcontractors', {
    name: `Subcontractor ${suffix}`, trade: 'Paving', contactType: 'Company'
  });
  assert.equal(subcontractor.status, 201, JSON.stringify(subcontractor.body));
  const subQuote = await call(owner, 'POST', '/qs/subcontract-quotations', {
    companyId: 1, subcontractorId: subcontractor.body.id, projectId: project.body.id,
    package: 'Kerb installation', quoteDate: today(), validityDays: 14,
    items: [{ description: 'Install precast kerbs', unit: 'm', quantity: 20, rate: 1000, discount: 0 }]
  });
  assert.equal(subQuote.status, 201, JSON.stringify(subQuote.body));

  const quotation = await call(owner, 'POST', '/qs/quotations/manual', {
    companyId: 1, clientId: client.body.id, projectId: project.body.id,
    title: 'Template and subcontract works', quoteDate: today(), markupPercent: 0, vatPercent: 0,
    lines: [
      { methodId: template.body.id, category: 'Surfacing', area: 'Driveway',
        description: 'Edited for this quotation', methodStatement: 'Site-specific method',
        unit: 'm2', quantity: 10, rate: 500 },
      { subQuotationId: subQuote.body.id, subcontractMarkupPercent: 15, category: 'Subcontract',
        area: 'Kerbs', description: 'Kerb installation by approved subcontractor', unit: 'sum',
        quantity: 99, rate: 1 }
    ]
  });
  assert.equal(quotation.status, 201, JSON.stringify(quotation.body));
  assert.equal(Number(quotation.body.subtotal), 28000);
  const detail = await call(owner, 'GET', `/qs/quotations/${quotation.body.id}`);
  assert.equal(detail.body.items[0].description, 'Edited for this quotation');
  assert.equal(Number(detail.body.items[1].rate), 23000);
  assert.equal(detail.body.items[1].sourceSubquoteId, subQuote.body.id);

  const wrongProject = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Wrong Project ${suffix}`, clientId: client.body.id,
    manager: 'Project Manager', site: 'Colombo', stage: 'Pricing'
  });
  const rejected = await call(owner, 'POST', '/qs/quotations/manual', {
    companyId: 1, clientId: client.body.id, projectId: wrongProject.body.id,
    title: 'Wrong subcontract source', lines: [{ subQuotationId: subQuote.body.id,
      category: 'Subcontract', description: 'Wrong project amount', unit: 'sum', quantity: 1, rate: 20000 }]
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /not linked to the selected project/i);
});

test('accepted Readymix quotation becomes term invoices, payment receipts and a project payment signal', async () => {
  const owner = await login();
  const client = await call(owner, 'POST', '/clients', { type: 'Organisation',
    name: `Term client ${Date.now()}`, tin: 'CLIENT-TIN-42', billingAddress: 'Client billing office', phone: '0770000042' });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  const project = await call(owner, 'POST', '/projects', { companyId: 2,
    name: `Readymix term project ${Date.now()}`, clientId: client.body.id,
    manager: 'Project Manager', site: 'Gampaha', stage: 'Planning', budget: 0 });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const boq = await call(owner, 'POST', '/boq', { projectId: project.body.id, title: 'Readymix supply',
    items: [{ category: 'Material', description: 'Ready mix concrete', unit: 'm3', quantity: 10, rate: 10000 }] });
  assert.equal(boq.status, 201, JSON.stringify(boq.body));
  const visibility = {
    company: Object.fromEntries(['logo', 'name', 'address', 'telephone', 'email', 'tin',
      'vatNumber', 'svatNumber', 'bankDetails'].map(key => [key, key !== 'telephone'])),
    client: Object.fromEntries(['name', 'billingAddress', 'siteAddress', 'contactPerson', 'phone',
      'alternatePhone', 'email', 'city', 'district', 'province', 'country', 'registrationNumber',
      'tin', 'vatNumber', 'project'].map(key => [key, key !== 'tin']))
  };
  const quote = await call(owner, 'POST', '/qs/quotations', { boqId: boq.body.id, clientId: client.body.id,
    markupPercent: 0, vatPercent: 18, visibility });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const quotedPdf = await fetch(`${base}/qs/quotations/${quote.body.id}/document`,
    { headers: { authorization: `Bearer ${owner}` } });
  const quoteHtml = await quotedPdf.text();
  assert.match(quoteHtml, /GKUC Readymix/);
  assert.doesNotMatch(quoteHtml, /CLIENT-TIN-42/);
  assert.match(quoteHtml, /Client billing office/);
  assert.equal((await call(owner, 'PATCH', `/qs/quotations/${quote.body.id}`, { status: 'Accepted' })).status, 200);
  const invalid = await call(owner, 'POST', '/receivables/quotation-plans', { quotationId: quote.body.id,
    documentType: 'Tax Invoice', taxTreatment: 'Standard', vatRate: 18,
    terms: [{ label: 'Deposit', percentage: 20 }] });
  assert.equal(invalid.status, 400);
  const plan = await call(owner, 'POST', '/receivables/quotation-plans', { quotationId: quote.body.id,
    documentType: 'Tax Invoice', taxTreatment: 'Standard', vatRate: 18,
    terms: [20, 30, 25, 25].map((percentage, index) => ({ label: `Term ${index + 1}`, percentage })) });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await call(owner, 'POST', '/receivables/quotation-plans', { quotationId: quote.body.id,
    documentType: 'Tax Invoice', taxTreatment: 'Standard', vatRate: 18,
    terms: [{ label: 'Again', percentage: 100 }] })).status, 409);
  const plans = (await call(owner, 'GET', '/receivables/quotation-plans?companyId=2')).body;
  const saved = plans.find(row => row.id === plan.body.id);
  assert.deepEqual(saved.terms.map(term => Number(term.amount)), [23600, 35400, 29500, 29500]);
  const first = await call(owner, 'POST', `/receivables/quotation-terms/${saved.terms[0].id}/invoice`,
    { invoiceDate: today(), deliveryDate: today(), paymentMode: 'Bank transfer' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(Number(first.body.netPayable), 23600);
  assert.equal((await call(owner, 'POST', `/receivables/quotation-terms/${saved.terms[0].id}/invoice`,
    { invoiceDate: today() })).status, 409);
  const invoice = (await call(owner, 'GET', `/receivables/invoices/${first.body.id}`)).body;
  assert.equal(Number(invoice.company_id), 2);
  assert.equal(invoice.document_type, 'Tax Invoice');
  assert.equal(invoice.buyer_tin, 'CLIENT-TIN-42');
  const rendered = await fetch(`${base}/receivables/invoices/${first.body.id}/document`,
    { headers: { authorization: `Bearer ${owner}` } });
  const html = await rendered.text();
  assert.match(html, /GKUC Readymix/);
  assert.match(html, /CLIENT-TIN-42/);
  const invoiceDownload = await fetch(`${base}/receivables/invoices/${first.body.id}/document?download=pdf`,
    { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(invoiceDownload.status, 200);
  assert.match(invoiceDownload.headers.get('content-type') || '', /application\/pdf/);
  assert.equal(Buffer.from(await invoiceDownload.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${first.body.id}/issue`)).status, 204);
  const payment = await call(owner, 'POST', `/receivables/invoices/${first.body.id}/receipts`,
    { amount: 10000, receivedDate: today(), method: 'Bank transfer', reference: `TEST-${Date.now()}` });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  assert.ok(payment.body.receiptId);
  const receipt = await fetch(`${base}/receivables/receipts/${payment.body.receiptId}/document`,
    { headers: { authorization: `Bearer ${owner}` } });
  assert.match(await receipt.text(), /Payment Receipt/);
  const receiptDownload = await fetch(`${base}/receivables/receipts/${payment.body.receiptId}/document?download=pdf`,
    { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(receiptDownload.status, 200);
  assert.match(receiptDownload.headers.get('content-type') || '', /application\/pdf/);
  assert.equal(Buffer.from(await receiptDownload.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call(owner, 'GET', `/receivables/invoices/${first.body.id}`)).body.status, 'Part paid');
  const alerts = (await call(owner, 'GET', '/bootstrap')).body.data.notifications;
  assert.ok(alerts.some(row => String(row.title).includes('Client payment received')));
});

test('project managers and task assignees remain linked to employee work histories', async () => {
  const owner = await login();
  const bootstrap = (await call(owner, 'GET', '/bootstrap')).body.data;
  const [first, second] = bootstrap.employees.filter(employee => employee.status === 'Active');
  const clientId = (await call(owner, 'GET', '/clients')).body[0].id;
  const project = await call(owner, 'POST', '/projects', { companyId: 1,
    name: `Managed site ${Date.now()}`, clientId, managerEmployeeId: first.id,
    site: 'Test site', stage: 'Planning', budget: 10000 });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  assert.equal(project.body.managerEmployeeId, first.id);
  assert.equal(project.body.manager, first.name);
  const task = await call(owner, 'POST', '/tasks', { title: 'Inspect new project site', projectId: project.body.id,
    assigneeEmployeeId: first.id, due: 'Tomorrow', dueDate: shift(1), priority: 'Medium', notes: 'Document findings' });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  assert.equal(task.body.assigneeEmployeeId, first.id);
  let profile = (await call(owner, 'GET', `/employees/${first.id}`)).body;
  const assignment = profile.projects.find(row => row.projectId === project.body.id);
  assert.equal(assignment.projectRole, 'Project manager');
  assert.equal(assignment.tasks, 1);
  assert.equal(profile.tasks.some(row => row.id === task.body.id), true);
  assert.equal((await call(owner, 'GET', `/projects/${project.body.id}`)).body.team.some(row => row.projectRole === 'Project manager'), true);
  const reassigned = await call(owner, 'PATCH', `/projects/${project.body.id}`, { managerEmployeeId: second.id });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
  profile = (await call(owner, 'GET', `/employees/${second.id}`)).body;
  assert.equal(profile.projects.some(row => row.projectId === project.body.id && row.projectRole === 'Project manager'), true);
  const former = (await call(owner, 'GET', `/employees/${first.id}`)).body.projects.find(row => row.projectId === project.body.id);
  assert.equal(former.projectRole, 'Project manager');
  assert.ok(former.releasedAt, 'the former manager keeps a dated history');
});

test('several project members are assigned together and appear on the project', async () => {
  const owner = await login();
  const employees = (await call(owner, 'GET', '/bootstrap')).body.data.employees.filter(employee => employee.status === 'Active');
  const clientId = (await call(owner, 'GET', '/clients')).body[0].id;
  const project = await call(owner, 'POST', '/projects', { companyId: 1,
    name: `Team assignment ${Date.now()}`, clientId, managerEmployeeId: employees[0].id,
    site: 'Test site', stage: 'Planning', budget: 10000 });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const ids = employees.slice(1, 4).map(employee => employee.id);
  const assigned = await call(owner, 'POST', `/projects/${project.body.id}/team/bulk`,
    { members: ids.map((employeeId, index) => ({ employeeId, projectRole: index === 0 ? 'Foreman' : 'Site team' })) });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  assert.equal(assigned.body.assigned, 3);
  const detail = await call(owner, 'GET', `/projects/${project.body.id}`);
  assert.deepEqual(ids.sort(), detail.body.team.filter(member => ['Site team', 'Foreman'].includes(member.projectRole))
    .map(member => member.employeeId).sort());
  assert.equal(detail.body.team.some(member => Number(member.employeeId) === Number(ids[0]) && member.projectRole === 'Foreman'), true);
  const repeated = await call(owner, 'POST', `/projects/${project.body.id}/team/bulk`,
    { members: [ids[0], employees[4].id].map(employeeId => ({ employeeId, projectRole: 'Site team' })) });
  assert.equal(repeated.status, 409);
  const after = await call(owner, 'GET', `/projects/${project.body.id}`);
  assert.equal(after.body.team.some(member => Number(member.employeeId) === Number(employees[4].id)), false,
    'a failed group request does not partly assign members');
});

test('one task can be assigned to several employees and reassigned without duplication', async () => {
  const owner = await login();
  const data = (await call(owner, 'GET', '/bootstrap')).body.data;
  const people = data.employees.filter(employee => employee.status === 'Active').slice(0, 3);
  assert.equal(people.length, 3);
  const projectId = data.projects[0].id;
  const body = { projectId, title: `Joint site inspection ${Date.now()}`, assigneeEmployeeIds: people.slice(0, 2).map(person => person.id),
    due: 'Tomorrow', dueDate: shift(1), priority: 'Medium', notes: '' };
  const created = await call(owner, 'POST', '/tasks', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.deepEqual(created.body.assigneeEmployeeIds, body.assigneeEmployeeIds);
  assert.equal((await call(owner, 'GET', `/projects/${projectId}`)).body.tasks.find(task => task.id === id).assignees.length, 2);
  assert.equal((await call(owner, 'GET', '/bootstrap')).body.data.tasks.find(task => task.id === id).assignees.length, 2);
  for (const person of people.slice(0, 2)) {
    assert.equal((await call(owner, 'GET', `/employees/${person.id}`)).body.tasks.some(task => task.id === id), true);
  }
  const changed = await call(owner, 'PATCH', `/tasks/${id}`, { assigneeEmployeeIds: [people[1].id, people[2].id] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.assigneeEmployeeIds, [people[1].id, people[2].id]);
  assert.equal((await call(owner, 'GET', `/employees/${people[0].id}`)).body.tasks.some(task => task.id === id), false);
  assert.equal((await call(owner, 'GET', `/employees/${people[2].id}`)).body.tasks.some(task => task.id === id), true);
  assert.equal((await call(owner, 'GET', '/tasks')).body.filter(task => task.id === id).length, 1);
  assert.equal((await call(owner, 'POST', '/tasks', { ...body, assigneeEmployeeIds: [people[0].id, people[0].id] })).status, 400);
  assert.equal((await call(owner, 'PATCH', `/tasks/${id}`, { assigneeEmployeeIds: [people[1].id, 999999999] })).status, 400);
  assert.deepEqual((await call(owner, 'GET', `/tasks/${id}`)).body.assigneeEmployeeIds, [people[1].id, people[2].id]);
});

test('a new project belongs to the selected operating company', async () => {
  const owner = await login();
  const data = (await call(owner, 'GET', '/bootstrap')).body.data;
  const manager = data.employees.find(employee => employee.status === 'Active');
  const client = (await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Reminder Client ${Date.now()}`
  })).body;
  const created = await call(owner, 'POST', '/projects', {
    companyId: 2, name: `Readymix site ${Date.now()}`, clientId: client.id,
    managerEmployeeId: manager.id, site: 'Readymix yard', stage: 'Planning', budget: 0
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.companyId, 2);
  assert.equal(created.body.company, 'GKUC Readymix');
  assert.equal((await call(owner, 'GET', '/projects?companyId=2')).body.some(project => project.id === created.body.id), true);
  assert.equal((await call(owner, 'GET', '/projects?companyId=1')).body.some(project => project.id === created.body.id), false);
  assert.equal((await call(owner, 'POST', '/projects', {
    companyId: 999, name: 'Invalid company project', clientId: client.id,
    managerEmployeeId: manager.id, site: 'Nowhere', stage: 'Planning', budget: 0
  })).status, 400);
});

test('not-started projects notify every selected user on the configured schedule', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const data = (await call(owner, 'GET', '/bootstrap')).body.data;
  const manager = data.employees.find(employee => employee.status === 'Active');
  const client = (await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Reminder Schedule Client ${Date.now()}`
  })).body;
  const users = (await call(owner, 'GET', '/projects/reminder-users')).body;
  const ownerUser = users.find(user => user.email === 'owner@gkuc.lk');
  const qsUser = users.find(user => user.email === 'qs@gkuc.lk');
  assert.ok(ownerUser && qsUser);

  const created = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Scheduled project ${Date.now()}`, clientId: client.id,
    managerEmployeeId: manager.id, site: 'Reminder site', stage: 'Not started', budget: 0,
    reminderDate: today(), reminderFrequency: 'Weekly', reminderUserIds: [ownerUser.id, qsUser.id]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call(owner, 'POST', '/notifications/scan')).status, 200);
  const ownerAlerts = (await call(owner, 'GET', '/notifications')).body;
  const qsAlerts = (await call(qs, 'GET', '/notifications')).body;
  assert.ok(ownerAlerts.some(row => row.referenceType === 'project' && Number(row.referenceId) === created.body.id));
  assert.ok(qsAlerts.some(row => row.referenceType === 'project' && Number(row.referenceId) === created.body.id));

  const before = ownerAlerts.filter(row => row.referenceType === 'project' && Number(row.referenceId) === created.body.id).length;
  await call(owner, 'POST', '/notifications/scan');
  const after = (await call(owner, 'GET', '/notifications')).body
    .filter(row => row.referenceType === 'project' && Number(row.referenceId) === created.body.id).length;
  assert.equal(after, before);

  const invalid = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Missing reminder people ${Date.now()}`, clientId: client.id,
    managerEmployeeId: manager.id, site: 'Reminder site', stage: 'Not started', budget: 0,
    reminderDate: today(), reminderFrequency: 'Daily', reminderUserIds: []
  });
  assert.equal(invalid.status, 400);
});

test('approving a BOQ and its variation sets the project budget', async () => {
  const qs = await login('qs@gkuc.lk');
  const owner = await login();

  const boq = await call(qs, 'POST', '/boq', {
    projectId: 2,
    title: 'Warehouse cladding package',
    items: [{ category: 'Material', description: 'Roof sheets', unit: 'm2', quantity: 1000, rate: 2000 }]
  });
  assert.equal(boq.status, 201);
  assert.equal(Number(boq.body.total), 2000000);

  assert.equal((await call(qs, 'PATCH', `/boq/${boq.body.id}`, { status: 'Approved' })).status, 403, 'estimators prepare, management approves');
  assert.equal((await call(owner, 'PATCH', `/boq/${boq.body.id}`, { status: 'Approved' })).status, 200);

  let project = (await call(owner, 'GET', '/projects/2')).body;
  assert.equal(Number(project.budget), 2000000);

  const variation = await call(qs, 'POST', `/boq/${boq.body.id}/variations`, { description: 'Extra insulation', amount: 500000 });
  await call(owner, 'PATCH', `/boq/variations/${variation.body.id}`, { status: 'Approved' });

  project = (await call(owner, 'GET', '/projects/2')).body;
  assert.equal(Number(project.budget), 2500000, 'an approved variation moves the approved budget');
});

test('QS tracks daily actual costs, item overruns, forecasts and unexpected expenses', async () => {
  const qs = await login('qs@gkuc.lk');
  const owner = await login();
  let control = await call(qs, 'GET', '/boq/cost-control?projectId=2');
  assert.equal(control.status, 200);
  assert.equal(Number(control.body.summary.baseline), 2000000);
  assert.equal(Number(control.body.summary.currentBudget), 2500000);
  const item = control.body.items.find(row => row.description === 'Roof sheets');
  assert.ok(item);
  const options = await call(qs,'GET','/boq/cost-control/options?projectId=2');
  assert.equal(options.status,200);
  const taskId = options.body.tasks[0]?.id;
  assert.ok(taskId,'project work must be selected from Tasks');
  const submitted = await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:2,workDate:today(),lines:[
      {taskId,boqItemId:item.id,source:'Material',costType:'Expected',description:'Roof sheets installed to date',
        quantity:1000,unit:'m2',unitRate:2100,amount:2100000,reference:'SITE-COST-01'},
      {taskId,source:'Other',costType:'Unexpected',description:'Unplanned dewatering operation',amount:75000}
    ]
  });
  assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  control = await call(owner,'GET','/boq/cost-control?projectId=2');
  assert.equal(control.body.items.find(row=>row.id===item.id).actualAmount,0,'unreviewed costs are not posted');
  assert.equal((await call(qs,'POST',`/boq/cost-control/daily-sheets/${submitted.body.id}/review`,{decision:'Approved'})).status,403);
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${submitted.body.id}/review`,{decision:'Approved'})).status,200);
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${submitted.body.id}/review`,{decision:'Approved'})).status,409);

  const forecast = await call(qs, 'PATCH', `/boq/cost-control/items/${item.id}/forecast`, {
    projectId: 2, forecastQuantity: 1050, forecastRate: 2100, forecastAmount: 2205000,
    reason: 'Final measured area and supplier rate both increased'
  });
  assert.equal(forecast.status, 200);

  control = await call(owner, 'GET', '/boq/cost-control?projectId=2');
  const changed = control.body.items.find(row => row.id === item.id);
  assert.equal(Number(changed.actualAmount), 2100000);
  assert.equal(Number(changed.variance), 100000);
  assert.equal(Number(changed.finalForecast), 2205000);
  assert.equal(Number(control.body.summary.unexpected), 75000);
  assert.ok(control.body.daily.length >= 1);
});

test('Finance and QS share one cost ledger and reject repeated manual entries', async () => {
  const owner = await login();
  assert.equal((await call(owner, 'POST', '/options/expense.source', { value: 'Audit site security' })).status, 201);
  const entry = { projectId: 1, source: 'Other', description: 'Reconciliation test site hire',
    amount: 3217, expenseDate: today(), reference: `AUDIT-COST-${Date.now()}` };
  assert.equal((await call(owner, 'POST', '/finance/expenses', entry)).status, 201);
  assert.equal((await call(owner, 'POST', '/finance/expenses', entry)).status, 409);
  assert.equal((await call(owner, 'POST', '/boq/cost-control/expenses', entry)).status, 410,'direct posting is closed');
  const options = await call(owner,'GET','/boq/cost-control/options?projectId=1');
  const taskId=options.body.tasks[0]?.id;
  assert.ok(taskId);
  const qsEntry = { ...entry, reference: `AUDIT-QS-${Date.now()}` };
  const sheet=await call(owner,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate:today(),lines:[{taskId,source:'Other',description:qsEntry.description,
      amount:qsEntry.amount,reference:qsEntry.reference}]
  });
  assert.equal(sheet.status,201,JSON.stringify(sheet.body));
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${sheet.body.id}/review`,{decision:'Approved'})).status,200);
  assert.equal((await call(owner, 'POST', '/finance/expenses', qsEntry)).status, 409);
  assert.equal((await call(owner, 'POST', '/finance/expenses', {
    ...entry, source: 'Audit site security', reference: `AUDIT-CUSTOM-${Date.now()}`
  })).status, 201);
});

test('Finance review links station fuel once and charges reserve fuel to stock, not petty cash', async () => {
  const owner=await login();
  const qs=await login('qs@gkuc.lk');
  const options=(await call(qs,'GET','/boq/cost-control/options?projectId=1')).body;
  const taskId=options.tasks[0]?.id;
  assert.ok(taskId);
  const opened=await call(owner,'POST','/receivables/petty-cash',{
    name:`Daily cost fuel ${Date.now()}`,accountType:'Fuel',holderName:'Test transport',projectId:1,
    ceiling:5000,lowAt:500
  });
  assert.equal(opened.status,201);
  const floatId=opened.body.id;
  assert.equal((await call(owner,'POST',`/receivables/petty-cash/${floatId}/entries`,{
    kind:'Top up',amount:5000,entryDate:today(),description:'Daily cost test float'
  })).status,201);
  const vehicle=await call(owner,'POST','/fleet',{
    vehicle:'Daily-cost test tipper',registration:`DAILY-${Date.now()}`,status:'Available',
    renewal:'Insurance',dueDate:today(),projectId:1,odometer:100
  });
  assert.equal(vehicle.status,201);
  const fuel=await call(owner,'POST',`/fleet/${vehicle.body.id}/fuel`,{
    fuelFloatId:floatId,projectId:1,fuelDate:today(),litres:10,cost:1000,odometer:110
  });
  assert.equal(fuel.status,201);
  const expensesBefore=(await call(owner,'GET','/finance/expenses?projectId=1')).body;
  const station=await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate:today(),lines:[{taskId,source:'Fuel',costType:'Expected',
      description:'Tipper diesel from station',amount:1000,quantity:10,unit:'litres',
      vehicleId:vehicle.body.id,fuelOrigin:'Station',fuelRecordId:fuel.body.id}]
  });
  assert.equal(station.status,201,JSON.stringify(station.body));
  const stationReview=await call(owner,'POST',`/boq/cost-control/daily-sheets/${station.body.id}/review`,{decision:'Approved'});
  assert.equal(stationReview.status,200,`${JSON.stringify(stationReview.body)} ${serverOutput.slice(-2000)}`);
  const expensesAfter=(await call(owner,'GET','/finance/expenses?projectId=1')).body;
  assert.equal(expensesAfter.length,expensesBefore.length,'review links Fleet expense without creating another one');
  const balance=Number((await call(owner,'GET','/receivables/petty-cash?companyId=1')).body.find(row=>row.id===floatId).balance);
  assert.equal(balance,4000,'review never charges the fuel float again');
  const newStation=await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate:today(),lines:[{taskId,source:'Fuel',costType:'Expected',
      description:'New tipper diesel purchase',amount:500,quantity:5,unit:'litres',
      vehicleId:vehicle.body.id,fuelOrigin:'Station',fuelFloatId:floatId,odometer:120}]
  });
  assert.equal(newStation.status,201,JSON.stringify(newStation.body));
  assert.equal(Number((await call(owner,'GET','/receivables/petty-cash?companyId=1')).body.find(row=>row.id===floatId).balance),4000,
    'QS submission does not spend petty cash before Finance approves');
  const newStationReview=await call(owner,'POST',`/boq/cost-control/daily-sheets/${newStation.body.id}/review`,{decision:'Approved'});
  assert.equal(newStationReview.status,200,JSON.stringify(newStationReview.body));
  assert.equal(Number((await call(owner,'GET','/receivables/petty-cash?companyId=1')).body.find(row=>row.id===floatId).balance),3500,
    'Finance approval posts the new station purchase once');
  const newFuelExpenses=(await call(owner,'GET','/finance/expenses?projectId=1')).body;
  assert.equal(newFuelExpenses.filter(row=>row.originType==='fuel_record'&&row.description==='New tipper diesel purchase').length,1);
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${newStation.body.id}/review`,{decision:'Approved'})).status,409);
  const material=await call(owner,'POST','/materials',{
    name:`Reserve diesel ${Date.now()}`,unit:'litres',stock:30,minimum:0,site:'Central store',unitCost:100,
    stockKind:'Consumable'
  });
  assert.equal(material.status,201,JSON.stringify(material.body));
  const reserve=await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate:today(),lines:[{taskId,source:'Fuel',costType:'Unexpected',
      description:'Unexpected reserve diesel usage',amount:1000,quantity:10,unit:'litres',unitRate:100,
      vehicleId:vehicle.body.id,fuelOrigin:'Reserve',reserveMaterialId:material.body.id}]
  });
  assert.equal(reserve.status,201,JSON.stringify(reserve.body));
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${reserve.body.id}/review`,{decision:'Approved'})).status,200);
  const stocked=(await call(owner,'GET','/materials')).body.find(row=>row.id===material.body.id);
  assert.equal(Number(stocked.stock),20);
  const newExpenses=(await call(owner,'GET','/finance/expenses?projectId=1')).body;
  assert.equal(newExpenses.filter(row=>row.originType==='daily_cost_line'&&row.description==='Unexpected reserve diesel usage').length,1);
  assert.equal(Number((await call(owner,'GET','/receivables/petty-cash?companyId=1')).body.find(row=>row.id===floatId).balance),3500);
});

test('returned manpower costs can be corrected, but a day salary cannot be charged twice',async()=>{
  const owner=await login(),qs=await login('qs@gkuc.lk');
  const options=(await call(qs,'GET','/boq/cost-control/options?projectId=1')).body;
  const worker=options.employees.find(employee=>Number(employee.dailyRate)>0);
  assert.ok(worker,'the test needs a labourer with a configured daily rate');
  const taskId=options.tasks[0]?.id;
  const payload={projectId:1,workDate:shift(-2),lines:[{taskId,source:'Labour',
    description:`${worker.name} day salary`,employeeId:worker.id,amount:Number(worker.dailyRate),
    quantity:1,unit:'day',unitRate:Number(worker.dailyRate)}]};
  const first=await call(qs,'POST','/boq/cost-control/daily-sheets',payload);
  assert.equal(first.status,201,JSON.stringify(first.body));
  const returned=await call(owner,'POST',`/boq/cost-control/daily-sheets/${first.body.id}/review`,{
    decision:'Returned',note:'Confirm the employee worked on this task.'
  });
  assert.equal(returned.status,200,JSON.stringify(returned.body));
  const corrected=await call(qs,'POST','/boq/cost-control/daily-sheets',payload);
  assert.equal(corrected.status,201,JSON.stringify(corrected.body));
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${corrected.body.id}/review`,{
    decision:'Approved'
  })).status,200);
  const duplicate=await call(qs,'POST','/boq/cost-control/daily-sheets',payload);
  assert.equal(duplicate.status,409);
  assert.match(duplicate.body.error,/already has a day-salary/);
  const costs=(await call(owner,'GET','/finance/expenses?projectId=1')).body.filter(row=>
    row.originType==='daily_cost_line'&&row.description===payload.lines[0].description);
  assert.equal(costs.length,1);
});

test('cheque payments use dedicated clearing workflows and manual income is deduplicated', async () => {
  const owner = await login();
  const income = { projectId: 1, description: 'Reconciliation test receipt', amount: 4273,
    receivedDate: today(), method: 'Bank transfer', reference: `AUDIT-INCOME-${Date.now()}` };
  assert.equal((await call(owner, 'POST', '/finance/income', income)).status, 201);
  assert.equal((await call(owner, 'POST', '/finance/income', income)).status, 409);
  assert.equal((await call(owner, 'POST', '/finance/income', { ...income, method: 'Cheque' })).status, 400);
});

test('a concurrent bill payment posts one expense and counts once in the summary', async () => {
  const owner = await login();
  const before = (await call(owner, 'GET', '/finance/summary?companyId=1')).body;
  const billReference = `AUDIT-BILL-${Date.now()}`;
  const bill = await call(owner, 'POST', '/finance/bills', { companyId: 1, projectId: 1,
    billType: 'Water', provider: 'Reconciliation test utility', reference: billReference,
    billDate: today(), dueDate: shift(5), netAmount: 1789, taxTreatment: 'Exempt', vatRate: 0 });
  assert.equal(bill.status, 201);
  const results = await Promise.all([1, 2].map(() => call(owner, 'POST', `/finance/bills/${bill.body.id}/pay`,
    { paidDate: today(), method: 'Bank transfer' })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const afterSummary = (await call(owner, 'GET', '/finance/summary?companyId=1')).body;
  assert.equal(Math.round(afterSummary.totals.expenses - before.totals.expenses), 1789);
  const rows = (await call(owner, 'GET', '/finance/expenses?projectId=1')).body;
  assert.equal(rows.filter(row => row.originType === 'operating_bill' && row.reference === billReference).length, 1);
});

test('invoice receipts cannot post twice and preserve the actual payment method', async () => {
  const owner = await login();
  const invoice = await call(owner, 'POST', '/receivables/invoices', {
    projectId: 1, kind: 'Interim', title: 'Reconciliation test certificate',
    invoiceDate: today(), dueDate: shift(14), taxTreatment: 'Exempt', retentionPercent: 0,
    advanceRecovery: 0, otherDeductions: 0,
    items: [{ description: 'Test work', unit: 'item', quantity: 1, rate: 6000 }]
  });
  assert.equal(invoice.status, 201);
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${invoice.body.id}/issue`)).status, 204);
  const payment = { amount: 6000, receivedDate: today(), method: 'Cash', reference: `AUDIT-RCPT-${Date.now()}` };
  assert.equal((await call(owner, 'POST', `/receivables/invoices/${invoice.body.id}/receipts`,
    { ...payment, method: 'Cheque' })).status, 400);
  const results = await Promise.all([1, 2].map(() => call(owner, 'POST',
    `/receivables/invoices/${invoice.body.id}/receipts`, payment)));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const income = (await call(owner, 'GET', '/finance/income?projectId=1')).body;
  const posted = income.filter(row => row.reference === payment.reference);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].method, 'Cash');
});

test('concurrent petty-cash spends cannot overdraw the float or duplicate project cost', async () => {
  const owner = await login();
  const opened = await call(owner, 'POST', '/receivables/petty-cash', {
    name: `Audit float ${Date.now()}`, accountType: 'Office expenses', holderName: 'Finance desk', projectId: 1,
    ceiling: 2000, lowAt: 500
  });
  assert.equal(opened.status, 201);
  const path = `/receivables/petty-cash/${opened.body.id}/entries`;
  assert.equal((await call(owner, 'POST', path, { kind: 'Top up', amount: 2000, entryDate: today(),
    description: 'Opening float' })).status, 201);
  const spend = { kind: 'Spend', amount: 1500, entryDate: today(), description: `Audit fuel ${Date.now()}` };
  const results = await Promise.all([1, 2].map(() => call(owner, 'POST', path, spend)));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
  const entries = (await call(owner, 'GET', path)).body;
  assert.equal(entries.filter(row => row.kind === 'Spend' && row.description === spend.description).length, 1);
  const expense = (await call(owner, 'GET', '/finance/expenses?projectId=1')).body
    .filter(row => row.description === `Petty cash — ${spend.description}`);
  assert.equal(expense.length, 1);
  assert.equal(expense[0].originType, 'petty_cash');
});

test('equipment cannot be assigned twice without a return', async () => {
  const owner = await login();
  assert.equal((await call(owner, 'POST', '/equipment/3/assign', { projectId: 1, assignedTo: 'Tharushi Wickrama', assignedAt: today() })).status, 201);
  assert.equal((await call(owner, 'POST', '/equipment/3/assign', { projectId: 2, assignedTo: 'M. Rizwan', assignedAt: today() })).status, 409);
  assert.equal((await call(owner, 'POST', '/equipment/3/return', { returnedAt: today(), status: 'Available' })).status, 200);
});

test('supplier payments cannot exceed the invoice', async () => {
  const finance = await login('finance@gkuc.lk');
  const invoice = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 2, invoiceNo: 'INV-TEST-1', amount: 100000, invoiceDate: today(), dueDate: shift(14)
  });
  assert.equal(invoice.status, 201);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${invoice.body.id}/payments`, { amount: 150000, paidDate: today() })).status, 409);
  const paid = await call(finance, 'POST', `/purchasing/invoices/${invoice.body.id}/payments`, { amount: 100000, paidDate: today() });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.status, 'Paid');
});

test('operating bills, VAT, credit cards and bond extensions reconcile end to end', async () => {
  const finance = await login('finance@gkuc.lk');
  const owner = await login();
  const vatBefore = (await call(finance, 'GET', '/finance/vat?companyId=1')).body;

  const projectBill = await call(finance, 'POST', '/finance/bills', {
    companyId: 1, projectId: 1, billType: 'Electricity', provider: 'CEB Test Account',
    reference: `CEB-${Date.now()}`, billDate: today(), dueDate: shift(5),
    netAmount: 10000, taxTreatment: 'Standard', vatRate: 18, reminderDays: 5
  });
  assert.equal(projectBill.status, 201);
  assert.equal(Number(projectBill.body.vatAmount), 1800);
  assert.equal(Number(projectBill.body.totalAmount), 11800);
  assert.equal((await call(finance, 'POST', `/finance/bills/${projectBill.body.id}/pay`, {
    paidDate: today(), method: 'Bank transfer', reference: 'CEB-PAID-TEST'
  })).status, 201);
  assert.equal((await call(finance, 'POST', `/finance/bills/${projectBill.body.id}/pay`, {
    paidDate: today(), method: 'Cash'
  })).status, 409, 'a bill cannot be paid twice');
  const expenses = (await call(finance, 'GET', '/finance/expenses?projectId=1')).body;
  assert.ok(expenses.some(row => row.originType === 'operating_bill' && Number(row.amount) === 11800),
    'paying a site bill posts its project expense once');

  const reminderBill = await call(finance, 'POST', '/finance/bills', {
    companyId: 1, billType: 'Water', provider: 'NWSDB Test Account',
    reference: `WATER-${Date.now()}`, billDate: today(), dueDate: shift(3),
    netAmount: 4500, taxTreatment: 'Exempt', vatRate: 18, reminderDays: 4
  });
  assert.equal(reminderBill.status, 201);

  const supplierInvoice = await call(finance, 'POST', '/purchasing/invoices', {
    companyId: 1, supplierId: 1, invoiceNo: `VAT-SUP-${Date.now()}`,
    netAmount: 100000, taxTreatment: 'Standard', vatRate: 18,
    invoiceDate: today(), dueDate: shift(10)
  });
  assert.equal(supplierInvoice.status, 201);
  assert.equal(Number(supplierInvoice.body.amount), 118000);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${supplierInvoice.body.id}/payments`, {
    amount: 118000, paidDate: today(), method: 'Bank transfer'
  })).status, 201);
  const vatAfter = (await call(finance, 'GET', '/finance/vat?companyId=1')).body;
  assert.equal(Number(vatAfter.inputVat) - Number(vatBefore.inputVat), 19800,
    'paid supplier invoices and paid operating bills feed input VAT automatically');
  assert.ok(vatAfter.entries.some(row => row.reference === supplierInvoice.body.invoice_no && row.direction === 'Input'));

  const card = await call(finance, 'POST', '/finance/credit-cards', {
    companyId: 1, name: 'Operations Visa Test', bank: 'Test Bank', lastFour: '4242',
    cardholder: 'Finance Manager', creditLimit: 500000, defaultReminderDays: 5
  });
  assert.equal(card.status, 201);
  const statement = await call(finance, 'POST', '/finance/credit-card-statements', {
    cardId: card.body.id, statementDate: today(), dueDate: shift(3), amount: 50000,
    minimumDue: 5000, reminderDays: 4
  });
  assert.equal(statement.status, 201);
  const partial = await call(finance, 'POST', `/finance/credit-card-statements/${statement.body.id}/payments`, {
    amount: 20000, paidDate: today(), method: 'Bank transfer', reference: 'CARD-PARTIAL-TEST'
  });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.status, 'Partially paid');
  assert.equal(Number(partial.body.paidAmount), 20000);
  assert.equal((await call(finance, 'POST', `/finance/credit-card-statements/${statement.body.id}/payments`, {
    amount: 40000, paidDate: today(), method: 'Bank transfer'
  })).status, 409, 'card payments cannot exceed the statement balance');

  const bond = await call(finance, 'POST', '/receivables/bonds', {
    companyId: 1, projectId: 1, kind: 'Performance', beneficiary: 'Bond Extension Test Client',
    bank: 'Test Bank', amount: 250000, issuedDate: today(), expiryDate: shift(10), reminderDays: 2
  });
  assert.equal(bond.status, 201);
  assert.equal((await call(finance, 'POST', `/receivables/bonds/${bond.body.id}/extend`, {
    newExpiryDate: shift(40), extendedOn: today(), reminderDays: 7,
    additionalCommission: 2500, note: 'Extension test record'
  })).status, 200);
  const bonds = (await call(finance, 'GET', '/receivables/bonds?companyId=1')).body;
  const extended = bonds.find(row => Number(row.id) === Number(bond.body.id));
  assert.equal(Number(extended.extensions), 1);
  assert.equal(Number(extended.reminderDays), 7);
  assert.equal(Number(extended.commission), 2500);

  assert.equal((await call(owner, 'POST', '/notifications/scan')).status, 200);
  const alerts = (await call(finance, 'GET', '/notifications')).body;
  assert.ok(alerts.some(row => row.referenceType === 'operating_bill' && Number(row.referenceId) === Number(reminderBill.body.id)));
  assert.ok(alerts.some(row => row.referenceType === 'credit_card_statement' && Number(row.referenceId) === Number(statement.body.id)));
});

test('future-dated cheques are reminded and confirmed before settling invoices', async () => {
  const finance = await login('finance@gkuc.lk');
  const owner = await login();
  const invoice = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 1, invoiceNo: `CHK-${Date.now()}`, amount: 75000,
    invoiceDate: today(), dueDate: shift(7)
  });
  assert.equal(invoice.status, 201);
  const cheque = await call(finance, 'POST', '/purchasing/cheques', {
    supplierId: 1, invoiceId: invoice.body.id, chequeNumber: `000${Date.now()}`,
    bank: 'Commercial Bank operating account', payee: 'Lanka Cement PLC',
    purpose: 'Supplier invoice settlement', amount: 75000,
    issueDate: today(), chequeDate: shift(3), reminderDays: 5
  });
  assert.equal(cheque.status, 201);
  let invoices = (await call(finance, 'GET', '/purchasing/invoices')).body;
  assert.equal(Number(invoices.find(row => row.id === invoice.body.id).paidAmount), 0, 'issuing a future cheque is not cleared cash');

  await call(owner, 'POST', '/notifications/scan');
  const alerts = (await call(finance, 'GET', '/notifications')).body;
  assert.ok(alerts.some(row => row.referenceType === 'cheque' && Number(row.referenceId) === Number(cheque.body.id)));

  const clearResults = await Promise.all([1, 2].map(() => call(finance, 'PATCH',
    `/purchasing/cheques/${cheque.body.id}`, { status: 'Cleared', notes: 'Cleared on bank statement' })));
  assert.deepEqual(clearResults.map(result => result.status), [200, 200]);
  invoices = (await call(finance, 'GET', '/purchasing/invoices')).body;
  assert.equal(Number(invoices.find(row => row.id === invoice.body.id).paidAmount), 75000);
  assert.equal((await call(finance, 'PATCH', `/purchasing/cheques/${cheque.body.id}`, { status: 'Returned' })).status, 409);

  const clientInvoice = await call(finance,'POST','/receivables/invoices',{
    projectId:1,kind:'Interim',title:'Cheque receipt test',invoiceDate:today(),dueDate:shift(10),
    taxTreatment:'Exempt',retentionPercent:0,advanceRecovery:0,otherDeductions:0,
    items:[{description:'Certified work',unit:'item',quantity:1,rate:100000}]
  });
  assert.equal(clientInvoice.status,201);
  assert.equal((await call(finance,'POST',`/receivables/invoices/${clientInvoice.body.id}/issue`)).status,204);
  const received=await call(finance,'POST','/receivables/cheques',{
    projectId:1,invoiceId:clientInvoice.body.id,chequeNumber:`RCV-${Date.now()}`,bank:'Bank of Ceylon',
    payer:'Kaduwela Industrial Client',purpose:'Interim certificate settlement',amount:100000,
    receivedDate:today(),chequeDate:shift(2),depositBy:shift(1),reminderDays:3
  });
  assert.equal(received.status,201);
  let clientDetail=await call(finance,'GET',`/receivables/invoices/${clientInvoice.body.id}`);
  assert.equal(Number(clientDetail.body.paid_amount),0,'a cheque in hand is not income yet');
  await call(owner,'POST','/notifications/scan');
  assert.ok((await call(finance,'GET','/notifications')).body.some(row=>row.referenceType==='received_cheque'&&Number(row.referenceId)===Number(received.body.id)));
  assert.equal((await call(finance,'PATCH',`/receivables/cheques/${received.body.id}`,{status:'Deposited',notes:'Bank deposit slip recorded'})).status,200);
  assert.equal((await call(finance,'PATCH',`/receivables/cheques/${received.body.id}`,{status:'Cleared',notes:'Cleared on statement'})).status,200);
  clientDetail=await call(finance,'GET',`/receivables/invoices/${clientInvoice.body.id}`);
  assert.equal(Number(clientDetail.body.paid_amount),100000);
  assert.ok((await call(finance,'GET','/finance/income?projectId=1')).body.some(row=>row.reference===received.body.cheque_number));
});

test('finance reporting reconciles company and project scopes', async () => {
  const owner = await login();
  const company = await call(owner, 'GET', '/finance/reporting?projectId=all');
  assert.equal(company.status, 200);
  assert.equal(company.body.scope.projectId, 'all');
  assert.ok(company.body.projects.length >= 3);
  for (const ledger of ['expenses', 'incomes', 'clientInvoices', 'purchaseOrders', 'supplierInvoices',
    'pettyCash', 'retentions', 'bonds', 'variations', 'payroll']) assert.ok(Array.isArray(company.body[ledger]), ledger);

  const project = await call(owner, 'GET', `/finance/reporting?projectId=1&from=${shift(-3650)}&to=${shift(3650)}`);
  assert.equal(project.status, 200);
  assert.equal(project.body.projects.length, 1);
  assert.equal(Number(project.body.projects[0].id), 1);
  for (const ledger of ['expenses', 'incomes', 'clientInvoices', 'purchaseOrders', 'retentions', 'variations'])
    assert.ok(project.body[ledger].every(row => Number(row.projectId) === 1), `${ledger} obeys project scope`);
  assert.deepEqual(project.body.payroll, [], 'payroll is not falsely allocated to a project');
  assert.equal((await call(owner, 'GET', '/finance/reporting?projectId=invalid')).status, 400);
});

test('two companies share resources while commercial records and totals stay separate', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const finance = await login('finance@gkuc.lk');

  const bootstrap = await call(owner, 'GET', '/bootstrap');
  assert.deepEqual(bootstrap.body.data.companies.map(row => row.name), ['GKUC Construction', 'GKUC Readymix']);
  const sharedCounts = {
    employees: bootstrap.body.data.employees.length,
    materials: bootstrap.body.data.materials.length,
    fleet: bootstrap.body.data.fleet.length
  };

  const project = await call(owner, 'POST', '/projects', {
    companyId: 2, name: 'Readymix Plant Upgrade', client: 'GKUC Readymix Operations',
    manager: 'Kasun Perera', site: 'Homagama', stage: 'Mobilisation', budget: 900000,
    progress: 5, health: 'On track'
  });
  assert.equal(project.status, 201);
  assert.equal(Number(project.body.companyId), 2);

  const boq = await call(qs, 'POST', '/boq', {
    projectId: project.body.id, title: 'Readymix batching plant works',
    items: [{ category: 'Equipment', description: 'Batching plant electrical upgrade', unit: 'item', quantity: 1, rate: 300000 }]
  });
  assert.equal(boq.status, 201);
  const quotation = await call(qs, 'POST', '/qs/quotations', {
    boqId: boq.body.id, markupPercent: 10, vatPercent: 18
  });
  assert.equal(quotation.status, 201);
  assert.equal(Number(quotation.body.companyId), 2);

  assert.equal((await call(finance, 'POST', '/finance/expenses', {
    projectId: project.body.id, source: 'Equipment', description: 'Readymix plant deposit',
    amount: 125000, expenseDate: today(), reference: 'GKRM-ONLY'
  })).status, 201);
  const invoice = await call(finance, 'POST', '/receivables/invoices', {
    projectId: project.body.id, kind: 'Interim', title: 'Readymix upgrade certificate',
    invoiceDate: today(), dueDate: shift(14), taxTreatment: 'Exempt', retentionPercent: 0,
    advanceRecovery: 0, otherDeductions: 0,
    items: [{ description: 'Upgrade work completed', unit: 'item', quantity: 1, rate: 250000 }]
  });
  assert.equal(invoice.status, 201);
  assert.equal((await call(finance, 'POST', `/receivables/invoices/${invoice.body.id}/issue`)).status, 204);
  const chequeNumber = `GKRM-${Date.now()}`;
  const wrongCheque = await call(finance, 'POST', '/receivables/cheques', {
    companyId: 1, projectId: project.body.id, invoiceId: invoice.body.id, chequeNumber,
    bank: 'Bank of Ceylon', payer: 'Readymix Client', purpose: 'Cross-company rejection test',
    amount: 10000, receivedDate: today(), chequeDate: shift(2), depositBy: shift(1)
  });
  assert.equal(wrongCheque.status, 400, 'a cheque cannot link to the other company invoice');
  const receivedCheque = await call(finance, 'POST', '/receivables/cheques', {
    companyId: 2, projectId: project.body.id, invoiceId: invoice.body.id, chequeNumber,
    bank: 'Bank of Ceylon', payer: 'Readymix Client', purpose: 'Readymix receipt',
    amount: 10000, receivedDate: today(), chequeDate: shift(2), depositBy: shift(1)
  });
  assert.equal(receivedCheque.status, 201);
  const bond = await call(finance, 'POST', '/receivables/bonds', {
    companyId: 2, projectId: project.body.id, kind: 'Performance', beneficiary: 'Readymix Client',
    bank: 'People’s Bank', amount: 50000, issuedDate: today(), expiryDate: shift(90)
  });
  assert.equal(bond.status, 201);
  const petty = await call(finance, 'POST', '/receivables/petty-cash', {
    companyId: 2, name: 'Readymix fuel float', accountType: 'Fuel', holderName: 'Plant Supervisor',
    projectId: project.body.id, ceiling: 30000, lowAt: 5000
  });
  assert.equal(petty.status, 201);
  const supplierInvoice = await call(finance, 'POST', '/purchasing/invoices', {
    companyId: 2, supplierId: 1, invoiceNo: `GKRM-SUP-${Date.now()}`, amount: 40000,
    invoiceDate: today(), dueDate: shift(14)
  });
  assert.equal(supplierInvoice.status, 201);

  const constructionProjects = await call(owner, 'GET', '/projects?companyId=1');
  const readymixProjects = await call(owner, 'GET', '/projects?companyId=2');
  assert.ok(!constructionProjects.body.some(row => row.id === project.body.id));
  assert.ok(readymixProjects.body.some(row => row.id === project.body.id));
  assert.ok(!(await call(qs, 'GET', '/boq?companyId=1')).body.some(row => row.id === boq.body.id));
  assert.ok((await call(qs, 'GET', '/boq?companyId=2')).body.some(row => row.id === boq.body.id));
  assert.ok(!(await call(qs, 'GET', '/qs/quotations?companyId=1')).body.some(row => row.id === quotation.body.id));
  assert.ok((await call(qs, 'GET', '/qs/quotations?companyId=2')).body.some(row => row.id === quotation.body.id));
  assert.ok(!(await call(finance, 'GET', '/receivables/invoices?companyId=1')).body.some(row => row.id === invoice.body.id));
  assert.ok((await call(finance, 'GET', '/receivables/invoices?companyId=2')).body.some(row => row.id === invoice.body.id));
  assert.ok(!(await call(finance, 'GET', '/receivables/cheques?companyId=1')).body.some(row => row.id === receivedCheque.body.id));
  assert.ok((await call(finance, 'GET', '/receivables/cheques?companyId=2')).body.some(row => row.id === receivedCheque.body.id));
  assert.ok(!(await call(finance, 'GET', '/receivables/bonds?companyId=1')).body.some(row => row.id === bond.body.id));
  assert.ok((await call(finance, 'GET', '/receivables/bonds?companyId=2')).body.some(row => row.id === bond.body.id));
  assert.ok(!(await call(finance, 'GET', '/receivables/petty-cash?companyId=1')).body.some(row => row.id === petty.body.id));
  assert.ok((await call(finance, 'GET', '/receivables/petty-cash?companyId=2')).body.some(row => row.id === petty.body.id));
  assert.ok(!(await call(finance, 'GET', '/purchasing/invoices?companyId=1')).body.some(row => row.id === supplierInvoice.body.id));
  assert.ok((await call(finance, 'GET', '/purchasing/invoices?companyId=2')).body.some(row => row.id === supplierInvoice.body.id));

  const construction = await call(finance, 'GET', '/finance/reporting?companyId=1&projectId=all');
  const readymix = await call(finance, 'GET', '/finance/reporting?companyId=2&projectId=all');
  assert.ok(!construction.body.expenses.some(row => row.reference === 'GKRM-ONLY'));
  assert.ok(readymix.body.expenses.some(row => row.reference === 'GKRM-ONLY'));
  assert.ok(readymix.body.projects.every(row => Number(row.companyId) === 2));

  const refreshed = await call(owner, 'GET', '/bootstrap');
  assert.equal(refreshed.body.data.employees.length, sharedCounts.employees);
  assert.equal(refreshed.body.data.materials.length, sharedCounts.materials);
  assert.equal(refreshed.body.data.fleet.length, sharedCounts.fleet);
});

test('the deadline scan raises alerts for expiries, low stock and overruns', async () => {
  const owner = await login();
  const scan = await call(owner, 'POST', '/notifications/scan');
  assert.equal(scan.status, 200);

  const alerts = (await call(owner, 'GET', '/notifications')).body;
  assert.ok(alerts.some(alert => alert.referenceType === 'vehicle_document'), 'lapsing vehicle documents are alerted');
  assert.ok(alerts.some(alert => alert.referenceType === 'material'), 'low stock is alerted');
  assert.ok(alerts.some(alert => alert.severity === 'Critical'));

  /* The scan is idempotent for the day: running it again must not duplicate alerts. */
  const before = alerts.length;
  await call(owner, 'POST', '/notifications/scan');
  assert.equal((await call(owner, 'GET', '/notifications')).body.length, before);
});

test('attendance is unique per employee per day and corrections are audited', async () => {
  const supervisor = await login('supervisor@gkuc.lk');
  const first = await call(supervisor, 'POST', '/attendance', {
    name: 'Test Worker', role: 'Carpenter', projectId: 1, date: today(), state: 'On site'
  });
  assert.equal(first.status, 201);
  const duplicate = await call(supervisor, 'POST', '/attendance', {
    name: 'Test Worker', role: 'Carpenter', projectId: 1, date: today(), state: 'On site'
  });
  assert.equal(duplicate.status, 409);

  const corrected = await call(supervisor, 'PATCH', `/attendance/${first.body.id}`, { state: 'Late', reason: 'Arrived after gate close' });
  assert.equal(corrected.status, 200);
  const owner = await login();
  const audit = await call(owner, 'GET', '/audit?action=CORRECTION');
  assert.ok(audit.body.some(entry => entry.entity === 'attendance'));
});

test('daily reports capture site detail and escalate issues', async () => {
  const supervisor = await login('supervisor@gkuc.lk');
  const report = await call(supervisor, 'POST', '/reports', {
    projectId: 3,
    workforce: 18,
    work: 'Second coat painting to level 2',
    issue: 'Paint delivery arrived late',
    delayHours: 2,
    materials: [{ materialId: 5, quantity: 4 }]
  });
  assert.equal(report.status, 201);

  const detail = await call(supervisor, 'GET', `/reports/${report.body.id}`);
  assert.equal(detail.body.materials.length, 1);

  const manager = await login('manager@gkuc.lk');
  const alerts = (await call(manager, 'GET', '/notifications')).body;
  assert.ok(alerts.some(alert => alert.referenceType === 'daily_report'), 'a reported delay reaches management the same day');
});

test('generates reports across every operational area', async () => {
  const owner = await login();
  const types = (await call(owner, 'GET', '/analytics')).body;
  assert.ok(types.length >= 10);
  for (const type of types) {
    const report = await call(owner, 'GET', `/analytics/${type}`);
    assert.equal(report.status, 200, `${type} report should build`);
    assert.ok(Array.isArray(report.body.columns) && Array.isArray(report.body.rows));
  }
  assert.equal((await call(owner, 'GET', '/analytics/nonsense')).status, 404);
});

test('stores uploads, enforces type and permission, and lists them on the record', async () => {
  const owner = await login();
  const store = await login('store@gkuc.lk');

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const send = async (token, ownerType, ownerId, filename, type, body = png) => {
    const form = new FormData();
    form.append('file', new Blob([body], { type }), filename);
    form.append('title', 'Level 4 pour');
    const response = await fetch(`${base}/uploads/${ownerType}/${ownerId}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form
    });
    return { status: response.status, body: await response.json() };
  };

  const stored = await send(owner, 'task', 1, 'site.png', 'image/png');
  assert.equal(stored.status, 201);
  assert.match(stored.body.url, /^\/uploads\/task\//);
  assert.equal(stored.body.kind, 'Site photo', 'images default to site photos');

  const executable = await send(owner, 'task', 1, 'payload.exe', 'application/x-msdownload');
  assert.equal(executable.status, 415, 'executables are refused');

  const denied = await send(store, 'task', 1, 'site.png', 'image/png');
  assert.equal(denied.status, 403, 'a storekeeper cannot attach files to a task');

  const missing = await send(owner, 'task', 99999, 'site.png', 'image/png');
  assert.equal(missing.status, 404);

  /*
   * Stored files are not public. They used to be mounted statically, which put every
   * contract and identity document one URL away from anyone at all; they now travel through
   * a route that applies the same permission as seeing the file listed.
   */
  const byUrl = await fetch(`http://127.0.0.1:${port}${stored.body.url}`);
  assert.equal(byUrl.status, 404, 'the old public path serves nothing');

  const anonymous = await fetch(`http://127.0.0.1:${port}/api/uploads/file/${stored.body.id}`);
  assert.equal(anonymous.status, 401, 'and the file needs a session');

  const served = await fetch(`http://127.0.0.1:${port}/api/uploads/file/${stored.body.id}`,
    { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(served.status, 200, 'someone who may see the record gets the file');

  const task = await call(owner, 'GET', '/tasks/1');
  assert.ok(task.body.attachments.some(file => file.id === stored.body.id));

  assert.equal((await call(owner, 'DELETE', `/uploads/${stored.body.id}`)).status, 204);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/uploads/file/${stored.body.id}`,
    { headers: { authorization: `Bearer ${owner}` } })).status, 404, 'deleting removes the record and the object');
});

test('an inquiry converts into a registered project', async () => {
  const manager = await login('manager@gkuc.lk');
  const inquiry = await call(manager, 'POST', '/inquiries', {
    customer: 'Test Client', location: 'Moratuwa',
    description: 'Two-storey extension', expectedValue: 9000000
  });
  assert.equal(inquiry.status, 201);
  assert.match(inquiry.body.reference, /^INQ-/);

  const converted = await call(manager, 'POST', `/inquiries/${inquiry.body.id}/convert`, {
    name: 'Moratuwa extension', manager: 'Nadeesha Silva', budget: 9000000
  });
  assert.equal(converted.status, 201);
  assert.equal(converted.body.client, 'Test Client', 'the customer carries onto the project');

  assert.equal((await call(manager, 'POST', `/inquiries/${inquiry.body.id}/convert`, {
    name: 'Duplicate', manager: 'Nadeesha Silva'
  })).status, 409, 'an inquiry converts only once');
});

test('payroll is calculated from recorded attendance and approved overtime', async () => {
  const hr = await login('hr@gkuc.lk');
  const supervisor = await login('supervisor@gkuc.lk');
  const owner = await login();

  const settings = await call(hr, 'GET', '/payroll/settings');
  assert.equal(settings.status, 200);
  assert.equal(Number(settings.body.activePolicy.officeOtRate), 225);
  assert.equal((await call(hr, 'POST', '/payroll/settings/policies', {
    effectiveFrom: shift(-2), officeOtRate: 225, siteLabourSiteOtRate: 200,
    siteLabourTravelOtRate: 100, driverOtRate: 225, supervisorSiteOtRate: 225,
    supervisorTravelOtRate: 100, epfEmployeeRate: 8, epfEmployerRate: 12,
    etfEmployerRate: 3, epfBasis: 'Gross earnings', etfBasis: 'Gross earnings'
  })).status, 400, 'gross pay cannot be selected as the contribution base');
  assert.equal((await call(hr, 'POST', '/payroll/settings/policies', {
    effectiveFrom: shift(-1), officeOtRate: 225, siteLabourSiteOtRate: 200,
    siteLabourTravelOtRate: 100, driverOtRate: 225, supervisorSiteOtRate: 225,
    supervisorTravelOtRate: 100, epfEmployeeRate: 8, epfEmployerRate: 12,
    etfEmployerRate: 3, epfBasis: 'Basic earnings', etfBasis: 'Basic earnings'
  })).status, 201);
  assert.equal((await call(hr, 'PATCH', '/payroll/settings/employees/2', {
    payBasis: 'Monthly salary', payFrequency: 'Monthly', payrollCategory: 'Site labourer',
    basicSalary: 98000, weeklyRate: 0, dailyRate: 4400, compensationEffectiveFrom: shift(-1),
    epfEligible: true, etfEligible: true, customOfficeOtRate: null, customSiteOtRate: null, customTravelOtRate: null
  })).status, 200);
  assert.equal((await call(hr, 'POST', '/payroll/settings/components', {
    employeeId: 2, name: 'Transport allowance', kind: 'Allowance', amount: 3000,
    payFrequency: 'Monthly', effectiveFrom: shift(-1)
  })).status, 201);
  assert.equal((await call(hr, 'POST', '/payroll/settings/components', {
    employeeId: 2, name: 'Union deduction', kind: 'Deduction', amount: 500,
    payFrequency: 'Monthly', effectiveFrom: shift(-1)
  })).status, 201);
  assert.equal((await call(hr, 'POST', '/payroll/settings/components', {
    employeeId: 2, name: 'Travel reimbursement', kind: 'Reimbursement', amount: 1000,
    payFrequency: 'Monthly', effectiveFrom: shift(-1)
  })).status, 201);

  const openFloat = async (name, accountType, ceiling) => {
    const opened = await call(owner, 'POST', '/receivables/petty-cash', {
      name, accountType, holderName: 'Finance desk', ceiling, lowAt: 5000
    });
    assert.equal(opened.status, 201);
    assert.equal((await call(owner, 'POST', `/receivables/petty-cash/${opened.body.id}/entries`, {
      kind: 'Top up', amount: ceiling, entryDate: today(), description: `Opening ${accountType}`
    })).status, 201);
    return opened.body.id;
  };
  const officeFloat = await openFloat('Office account', 'Office expenses', 30000);
  const advanceFloat = await openFloat('Worker advances', 'Salary advance', 50000);
  const fuelFloat = await openFloat('Fuel account', 'Fuel', 40000);
  const floats = (await call(owner, 'GET', '/receivables/petty-cash')).body;
  assert.equal(Number(floats.find(row => row.id === officeFloat).balance), 30000);
  assert.equal(Number(floats.find(row => row.id === advanceFloat).balance), 50000);
  assert.equal(Number(floats.find(row => row.id === fuelFloat).balance), 40000);
  assert.equal((await call(owner, 'POST', `/receivables/petty-cash/${advanceFloat}/entries`, {
    kind: 'Spend', amount: 12000, entryDate: today(), description: 'Worker salary advance'
  })).status, 400, 'a salary advance cannot be anonymous');
  assert.equal((await call(owner, 'POST', `/receivables/petty-cash/${advanceFloat}/entries`, {
    kind: 'Spend', amount: 12000, entryDate: today(), description: 'Worker salary advance', employeeId: 2
  })).status, 201);

  const invalidOvertime = await call(supervisor, 'POST', '/employees/2/overtime', {
    workDate: today(), hours: 1, overtimeType: 'Office'
  });
  assert.equal(invalidOvertime.status, 400, 'site labour cannot be entered against the office overtime policy');
  const overtime = await call(supervisor, 'POST', '/employees/2/overtime', { workDate: today(), hours: 4, overtimeType: 'Site' });
  assert.equal(overtime.status, 201);
  assert.equal(Number(overtime.body.rate), 200);
  await call(hr, 'PATCH', `/employees/overtime/${overtime.body.id}`, { status: 'Approved' });
  const travelOvertime = await call(supervisor, 'POST', '/employees/2/overtime', { workDate: today(), hours: 2, overtimeType: 'Travel' });
  assert.equal(travelOvertime.status, 201);
  assert.equal(Number(travelOvertime.body.rate), 100);
  await call(hr, 'PATCH', `/employees/overtime/${travelOvertime.body.id}`, { status: 'Approved' });

  const run = await call(hr, 'POST', '/payroll', { periodStart: shift(-30), periodEnd: today() });
  assert.equal(run.status, 201);
  assert.ok(Number(run.body.total) > 0);

  const detail = await call(hr, 'GET', `/payroll/${run.body.id}`);
  const slip = detail.body.payslips.find(row => row.employeeCode === 'EMP-0002');
  assert.equal(Number(slip.overtimeHours), 6, 'approved typed overtime reaches the payslip');
  assert.equal(Number(slip.siteOtPay), 800);
  assert.equal(Number(slip.travelOtPay), 200);
  assert.equal(Number(slip.overtimePay), 1000, 'each overtime category keeps its approved rate');
  assert.equal(Number(slip.allowanceTotal), 3000);
  assert.equal(Number(slip.reimbursementTotal), 1000);
  assert.equal(Number(slip.epfEmployeeDeduction), 7840);
  assert.equal(Number(slip.epfEmployerContribution), 11760);
  assert.equal(Number(slip.etfEmployerContribution), 2940);
  assert.equal(Number(slip.otherDeduction), 500);
  assert.equal(Number(slip.unpaidLeaveDeduction), 0);
  assert.equal(Number(slip.salaryAdvanceDeduction), 12000, 'the named worker advance is recovered');
  assert.equal(Number(slip.deductions), 20340, 'the salary sheet reconciles statutory, recurring and advance deductions');
  assert.equal(Number(slip.netPay), 82660);
  assert.equal(Number(slip.employerCost), 117700);
  assert.equal(slip.components.length, 3, 'the payslip preserves the named component breakdown');
  assert.equal(Number(slip.advanceRecoveries[0].amount), 12000);
  const advances = (await call(owner, 'GET', `/receivables/petty-cash/${advanceFloat}/entries`)).body;
  assert.equal(Number(advances.find(row => row.employeeId === 2).outstandingAdvance), 0);

  assert.equal((await call(hr, 'POST', '/payroll', { periodStart: shift(-30), periodEnd: today() })).status, 409);

  assert.equal((await call(hr, 'PATCH', '/payroll/settings/employees/3', {
    payBasis: 'Daily rate', payFrequency: 'Weekly', payrollCategory: 'Site labourer',
    basicSalary: 0, weeklyRate: 0, dailyRate: 3300, compensationEffectiveFrom: shift(-1),
    epfEligible: false, etfEligible: false, customOfficeOtRate: null, customSiteOtRate: null, customTravelOtRate: null
  })).status, 200);
  const weeklyRun = await call(hr, 'POST', '/payroll', { periodStart: shift(-6), periodEnd: today(), payFrequency: 'Weekly' });
  assert.equal(weeklyRun.status, 201, 'a weekly payroll can coexist with a monthly run');
  assert.equal(weeklyRun.body.payFrequency, 'Weekly');

  const store = await login('store@gkuc.lk');
  assert.equal((await call(store, 'GET', '/payroll')).status, 403, 'pay data is restricted to HR');
});

test('equipment QR labels resolve to the asset', async () => {
  const owner = await login();
  const issued = await call(owner, 'POST', '/equipment/1/qr');
  assert.equal(issued.status, 200);
  assert.match(issued.body.qrToken, /^[a-f0-9]{32}$/);

  const scanned = await call(owner, 'GET', `/equipment/scan/${issued.body.qrToken}`);
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.code, 'EQP-0001');
  assert.equal((await call(owner, 'GET', '/equipment/scan/deadbeef')).status, 404);
});

test('logging a service resets the vehicle service schedule', async () => {
  const transport = await login('transport@gkuc.lk');
  await call(transport, 'PATCH', '/fleet/1', { serviceIntervalKm: 5000, lastServiceOdometer: 140000 });

  let vehicle = (await call(transport, 'GET', '/fleet/1')).body;
  assert.equal(vehicle.service.kmRemaining, 140000 + 5000 - vehicle.odometer);

  await call(transport, 'POST', '/fleet/1/maintenance', {
    serviceDate: today(), description: 'Full service', cost: 32000, odometer: 150000
  });
  vehicle = (await call(transport, 'GET', '/fleet/1')).body;
  assert.equal(Number(vehicle.lastServiceOdometer), 150000, 'the schedule restarts from this service');
  assert.equal(vehicle.service.kmRemaining, 5000);
});

test('fleet fuel draws one funded float movement and one project expense without double entry', async () => {
  const owner = await login();
  const transport = await login('transport@gkuc.lk');
  const opened = await call(owner, 'POST', '/receivables/petty-cash', {
    name: `Fuel float ${Date.now()}`, accountType: 'Fuel', holderName: 'Transport desk',
    projectId: 1, ceiling: 15000, lowAt: 2000
  });
  assert.equal(opened.status, 201);
  const floatId = opened.body.id;
  const entriesPath = `/receivables/petty-cash/${floatId}/entries`;
  assert.equal((await call(owner, 'POST', entriesPath, {
    kind: 'Top up', amount: 15000, entryDate: today(), description: 'Fuel funding'
  })).status, 201);
  assert.equal((await call(owner, 'POST', entriesPath, {
    kind: 'Spend', amount: 1000, entryDate: today(), description: 'Should be entered in Fleet'
  })).status, 400);
  const available = await call(transport, 'GET', '/fleet/fuel-floats?companyId=1');
  assert.equal(available.status, 200);
  assert.equal(Number(available.body.find(row => row.id === floatId).balance), 15000);

  const vehicle = await call(owner, 'POST', '/fleet', {
    vehicle: 'Float-linked test truck', registration: `TEST-FLOAT-${Date.now()}`,
    status: 'Available', renewal: 'Insurance', dueDate: today(), projectId: 1, odometer: 100
  });
  assert.equal(vehicle.status, 201);
  const path = `/fleet/${vehicle.body.id}/fuel`;
  const fuel = cost => ({ fuelFloatId: floatId, projectId: 1, fuelDate: today(), litres: 20,
    cost, odometer: 120 });
  const overdraw = await call(transport, 'POST', path, fuel(16000));
  assert.equal(overdraw.status, 409);
  assert.match(overdraw.body.error, /15,000/);
  const saved = await call(transport, 'POST', path, fuel(12000));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));

  const ledger = await call(owner, 'GET', entriesPath);
  const linked = ledger.body.filter(row => row.fuelRecordId === saved.body.id);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].vehicleId, vehicle.body.id);
  assert.equal(Number(linked[0].amount), -12000);
  const floats = await call(owner, 'GET', '/receivables/petty-cash?companyId=1');
  assert.equal(Number(floats.body.find(row => row.id === floatId).balance), 3000);
  const expenses = (await call(owner, 'GET', '/finance/expenses?projectId=1')).body;
  assert.equal(expenses.filter(row => row.originType === 'fuel_record' && row.description.includes('Float-linked test truck')).length, 1);
  assert.equal(expenses.filter(row => row.originType === 'petty_cash' && row.description.includes('Float-linked test truck')).length, 0);
  assert.equal((await call(transport, 'POST', path, fuel(4000))).status, 409);
  const concurrent = await Promise.all([1, 2].map(() => call(transport, 'POST', path, {
    ...fuel(2000), odometer: 130
  })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409]);
  const balanceAfter = (await call(owner, 'GET', '/receivables/petty-cash?companyId=1')).body
    .find(row => row.id === floatId).balance;
  assert.equal(Number(balanceAfter), 1000);

  const otherCompany = await call(owner, 'POST', '/receivables/petty-cash', {
    companyId: 2, name: `Other company fuel ${Date.now()}`, accountType: 'Fuel',
    holderName: 'Readymix desk', ceiling: 10000, lowAt: 1000
  });
  assert.equal(otherCompany.status, 201);
  assert.equal((await call(owner, 'POST', `/receivables/petty-cash/${otherCompany.body.id}/entries`, {
    kind: 'Top up', amount: 10000, entryDate: today(), description: 'Readymix funding'
  })).status, 201);
  const wrongCompany = await call(transport, 'POST', path, {
    ...fuel(500), odometer: 140, fuelFloatId: otherCompany.body.id
  });
  assert.equal(wrongCompany.status, 400);
  assert.match(wrongCompany.body.error, /different company/);
});

test('fleet histories preserve driver handovers, odometer, repairs and renewals',async()=>{
  const owner=await login();
  const fuelFloat=await call(owner,'POST','/receivables/petty-cash',{
    name:`Fleet history fuel ${Date.now()}`,accountType:'Fuel',holderName:'Transport desk',projectId:1,
    ceiling:20000,lowAt:1000
  });
  assert.equal(fuelFloat.status,201);
  assert.equal((await call(owner,'POST',`/receivables/petty-cash/${fuelFloat.body.id}/entries`,{
    kind:'Top up',amount:20000,entryDate:today(),description:'Fleet history test funding'
  })).status,201);
  const created=await call(owner,'POST','/fleet',{vehicle:'Test site tipper',registration:`TEST-FLEET-${Date.now()}`,
    status:'Assigned',renewal:'Insurance',dueDate:today(),projectId:1,odometer:1000,
    serviceIntervalKm:1000,driver:'Initial Driver'});
  assert.equal(created.status,201);const id=created.body.id;
  let detail=(await call(owner,'GET',`/fleet/${id}`)).body;
  assert.equal(detail.drivers.length,1);
  assert.equal(detail.renewals.length,1);
  assert.equal(detail.readings.length,1);
  assert.equal((await call(owner,'POST',`/fleet/${id}/fuel`,{fuelFloatId:fuelFloat.body.id,fuelDate:today(),litres:40,cost:12000,
    odometer:1100,projectId:1})).status,201);
  assert.equal((await call(owner,'POST',`/fleet/${id}/odometer`,{readingDate:today(),odometer:1050})).status,409);
  assert.equal((await call(owner,'POST',`/fleet/${id}/odometer`,{readingDate:today(),odometer:1150,
    notes:'End of shift'})).status,201);
  assert.equal((await call(owner,'POST',`/fleet/${id}/maintenance`,{kind:'Repair',serviceDate:today(),
    description:'Replace damaged brake hose',cost:7500,garage:'Local garage',odometer:1200,
    projectId:1,setStatus:'Repair'})).status,201);
  detail=(await call(owner,'GET',`/fleet/${id}`)).body;
  assert.equal(detail.lastServiceDate,null,'a repair does not reset scheduled service');
  assert.equal(detail.status,'Repair');
  assert.equal(detail.maintenance[0].kind,'Repair');
  assert.ok(detail.maintenance[0].project);
  const fleetExpenses=(await call(owner,'GET','/finance/expenses?projectId=1')).body;
  assert.ok(fleetExpenses.some(row=>row.originType==='vehicle_maintenance'&&Number(row.amount)===7500));
  assert.equal((await call(owner,'POST',`/fleet/${id}/maintenance`,{kind:'Service',serviceDate:today(),
    description:'Full scheduled service',cost:15000,odometer:1300,setStatus:'Available'})).status,201);
  const handover=await call(owner,'POST',`/fleet/${id}/drivers`,{driverName:'Relief Driver',
    projectId:1,assignedOn:detail.drivers[0].assignedOn.slice(0,10),notes:'Night shift coverage'});
  assert.equal(handover.status,201);
  assert.equal((await call(owner,'POST',`/fleet/${id}/documents`,{docType:'Insurance',reference:'POL-2027',
    renewedOn:today(),expiryDate:today(),cost:24000})).status,201);
  assert.equal((await call(owner,'POST',`/fleet/${id}/documents`,{docType:'Revenue licence',reference:'RL-2027',
    renewedOn:today(),expiryDate:today(),cost:4500})).status,201);
  detail=(await call(owner,'GET',`/fleet/${id}`)).body;
  assert.equal(detail.lastServiceOdometer,1300);
  assert.equal(detail.service.kmRemaining,1000);
  assert.equal(detail.drivers[0].driverName,'Relief Driver');
  assert.ok(detail.drivers[1].endedOn,'the previous assignment has a closing date');
  assert.equal(detail.renewals.length,3);
  assert.equal(detail.documents.find(row=>row.docType==='Insurance').reference,'POL-2027');
  assert.equal(detail.documents.find(row=>row.docType==='Revenue licence').reference,'RL-2027');
  assert.equal(new Date(detail.due_date).toISOString().slice(0,10),
    new Date(detail.documents.find(row=>row.docType==='Insurance').expiryDate).toISOString().slice(0,10));
  assert.ok(detail.readings.some(row=>row.source==='Repair'));
  assert.ok(detail.readings.some(row=>row.source==='Service'));
  assert.equal((await call(owner,'PATCH',`/fleet/${id}`,{driver:'Untracked Driver'})).status,400);
});

test('the completion report is assembled from live project data', async () => {
  const owner = await login();
  const workspace = await call(owner, 'GET', '/projects/1');
  assert.equal(workspace.status, 200);
  assert.ok(Array.isArray(workspace.body.reporting.expenseLedger));
  assert.ok(Array.isArray(workspace.body.reporting.incomeLedger));
  assert.ok(Array.isArray(workspace.body.reporting.attendanceLedger));
  assert.ok(Array.isArray(workspace.body.reporting.materialUsage));
  assert.ok(Array.isArray(workspace.body.reporting.equipmentUsage));
  assert.ok(Array.isArray(workspace.body.reporting.supplierInvoices));
  assert.ok(Array.isArray(workspace.body.reporting.costItems));
  assert.ok(Array.isArray(workspace.body.reporting.variationLedger));
  const report = await call(owner, 'GET', '/projects/1/completion');
  assert.equal(report.status, 200);
  assert.equal(report.body.project.name, 'Riverside Residences');
  assert.ok(report.body.financial.spent > 0);
  assert.ok(Array.isArray(report.body.financial.byCategory));
  assert.ok(report.body.delivery.tasks.total >= 1);
  assert.equal(
    report.body.financial.variance,
    report.body.financial.budget - report.body.financial.spent
  );
});

test('performance reviews average their four scores', async () => {
  const hr = await login('hr@gkuc.lk');
  const review = await call(hr, 'POST', '/payroll/reviews/1', {
    reviewDate: today(), period: 'Q3 2026', quality: 4, productivity: 5, safety: 4, reliability: 3
  });
  assert.equal(review.status, 201);
  assert.equal(Number(review.body.overall), 4);
});

test('HR reconciles a new scanner identity and records historical site attendance', async () => {
  const token = await login();
  const created = await call(token, 'POST', '/biometric/people', {
    code: 'TEST-991', name: 'Scanner New Person', department: 'Roadworks', firstDate: shift(-45)
  });
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^BIO-TEST-991/);

  const profile = await call(token, 'GET', `/employees/${created.body.id}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.biometricId, 'TEST-991');

  const recorded = await call(token, 'POST', '/attendance', {
    name: profile.body.name,
    role: profile.body.designation,
    employeeId: profile.body.id,
    projectId: 1,
    date: shift(-45),
    state: 'Checked out',
    checkIn: '07:15',
    checkOut: '17:20'
  });
  assert.equal(recorded.status, 201);
  assert.match(recorded.body.in, /^07:15/);
  assert.match(recorded.body.out, /^17:20/);

  const corrected = await call(token, 'PATCH', `/attendance/${recorded.body.id}`, {
    workDate: shift(-44),
    checkIn: '08:00',
    checkOut: null,
    state: 'On site',
    projectId: 2,
    reason: 'Employee travelled directly to the site'
  });
  assert.equal(corrected.status, 200);
  assert.equal(String(corrected.body.work_date).slice(0, 10), shift(-44));
  assert.equal(corrected.body.check_out, null);

  const analytics = await call(token, 'GET', '/attendance/analytics');
  assert.equal(analytics.status, 200);
  assert.equal(analytics.body.weekly.series.length, 7);
  assert.equal(analytics.body.monthly.series.length, 30);
  assert.ok(Array.isArray(analytics.body.lowAttendance));
});

test('HR links an existing person from a scanner preview and imports the matched day', async () => {
  const authToken = await login();
  const employee = (await call(authToken, 'GET', '/employees')).body.find(person => !person.biometricId);
  assert.ok(employee, 'a seeded employee without a scanner number is available');
  const scannerCode = 'TEST-LINK-205';
  const date = shift(-70);
  const file = new FormData();
  file.append('file', new Blob([`ID,Name,Date,In,Out\n${scannerCode},${employee.name},${date},08:00,17:00\n`], { type: 'text/csv' }), 'scanner.csv');
  const preview = async () => {
    const response = await fetch(`${base}/biometric/preview`, {
      method: 'POST', headers: { authorization: `Bearer ${authToken}` }, body: file
    });
    return { status: response.status, body: await response.json() };
  };
  const before = await preview();
  assert.equal(before.status, 200);
  assert.equal(before.body.summary.unmatched, 1);
  assert.equal(before.body.unknownDevices[0].suggestedEmployeeId, employee.id);

  const linked = await call(authToken, 'POST', '/biometric/mappings', { code: scannerCode, employeeId: employee.id });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  const after = await preview();
  assert.equal(after.status, 200);
  assert.equal(after.body.summary.unmatched, 0);
  assert.equal(after.body.rows[0].employeeId, employee.id);

  const imported = await call(authToken, 'POST', '/biometric/commit', {
    filename: 'scanner.csv', rows: after.body.rows.map(row => ({ ...row, projectId: 1, workLocation: 'Site' }))
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.inserted, 1);
});

test('one employee keeps multiple scanner numbers when another number is linked', async () => {
  const authToken = await login();
  const oldCode = `ALIAS-OLD-${Date.now()}`;
  const newCode = `ALIAS-NEW-${Date.now()}`;
  const date = shift(-82);
  const person = await call(authToken, 'POST', '/biometric/people', {
    code: oldCode, name: 'Multiple Scanner Worker', firstDate: date
  });
  assert.equal(person.status, 201);
  const linked = await call(authToken, 'POST', '/biometric/mappings', {
    code: newCode, employeeId: person.body.id
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.deepEqual(linked.body.codes, [newCode, oldCode].sort());
  const file = new FormData();
  file.append('file', new Blob([
    `ID,Name,Date,In,Out\n${oldCode},Multiple Scanner Worker,${date},08:00,17:00\n`
    + `${newCode},Multiple Scanner Worker,${shift(-81)},08:10,17:10\n`
  ], { type: 'text/csv' }), 'multiple-scanner-numbers.csv');
  const response = await fetch(`${base}/biometric/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${authToken}` }, body: file
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.summary.matched, 2);
  assert.equal(preview.summary.unmatched, 0);
  assert.deepEqual([...new Set(preview.rows.map(row => row.employeeId))], [person.body.id]);
  const profile = await call(authToken, 'GET', `/employees/${person.body.id}`);
  assert.deepEqual(profile.body.biometricIds, [newCode, oldCode].sort());
});

test('HR can import matched biometric days while leaving unknown scanner days untouched', async () => {
  const authToken = await login();
  const knownCode = `PARTIAL-KNOWN-${Date.now()}`;
  const unknownCode = `PARTIAL-UNKNOWN-${Date.now()}`;
  const date = shift(-83);
  const person = await call(authToken, 'POST', '/biometric/people', {
    code: knownCode, name: 'Partial Import Worker', firstDate: date
  });
  assert.equal(person.status, 201);
  const file = new FormData();
  file.append('file', new Blob([
    `ID,Name,Date,In,Out\n${knownCode},Partial Import Worker,${date},08:00,17:00\n`
    + `${unknownCode},Not Yet Identified,${date},08:05,16:55\n`
  ], { type: 'text/csv' }), 'partial.csv');
  const preview = async () => {
    const response = await fetch(`${base}/biometric/preview`, {
      method: 'POST', headers: { authorization: `Bearer ${authToken}` }, body: file
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await preview();
  assert.equal(before.summary.matched, 1);
  assert.equal(before.summary.unmatched, 1);
  const saved = await call(authToken, 'POST', '/biometric/commit', {
    filename: 'partial.csv',
    rows: before.rows.filter(row => row.employeeId).map(row => ({ ...row, projectId: 1, workLocation: 'Site' }))
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.inserted, 1);
  const after = await preview();
  assert.equal(after.summary.unmatched, 1);
  assert.equal(after.unknownDevices[0].code, unknownCode);
  assert.equal(after.summary.duplicates, 1);
});

test('edited Excel times are audited and later imports preserve HR corrections', async () => {
  const authToken = await login();
  const code = `EDIT-TIME-${Date.now()}`;
  const date = shift(-96);
  const employee = await call(authToken, 'POST', '/biometric/people', {
    code, name: 'Import Time Review Worker', firstDate: date
  });
  assert.equal(employee.status, 201);
  const row = { employeeId: employee.body.id, code, name: employee.body.name, date,
    checkIn: '07:30:00', checkOut: '17:15:00', needsReview: false,
    correctionReason: 'Supervisor confirmed arrival and departure at site', projectId: 1, workLocation: 'Site' };
  const imported = await call(authToken, 'POST', '/biometric/commit', {
    filename: 'edited.xlsx', rows: [row]
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const day = (await call(authToken, 'GET', `/attendance?date=${date}`)).body
    .find(item => item.employeeId === employee.body.id);
  assert.ok(day);
  assert.match(day.in, /^07:30/);
  const profile = await call(authToken, 'GET', `/employees/${employee.body.id}`);
  assert.equal(profile.body.attendance.find(item => item.id === day.id).correctionReason, row.correctionReason);

  const correction = await call(authToken, 'PATCH', `/attendance/${day.id}`, {
    checkIn: '07:10', checkOut: '17:20', reason: 'Supervisor corrected the signed site register'
  });
  assert.equal(correction.status, 200);
  const register = await call(authToken, 'GET', `/hr/attendance-register?month=${date.slice(0, 7)}`);
  assert.equal(register.status, 200);
  const registerDay = register.body.rows.find(person => person.name === employee.body.name)
    ?.days[Number(date.slice(8, 10))];
  assert.equal(registerDay.id, day.id);
  assert.match(registerDay.in, /^07:10/);
  assert.equal((await call(authToken, 'PATCH', `/attendance/${day.id}`, {
    checkIn: '25:99', reason: 'Invalid clock time'
  })).status, 400);
  const repeated = await call(authToken, 'POST', '/biometric/commit', {
    filename: 'edited.xlsx',
    rows: [{ ...row, checkIn: '08:40:00', checkOut: '16:00:00', correctionReason: null }]
  });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.updated, 0);
  assert.equal(repeated.body.skipped.length, 1);
  const after = (await call(authToken, 'GET', `/attendance?date=${date}`)).body.find(item => item.id === day.id);
  assert.match(after.in, /^07:10/);
  assert.match(after.out, /^17:20/);
});

test('biometric import keeps each day at its own office, site, or non-working location', async () => {
  const token = await login();
  const code = `MIXED-LOC-${Date.now()}`;
  const start = shift(-101);
  const person = await call(token, 'POST', '/biometric/people', {
    code, name: 'Mixed Location Worker', firstDate: start
  });
  assert.equal(person.status, 201);
  const baseRow = { employeeId: person.body.id, code, name: person.body.name,
    checkIn: '08:00:00', checkOut: '17:00:00' };
  const rows = [
    { ...baseRow, date: start, workLocation: 'Office', projectId: null },
    { ...baseRow, date: shift(-100), workLocation: 'Site', projectId: 1 },
    { ...baseRow, date: shift(-99), workLocation: 'Site', projectId: 2 },
    { ...baseRow, date: shift(-98), declaredState: 'On leave', workLocation: 'Not working', projectId: null }
  ];
  const missing = await call(token, 'POST', '/biometric/commit', {
    filename: 'mixed.xlsx', rows: [{ ...rows[0], workLocation: undefined }, ...rows.slice(1)]
  });
  assert.equal(missing.status, 400);
  assert.equal((await call(token, 'GET', `/attendance?date=${start}`)).body
    .filter(item => item.employeeId === person.body.id).length, 0);
  const wrongSite = await call(token, 'POST', '/biometric/commit', {
    filename: 'mixed.xlsx', rows: [rows[0], { ...rows[1], projectId: 999999 }, ...rows.slice(2)]
  });
  assert.equal(wrongSite.status, 400);
  const saved = await call(token, 'POST', '/biometric/commit', { filename: 'mixed.xlsx', rows });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.inserted, 4);
  for (const row of rows) {
    const day = (await call(token, 'GET', `/attendance?date=${row.date}`)).body
      .find(item => item.employeeId === person.body.id);
    assert.equal(day.workLocation, row.workLocation);
    assert.equal(day.projectId, row.projectId);
  }
});

test('dated workforce locations guide a two-week biometric import without rewriting saved attendance', async () => {
  const token = await login();
  const code = `DATED-LOC-${Date.now()}`;
  const first = shift(-114), second = shift(-113);
  const person = await call(token, 'POST', '/biometric/people', { code, name: 'Dated Site Worker', firstDate: first });
  assert.equal(person.status, 201);
  const location = (from, to, workLocation, projectId) => ({ employeeId: person.body.id, from, to,
    workLocation, projectId, reason: 'Supervisor confirmed the daily site roster' });
  assert.equal((await call(token, 'POST', '/employees/work-locations', location(first, first, 'Office', null))).status, 400,
    'site workers cannot be assigned to the office');
  assert.equal((await call(token, 'POST', '/employees/work-locations', location(first, first, 'Site', 1))).status, 200);
  assert.equal((await call(token, 'POST', '/employees/work-locations', location(second, second, 'Site', 2))).status, 200);
  const planned = await call(token, 'GET', `/employees/work-locations?from=${first}&to=${second}`);
  assert.equal(planned.status, 200);
  assert.deepEqual(planned.body.filter(row => row.employeeId === person.body.id).map(row => row.projectId), [1, 2]);
  const availability = await call(token, 'GET', `/employees/availability?date=${second}`);
  assert.equal(availability.body.people.find(row => row.id === person.body.id).projectId, 2);
  const file = new FormData();
  file.append('file', new Blob([`ID,Name,Date,In,Out\n${code},Dated Site Worker,${first},08:00,17:00\n${code},Dated Site Worker,${second},08:00,17:00\n`], { type: 'text/csv' }), 'fortnight.csv');
  const response = await fetch(`${base}/biometric/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: file });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.deepEqual(preview.rows.map(row => row.plannedProjectId), [1, 2]);
  const saved = await call(token, 'POST', '/biometric/commit', { filename: 'fortnight.csv',
    rows: preview.rows.map(row => ({ ...row, workLocation: row.plannedWorkLocation, projectId: row.plannedProjectId })) });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await call(token, 'POST', '/employees/work-locations', location(first, first, 'Site', 2))).status, 200);
  const existing = (await call(token, 'GET', `/attendance?date=${first}`)).body.find(row => row.employeeId === person.body.id);
  assert.equal(existing.projectId, 1, 'changing a plan does not silently rewrite imported attendance');
});

test('workforce map distinguishes office presence, site allocation and free workers', async () => {
  const token = await login();
  const date = shift(40);
  const departments = await call(token, 'GET', '/employees/departments');
  const created = await call(token, 'POST', '/employees', {
    code: 'EMP-FREE-01', name: 'Available Test Worker', departmentId: departments.body[0]?.id,
    designation: 'General worker', workerType: 'Site', joinDate: today(),
    basicSalary: 0, dailyRate: 0, overtimeRate: 0
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.workerType, 'Site');

  const employee = (await call(token, 'GET', '/employees')).body.find(row => row.id !== created.body.id);
  await call(token, 'PATCH', `/employees/${employee.id}`, { workerType: 'Office' });
  const present = await call(token, 'POST', '/attendance', {
    name: employee.name, role: employee.designation, employeeId: employee.id,
    workLocation: 'Office', projectId: null, date, state: 'On site', checkIn: '07:45'
  });
  assert.equal(present.status, 201);
  assert.equal(present.body.workLocation, 'Office');
  assert.equal(present.body.site, 'Head office');

  const map = await call(token, 'GET', `/employees/availability?date=${date}`);
  assert.equal(map.status, 200);
  assert.equal(map.body.people.find(row => row.id === employee.id).status, 'At office');
  assert.equal(map.body.people.find(row => row.id === created.body.id).status, 'Free');
  assert.ok(map.body.summary.free >= 1);
});

test('deactivating a user ends their session', async () => {
  const owner = await login();
  /* Roles are data now, so a new account is created against a role id. */
  const roles = await call(owner, 'GET', '/users/roles');
  const viewerRole = roles.body.find(role => role.name === 'Read-Only Viewer');
  const created = await call(owner, 'POST', '/users', {
    name: 'Temporary Viewer', email: 'temp.viewer@gkuc.lk', password: 'TempPass2026!', roleId: viewerRole.id
  });
  assert.equal(created.status, 201);

  const signIn = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'temp.viewer@gkuc.lk', password: 'TempPass2026!' })
  });
  assert.equal(signIn.status, 200);
  const viewer = (await signIn.json()).token;

  assert.equal((await call(viewer, 'POST', '/projects', {
    name: 'Blocked project', client: 'X', manager: 'Y', site: 'Z', stage: 'Start', budget: 1
  })).status, 403, 'read-only roles cannot write');

  await call(owner, 'PATCH', `/users/${created.body.id}`, { active: false });
  assert.equal((await call(viewer, 'GET', '/bootstrap')).status, 401);
});

/*
 * Searching inside documents.
 *
 * Both of these were live defects. A reference is the commonest thing anybody searches for
 * and every one this company issues is hyphenated, which the full-text parser reads as a
 * string of NOT operators — so the search reliably excluded the document being looked for.
 * And an expression that parser cannot read at all, which an ordinary email address
 * produces, came back to the person as "Unexpected server error".
 */
test('a hyphenated reference is searched for as its words, not as NOT operators', async () => {
  const { searchExpression } = await import('../src/routes/uploads.js');
  assert.equal(searchExpression('QUO-2026-0042').expression, '+QUO* +2026* +0042*');
  assert.equal(searchExpression('delivery note').expression, '+delivery* +note*');
});

test('words too short for the index are dropped rather than required', async () => {
  const { searchExpression } = await import('../src/routes/uploads.js');
  assert.equal(searchExpression('EQ-RACE-6087').expression, '+RACE* +6087*');
  assert.equal(searchExpression('a b c').expression, '');
});

test('punctuation a person types never reaches the full-text parser', async () => {
  const { searchExpression } = await import('../src/routes/uploads.js');
  for (const typed of ['a@b.com', '+++', '"unclosed', '~test', 'ref (2026)', '>>>']) {
    const words = searchExpression(typed).expression.split(' ').filter(Boolean);
    for (const word of words) {
      assert.match(word, /^\+[\p{L}\p{N}]+\*$/u, `${typed} produced an unsafe term: ${word}`);
    }
  }
});

test('a document is found by the reference printed on it', async () => {
  const token = await login();
  const project = await call(token, 'POST', '/projects', {
    name: 'Search Regression Site', client: 'Search Client', manager: 'Kasun Perera',
    site: 'Colombo', stage: 'Testing', budget: 1000000, progress: 0, health: 'On track'
  });
  assert.equal(project.status, 201);

  const form = new FormData();
  form.append('file', new Blob(['Order reference QQX-4417-ZP for 20mm aggregate'],
    { type: 'text/plain' }), 'delivery-note.txt');
  const upload = await fetch(`${base}/uploads/project/${project.body.id}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form
  });
  assert.equal(upload.status, 201);

  /* The reader runs in the background, so the text arrives a moment after the upload. */
  let found = [];
  for (let attempt = 0; attempt < 20 && !found.length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const search = await call(token, 'GET', '/uploads/search/documents?q=QQX-4417-ZP');
    found = search.body.results || [];
  }
  assert.equal(found.length, 1, 'the hyphenated reference should find the document');
  assert.equal(found[0].filename, 'delivery-note.txt');
});
