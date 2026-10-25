import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';
import { writeWorkbook } from '../src/lib/xlsx-write.js';

const port = 43971;
const base = `http://${process.env.GKUC_TEST_HOST || '127.0.0.1'}:${port}/api`;
const testDatabase = 'gkuc_siteops_test';
let server;
let serverOutput = '';
let admin;
let testUploadDir;
let lastOwnerToken;
let lastFinanceToken;

const today = () => new Date().toISOString().slice(0, 10);
const shift = days => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

test('full supplied biometric report imports and reimports without name collisions', {
  skip: !process.env.GKUC_BIOMETRIC_REPORT_PATH
}, async () => {
  const { parseBiometricFile } = await import('../src/lib/biometric.js');
  const source = parseBiometricFile({ filename: 'All Report.xls', buffer: await readFile(process.env.GKUC_BIOMETRIC_REPORT_PATH) });
  assert.ok(source.rows.length);
  const owner = await login();
  const stamp = Date.now();
  const codes = new Map();
  for (const row of source.rows) {
    if (codes.has(row.code)) continue;
    const code = `REAL${stamp}-${row.code}`;
    const person = await call(owner, 'POST', '/biometric/people', { code, name: row.name, firstDate: source.period.from });
    assert.equal(person.status, 201, JSON.stringify(person.body));
    assert.equal((await call(owner,'PATCH',`/employees/${person.body.id}`,{dailyRate:3200})).status,200);
    codes.set(row.code, { code, id: person.body.id });
  }
  const rows = source.rows.map(row => ({ ...row, code: codes.get(row.code).code }));
  const first = await call(owner, 'POST', '/biometric/commit', { filename: 'All Report.xls', rows });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.inserted, source.rows.length);
  const again = await call(owner, 'POST', '/biometric/commit', { filename: 'All Report.xls', rows });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.updated, source.rows.length);
  const ids = [...codes.values()].map(person => person.id);
  const [[stored]] = await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.attendance WHERE employee_id IN (${ids.map(() => '?').join(',')})`, ids);
  assert.equal(Number(stored.count), source.rows.length);
  const run = await call(owner, 'POST', '/payroll', {
    companyId: 1, periodStart: source.period.from, periodEnd: source.period.to, payFrequency: 'Monthly'
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const detail = (await call(owner, 'GET', `/payroll/${run.body.id}`)).body;
  for (const [originalCode, person] of codes) {
    const expectedDays = source.rows.filter(row => row.code === originalCode
      && (row.checkIn || row.checkOut || row.declaredState === 'Business trip')).length;
    const slip = detail.payslips.find(row => row.employeeCode === `BIO-${person.code}`);
    assert.ok(slip, `Payslip for scanner ${originalCode}`);
    assert.equal(Number(slip.daysPresent), expectedDays, `Scanner ${originalCode} must only receive its own attendance`);
  }
});

test('attendance identity migration replaces the legacy key without changing stored records', async () => {
  const { migrateAttendanceIdentity } = await import('../src/lib/attendance-identity.js');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: testDatabase
  });
  try {
    const [before] = await connection.query('SELECT * FROM attendance ORDER BY id');
    await connection.query(`ALTER TABLE attendance ADD INDEX migration_employee_lookup (employee_id),
      DROP INDEX uq_attendance_employee_day, ADD UNIQUE KEY uq_employee_day (employee_name,work_date)`);
    const run = async (sql, params = []) => (await connection.query(sql, params))[0];
    await migrateAttendanceIdentity(run);
    await migrateAttendanceIdentity(run);
    const [after] = await connection.query('SELECT * FROM attendance ORDER BY id');
    assert.deepEqual(after, before);
    const [indexes] = await connection.query('SHOW INDEX FROM attendance');
    assert.ok(!indexes.some(row => row.Key_name === 'uq_employee_day'));
    assert.deepEqual(indexes.filter(row => row.Key_name === 'uq_attendance_employee_day')
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name), ['employee_id', 'work_date']);
  } finally { await connection.end(); }
});

test('existing employee OT migration archives overrides without altering business history', async () => {
  const {migrateEmployeeOtRates} = await import('../src/lib/employee-ot-migration.js');
  const connection = await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:testDatabase});
  try {
    const owner = await login();
    const created = await call(owner,'POST','/employees',{code:`OT-MIG-${Date.now()}`,name:'OT Migration Existing Employee',
      payrollCategory:'Custom',dailyRate:3200,basicSalary:50000});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const id=created.body.id;
    const ownerId=(await call(owner,'GET','/auth/me')).body.user.id;
    const [run]=await connection.query(`INSERT INTO payroll_runs
      (reference,period_start,period_end,total,status,created_by) VALUES (?,'1998-01-01','1998-01-01',3560,'Paid',?)`,
      [`OT-MIG-HISTORY-${id}`,ownerId]);
    await connection.query(`INSERT INTO payslips(run_id,employee_id,basic,overtime_pay,net_pay,employer_cost)
      VALUES (?,?,3200,360,3560,3560)`,[run.insertId,id]);
    await connection.query(`INSERT INTO overtime_records(employee_id,work_date,hours,rate,status)
      VALUES (?,'1998-01-01',1,360,'Approved'),(?,'1998-01-02',1,999,'Pending')`,[id,id]);
    await connection.query(`UPDATE employees SET overtime_rate=999,custom_office_ot_rate=310,
      custom_site_ot_rate=360,custom_travel_ot_rate=160,deactivated_at=NOW() WHERE id=?`,[id]);
    const [[before]]=await connection.query('SELECT * FROM employees WHERE id=?',[id]);
    const tables=['attendance','overtime_records','hr_payroll_claims','payroll_runs','payslips',
      'payslip_components','payroll_project_allocations','payroll_policies'];
    const history=new Map();
    for(const table of tables)history.set(table,(await connection.query(`SELECT * FROM ${table} ORDER BY id`))[0]);
    const preview=spawnSync(process.execPath,['src/scripts/migrate-employee-ot-rates.js'],{
      env:{...process.env,DB_NAME:testDatabase},encoding:'utf8',timeout:30000
    });
    assert.equal(preview.status,0,preview.stderr);
    assert.match(preview.stdout,/Read-only/);
    assert.match(preview.stdout,new RegExp(before.code));
    assert.deepEqual((await connection.query('SELECT * FROM employees WHERE id=?',[id]))[0][0],before);
    const dependencies={query:async(sql,params)=>(await connection.query(sql,params))[0],
      transaction:async work=>{
        await connection.beginTransaction();
        try {const result=await work(connection);await connection.commit();return result;}
        catch(error){await connection.rollback();throw error;}
      }};
    // Simulate a failure after archive/update, proving neither can commit alone.
    await assert.rejects(migrateEmployeeOtRates({...dependencies,transaction:work=>dependencies.transaction(async real=>{
      return work({query:real.query.bind(real),execute:async(sql,params)=>{
        if(sql.includes('INSERT INTO audit_logs'))throw new Error('Simulated audit failure');
        return real.execute(sql,params);
      }});
    })}),/Simulated audit failure/);
    assert.deepEqual((await connection.query('SELECT * FROM employees WHERE id=?',[id]))[0][0],before);
    assert.equal((await connection.query('SELECT * FROM employee_ot_rate_archive WHERE employee_id=?',[id]))[0].length,0);
    const result=await migrateEmployeeOtRates(dependencies);
    assert.ok(result.archivedEmployees>=1);
    const [[archive]]=await connection.query('SELECT original_values FROM employee_ot_rate_archive WHERE employee_id=?',[id]);
    const original=typeof archive.original_values==='string'?JSON.parse(archive.original_values):archive.original_values;
    assert.equal(Number(original.overtime_rate),999);
    assert.equal(Number(original.custom_site_ot_rate),360);
    const [[after]]=await connection.query('SELECT * FROM employees WHERE id=?',[id]);
    assert.deepEqual(after,{...before,overtime_rate:'0.00',custom_office_ot_rate:null,custom_site_ot_rate:null,custom_travel_ot_rate:null});
    for(const table of tables)assert.deepEqual((await connection.query(`SELECT * FROM ${table} ORDER BY id`))[0],history.get(table),`${table} unchanged`);
    assert.equal((await migrateEmployeeOtRates(dependencies)).archivedEmployees,0);
    const [[audit]]=await connection.query("SELECT COUNT(*) n FROM audit_logs WHERE entity='employee_ot_rates' AND entity_id=?",[String(id)]);
    assert.equal(Number(audit.n),1);
    await connection.query('DELETE FROM overtime_records WHERE employee_id=?',[id]);
    await connection.query('DELETE FROM payslips WHERE run_id=?',[run.insertId]);
    await connection.query('DELETE FROM payroll_runs WHERE id=?',[run.insertId]);
  } finally {await connection.end();}
});

test('biometric import keeps same-name employees separate and reimports their days safely', async () => {
  const owner = await login();
  const stamp = Date.now();
  const name = `Shared Attendance Name ${stamp}`;
  const date = shift(-30);
  const people = [];
  for (const suffix of ['A', 'B']) {
    const code = `SAME-${stamp}-${suffix}`;
    const created = await call(owner, 'POST', '/biometric/people', { code, name, firstDate: date });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await call(owner,'PATCH',`/employees/${created.body.id}`,{dailyRate:3200})).status,200);
    people.push({ id: created.body.id, code });
  }
  const rows = people.map((person, index) => ({
    code: person.code, date, checkIn: index ? '08:10:00' : '07:30:00', checkOut: '17:00:00'
  }));
  const [[empty]] = await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.attendance WHERE employee_name=?`, [name]);
  assert.equal(Number(empty.count), 0);
  const first = await call(owner, 'POST', '/biometric/commit', { rows });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.inserted, 2);
  const again = await call(owner, 'POST', '/biometric/commit', { rows });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.updated, 2);
  const [stored] = await admin.query(`SELECT employee_id,check_in FROM ${testDatabase}.attendance WHERE employee_name=? ORDER BY employee_id`, [name]);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(row => Number(row.employee_id)), people.map(person => person.id));
  assert.deepEqual(stored.map(row => row.check_in), ['07:30:00', '08:10:00']);
  for (const person of people) {
    const profile = (await call(owner, 'GET', `/employees/${person.id}`)).body;
    assert.equal(profile.attendance.length, 1, 'A same-name colleague must not appear in the employee profile');
    assert.equal(profile.attendance[0].in, person.id === people[0].id ? '07:30:00' : '08:10:00');
  }
  const register = (await call(owner, 'GET', `/hr/attendance-register?month=${date.slice(0, 7)}`)).body;
  const namesakes = register.rows.filter(row => row.name === name);
  assert.equal(namesakes.length, 2);
  assert.equal(new Set(namesakes.map(row => row.employeeId)).size, 2);
  assert.ok(namesakes.every(row => row.present === 1));
  const duplicate = await call(owner, 'POST', '/attendance', {
    employeeId: people[0].id, date, workLocation: 'Office', state: 'On site'
  });
  assert.equal(duplicate.status, 409, 'Each employee must still have only one attendance row per day');
});

test('employee deactivation hides related records, preserves stored history and revokes access', async () => {
  const owner = await login();
  const store = await login('store@gkuc.lk');
  const code = `DEACTIVATE-${Date.now()}`;
  const date = shift(-20);
  const created = await call(owner, 'POST', '/biometric/people', { code, name: 'Deactivated Employee QA', firstDate: date });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  const roles = (await call(owner, 'GET', '/users/roles')).body;
  const role = roles.find(row => row.name === 'Read-Only Viewer');
  const email = `${code.toLowerCase()}@example.com`;
  const account = await call(owner, 'POST', '/users', {
    employeeId: id, name: created.body.name, email, password: 'EmployeeAccess2026!', roleId: role.id
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  const session = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'EmployeeAccess2026!' })
  });
  assert.equal(session.status, 200);
  const employeeToken = (await session.json()).token;
  assert.equal((await call(owner, 'POST', '/biometric/commit', {
    rows: [{ code, date, checkIn: '07:30:00', checkOut: '17:00:00' }]
  })).status, 201);
  await admin.query(`INSERT INTO ${testDatabase}.leave_requests
    (employee_id,leave_type,from_date,to_date,days,reason,status) VALUES (?,'Unpaid',?,?,1,'Retained leave history','Approved')`, [id, date, date]);
  await admin.query(`INSERT INTO ${testDatabase}.overtime_records
    (employee_id,work_date,hours,rate) VALUES (?,?,1,225)`, [id, date]);
  const form = new FormData();
  form.append('file', new Blob(['Retained employee document'], { type: 'text/plain' }), 'employee-history.txt');
  const uploaded = await fetch(`${base}/uploads/employee/${id}`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form });
  assert.equal(uploaded.status, 201);
  const attachment = await uploaded.json();
  const ownerId = (await call(owner, 'GET', '/auth/me')).body.user.id;
  const [payroll] = await admin.query(`INSERT INTO ${testDatabase}.payroll_runs
    (reference,period_start,period_end,total,created_by) VALUES (?,'1999-01-01','1999-01-01',2500,?)`, [code, ownerId]);
  await admin.query(`INSERT INTO ${testDatabase}.payslips (run_id,employee_id,basic,net_pay,employer_cost) VALUES (?,?,2500,2500,2500)`, [payroll.insertId, id]);
  assert.equal((await call(store, 'POST', `/employees/${id}/deactivate`)).status, 403);
  assert.equal((await call(owner, 'GET', `/employees/${id}`)).status, 200);
  assert.equal((await call(owner, 'POST', `/employees/${id}/deactivate`)).status, 204);
  assert.equal((await call(owner, 'POST', `/employees/${id}/deactivate`)).status, 204);
  for (const suffix of ['', '/bank-account', '/conduct', '/assets', '/letters']) {
    assert.equal((await call(owner, 'GET', `/employees/${id}${suffix}`)).status, 404, suffix);
  }
  const employees = (await call(owner, 'GET', '/employees')).body;
  assert.ok(!employees.some(row => row.id === id));
  const bootstrap = (await call(owner, 'GET', '/bootstrap')).body;
  assert.ok(!bootstrap.data.employees.some(row => row.id === id));
  const attendance = (await call(owner, 'GET', `/attendance?date=${date}`)).body;
  assert.ok(!attendance.some(row => row.employeeId === id));
  const register = (await call(owner, 'GET', `/hr/attendance-register?month=${date.slice(0, 7)}`)).body;
  assert.ok(!register.rows.some(row => row.name === created.body.name));
  for (const path of ['/employees/leave/all', '/employees/overtime/all']) {
    assert.ok(!(await call(owner, 'GET', path)).body.some(row => row.employeeId === id || row.employee === created.body.name));
  }
  assert.deepEqual((await call(owner, 'GET', `/uploads/employee/${id}`)).body, []);
  assert.equal((await fetch(`${base}/uploads/file/${attachment.id}`, { headers: { authorization: `Bearer ${owner}` } })).status, 404);
  assert.equal((await call(employeeToken, 'GET', '/auth/me')).status, 401);
  const payrollDetail = (await call(owner, 'GET', `/payroll/${payroll.insertId}`)).body;
  assert.deepEqual(payrollDetail.payslips, []);
  assert.equal(Number(payrollDetail.total), 2500, 'Historical payroll totals must not change');
  const blockedImport = await call(owner, 'POST', '/biometric/commit', {
    rows: [{ code, date, checkIn: '07:30:00', checkOut: '17:00:00' }]
  });
  assert.equal(blockedImport.status, 409);
  const nextCode = `${code}-ACTIVE`;
  assert.equal((await call(owner, 'POST', '/biometric/people', { code: nextCode, name: 'Visible Employee QA', firstDate: date })).status, 201);
  const mixed = new FormData();
  mixed.append('file', new Blob([`EmployeeID,Name,Date,In,Out\n${code},Deactivated Employee QA,${date},07:30,17:00\n${nextCode},Visible Employee QA,${date},07:30,17:00\n`], { type: 'text/csv' }), 'mixed-employees.csv');
  const previewResponse = await fetch(`${base}/biometric/preview`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: mixed });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].code, nextCode);
  const [[stored]] = await admin.query(`SELECT deactivated_at FROM ${testDatabase}.employees WHERE id=?`, [id]);
  assert.ok(stored.deactivated_at);
  for (const table of ['attendance', 'leave_requests', 'overtime_records', 'payslips']) {
    const [[count]] = await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.${table} WHERE employee_id=?`, [id]);
    assert.equal(Number(count.count), 1, `${table} history must remain`);
  }
  const [[storedFile]] = await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.attachments WHERE id=?`, [attachment.id]);
  assert.equal(Number(storedFile.count), 1);
  const [[audit]] = await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.audit_logs WHERE entity='employee' AND entity_id=? AND action='DEACTIVATE'`, [String(id)]);
  assert.equal(Number(audit.count), 1);
});

test('biometric preview accepts legacy Excel uploads and reports corrupt files cleanly', async () => {
  const { default: XLSX } = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Attendance Logs'], ['Date', null, '2026-10-01 ~ 2026-10-01'],
    ['ID', null, 'LEGACY-TEST-101', null, 'Name', null, 'Legacy test employee'],
    [1], ['Thu'], ['07:30\n17:00']
  ]), 'Attendance Logs');
  const token = await login();
  const upload = async buffer => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/vnd.ms-excel' }), 'All Report.xls');
    return fetch(`${base}/biometric/preview`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form
    });
  };
  const response = await upload(XLSX.write(workbook, { bookType: 'biff8', type: 'buffer' }));
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].checkIn, '07:30:00');
  assert.equal(preview.rows[0].checkOut, '17:00:00');
  assert.equal(preview.summary.unmatched, 1);
  const invalid = await upload(Buffer.from('not an Excel workbook'));
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /Excel file could not be read/);
});

before(async () => {
  testUploadDir = await mkdtemp(path.join(os.tmpdir(), 'gkuc-api-uploads-'));
  admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.query(`CREATE DATABASE \`${testDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  server = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env: {
    ...process.env, PORT: String(port), DB_NAME: testDatabase, UPLOAD_DIR: testUploadDir,
    /* The integration suite deliberately signs in repeatedly as different roles. Keep
       production throttles intact while preventing the test runner itself from becoming
       the 121st anonymous write from one loopback address. */
    RATE_MAX_REQUESTS: '100000', RATE_MAX_WRITES: '100000'
  }, stdio: ['ignore','pipe','pipe'] });
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
  const token=(await response.json()).token;
  if(email==='owner@gkuc.lk')lastOwnerToken=token;
  if(email==='finance@gkuc.lk')lastFinanceToken=token;
  return token;
}

const call = async (token, method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

test('users can change only their own display name without changing access or employee records', async () => {
  assert.equal((await call('invalid','PATCH','/auth/me',{name:'Unauthorised'})).status,401);
  for(const email of ['owner@gkuc.lk','hr@gkuc.lk','store@gkuc.lk','supervisor@gkuc.lk','finance@gkuc.lk','qs@gkuc.lk','transport@gkuc.lk']) {
    const token=await login(email);
    const before=(await call(token,'GET','/auth/me')).body.user;
    const [employees]=await admin.query(`SELECT id,name FROM ${testDatabase}.employees ORDER BY id`);
    for(const name of ['', '   ', 'x'.repeat(121), 'Bad\u0000Name'])
      assert.equal((await call(token,'PATCH','/auth/me',{name})).status,400);
    assert.equal((await call(token,'PATCH','/auth/me',{name:'New name',id:999,role:'Managing Director'})).status,400);
    const saved=await call(token,'PATCH','/auth/me',{name:'  Display Name QA  '});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    const after=(await call(token,'GET','/auth/me')).body.user;
    assert.deepEqual(after,{...before,name:'Display Name QA'});
    const fresh=(await call(await login(email),'GET','/auth/me')).body.user;
    assert.equal(fresh.name,'Display Name QA','name survives another sign-in');
    const [unchanged]=await admin.query(`SELECT id,name FROM ${testDatabase}.employees ORDER BY id`);
    assert.deepEqual(unchanged,employees);
    assert.equal((await call(token,'PATCH','/auth/me',{name:before.name})).status,200);
  }
});

test('navigation department metadata comes from the linked employee without changing grants',async()=>{
  const token=await login('finance@gkuc.lk');
  const before=(await call(token,'GET','/auth/me')).body.user;
  const [[employee]]=await admin.query(`SELECT id,department_id FROM ${testDatabase}.employees WHERE user_id=? ORDER BY id LIMIT 1`,[before.id]);
  const [department]=await admin.query(`INSERT INTO ${testDatabase}.departments(name,description) VALUES (?,?)`,[`Navigation QA ${Date.now()}`,'Navigation department test']);
  let createdId;
  try{
    if(employee)await admin.query(`UPDATE ${testDatabase}.employees SET department_id=? WHERE id=?`,[department.insertId,employee.id]);
    else{
      const [created]=await admin.query(`INSERT INTO ${testDatabase}.employees(code,name,designation,user_id,join_date,department_id) VALUES (?,?,?,?,?,?)`,
        [`NAV-${Date.now()}`,'Navigation QA','Finance',before.id,today(),department.insertId]);createdId=created.insertId;
    }
    const after=(await call(token,'GET','/auth/me')).body.user;
    assert.match(after.department,/^Navigation QA /);
    assert.deepEqual(after.permissions,before.permissions);
    assert.equal(after.role,before.role);
    const bootstrap=(await call(token,'GET','/bootstrap')).body;
    assert.equal(bootstrap.user.department,after.department);
  }finally{
    if(employee)await admin.query(`UPDATE ${testDatabase}.employees SET department_id=? WHERE id=?`,[employee.department_id,employee.id]);
    if(createdId)await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[createdId]);
    await admin.query(`DELETE FROM ${testDatabase}.departments WHERE id=?`,[department.insertId]);
  }
});

test('dashboard missing checkouts count employees once, respect scope and clear after audited corrections',async()=>{
  const hr=await login('hr@gkuc.lk'),finance=await login('finance@gkuc.lk');
  const before=(await call(hr,'GET','/dashboard/queue?companyId=1')).body.missingCheckouts;
  const financeQueue=(await call(finance,'GET','/dashboard/queue?companyId=1')).body;
  assert.equal(financeQueue.missingCheckouts,null);
  assert.equal((await call(finance,'GET','/dashboard/missing-checkouts?companyId=1')).status,403);
  assert.equal((await call(hr,'GET','/dashboard/missing-checkouts?companyId=1&offset=-1')).status,400);
  const ids=[];
  for(const companyId of [1,2]){
    const person=await call(hr,'POST','/employees',{code:`CHECKOUT-${companyId}-${Date.now()}`,name:`Missing Checkout QA ${companyId}`,joinDate:'2020-01-01',payrollCompanyId:companyId});
    assert.equal(person.status,201,JSON.stringify(person.body));ids.push(person.body.id);
    for(const [day,state,checkIn,checkOut] of [['01','On site','07:30',null],['02','Late','07:30',null],
      ['03','Checked out','07:30','16:30'],['04','Absent',null,null],['05','Business trip','07:30',null],['06','Checked out',null,'16:30']])
      await admin.query(`INSERT INTO ${testDatabase}.attendance(employee_id,employee_name,role,work_date,state,check_in,check_out,work_location) VALUES (?,?,'Worker',?,?,?,?, 'Office')`,[person.body.id,person.body.name,`2020-01-${day}`,state,checkIn,checkOut]);
  }
  const summary=(await call(hr,'GET','/dashboard/queue?companyId=1')).body.missingCheckouts;
  assert.equal(summary.employeeCount,before.employeeCount+1);assert.equal(summary.recordCount,before.recordCount+2);
  const detail=await call(hr,'GET','/dashboard/missing-checkouts?companyId=1');
  assert.equal(detail.status,200,`${JSON.stringify(detail.body)} ${serverOutput.slice(-2500)}`);
  const rows=detail.body.records.filter(row=>Number(row.employeeId)===Number(ids[0]));
  assert.equal(rows.length,2);assert.ok(!detail.body.records.some(row=>Number(row.employeeId)===Number(ids[1])));
  for(const row of rows){
    const correction=await call(hr,'PATCH',`/attendance/${row.id}`,{state:'Checked out',checkIn:row.in,checkOut:'16:30',workDate:row.workDate,workLocation:'Office',projectId:null,reason:'Verified missing checkout with HR evidence'});
    assert.equal(correction.status,200,JSON.stringify(correction.body));
  }
  const after=(await call(hr,'GET','/dashboard/queue?companyId=1')).body.missingCheckouts;
  assert.equal(after.employeeCount,before.employeeCount);assert.equal(after.recordCount,before.recordCount);
});

test('document designer cannot be opened or changed through the API', async () => {
  const owner = await login();
  for (const [method, path] of [['GET', '/document-design'], ['PUT', '/document-design'],
    ['POST', '/document-design/preview']]) {
    const response = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify({ design: {} }) }) });
    assert.equal(response.status, 404, `${method} ${path} must not be reachable`);
  }
});

test('BOQ lines can be uncategorised and QS can maintain categories from the BOQ workflow', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const projects = await call(owner, 'GET', '/projects');
  const projectId = projects.body[0]?.id;
  assert.ok(projectId);
  const created = await call(qs, 'POST', '/boq/categories', { value: 'Test category' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const category = created.body.find(row => row.value === 'Test category');
  assert.ok(category);
  const renamed = await call(qs, 'PATCH', `/boq/categories/${category.id}`, { value: 'Test category renamed' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const boq = await call(owner, 'POST', '/boq', { projectId, title: 'Optional category test BOQ', items: [
    { description: 'Uncategorised work', unit: 'item', quantity: 2, rate: 100 },
    { category: 'Test category renamed', description: 'Categorised work', unit: 'item', quantity: 1, rate: 50 }
  ] });
  assert.equal(boq.status, 201, JSON.stringify(boq.body));
  const detail = await call(owner, 'GET', `/boq/${boq.body.id}`);
  assert.equal(detail.body.items[0].category, null);
  assert.equal(detail.body.items[1].category, 'Test category renamed');
  assert.equal(detail.body.comparison.find(row => row.category === 'Uncategorised')?.estimated, 200);
});

test('BOQ Excel upload and commit accept an empty Category cell', async () => {
  const qs = await login('qs@gkuc.lk');
  const owner = await login();
  const projects = await call(owner, 'GET', '/projects');
  const projectId = projects.body[0]?.id;
  assert.ok(projectId);
  const xlsx = writeWorkbook([{ name: 'BOQ', rows: [
    ['Category', 'Description of work', 'Unit', 'Quantity', 'Rate (LKR)', 'Amount (LKR)', 'Method statement', 'Notes'],
    ['', 'Imported uncategorised work', 'm3', 2, 125, '', '', '']
  ] }]);
  const form = new FormData();
  form.append('file', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'optional-category.xlsx');
  form.append('projectId', String(projectId));
  const uploaded = await fetch(`${base}/boq/import`, { method: 'POST', headers: { authorization: `Bearer ${qs}` }, body: form });
  const staged = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(staged));
  assert.equal(staged.problemCount, 0, JSON.stringify(staged));
  assert.equal(staged.client, projects.body[0].client);
  const clientEdit = await call(qs, 'PATCH', `/boq/imports/${staged.id}`, {
    client: 'Client name supplied by an untrusted workbook', title: staged.title
  });
  assert.equal(clientEdit.status, 200, JSON.stringify(clientEdit.body));
  assert.equal(clientEdit.body.client, projects.body[0].client);
  assert.equal(staged.items[0].category, null);
  const added = await call(qs, 'POST', `/boq/imports/${staged.id}/items`, {
    description: 'Added during review', unit: 'item', quantity: 3, rate: 10,
    afterItemId: staged.items[0].id
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.items.length, 2);
  assert.equal(added.body.items[1].description, 'Added during review');
  assert.equal(Number(added.body.total), 280);
  assert.equal((await call(qs, 'POST', `/boq/imports/${staged.id}/items`, {
    description: 'Invalid line', unit: 'item', quantity: 0, rate: 1
  })).status, 400);
  const committed = await call(qs, 'POST', `/boq/imports/${staged.id}/commit`, { projectId });
  assert.equal(committed.status, 201, JSON.stringify(committed.body));
  const detail = await call(qs, 'GET', `/boq/${committed.body.id || committed.body.boqId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.items[0].category, null);
  assert.equal(detail.body.items[1].description, 'Added during review');
  assert.equal((await call(qs, 'POST', `/boq/imports/${staged.id}/items`, {
    description: 'Too late', unit: 'item', quantity: 1, rate: 1
  })).status, 409);
});

test('Import Centre accepts a foreign BOQ workbook and creates it only after editable review', async () => {
  const owner = await login();
  const projects = await call(owner, 'GET', '/projects');
  const project = projects.body[0];
  assert.ok(project?.id);
  const xlsx = writeWorkbook([{ name: 'Consultant Estimate', rows: [
    ['External bill supplied by the consultant'],
    ['Item No', 'Particulars', 'Unit', 'Qty', 'Unit Price', 'Total'],
    ['A-1', 'Excavate drain trench', 'm3', 4, 1250, 5000],
    ['A-2', 'Concrete bedding', 'm3', 2, 3000, 6000]
  ] }]);
  const form = new FormData();
  form.append('kind', 'boqs');
  form.append('file', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'consultant-format.xlsx');
  const checkedResponse = await fetch(`${base}/import-centre/dry-check`, {
    method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form
  });
  const checked = await checkedResponse.json();
  assert.equal(checkedResponse.status, 201, JSON.stringify(checked));
  assert.equal(checked.mode, 'document-review');
  assert.equal(checked.rows.length, 2);
  const reviewed = await call(owner, 'PATCH', `/import-centre/batches/${checked.id}/review`, {
    document: { ...checked.document, title: 'Verified consultant BOQ', projectId: project.id },
    rows: checked.rows
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.counts.blocked, 0);
  const confirmed = await call(owner, 'POST', `/import-centre/batches/${checked.id}/confirm`, {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const boq = await call(owner, 'GET', `/boq/${confirmed.body.boqId}`);
  assert.equal(boq.status, 200, JSON.stringify(boq.body));
  assert.equal(boq.body.title, 'Verified consultant BOQ');
  assert.equal(boq.body.client, project.client);
  assert.equal(boq.body.items.length, 2);
});

test('BOQ document review can create its missing client and project without duplicates', async () => {
  const owner = await login();
  const suffix = Date.now();
  const xlsx = writeWorkbook([{ name: 'Priced Work', rows: [
    ['Description', 'Unit', 'Quantity', 'Rate', 'Amount'],
    ['Historical drainage work', 'm', 10, 750, 7500]
  ] }]);
  const form = new FormData();
  form.append('kind', 'boqs');
  form.append('file', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'historical-boq.xlsx');
  const response = await fetch(`${base}/import-centre/dry-check`, {
    method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form
  });
  const review = await response.json();
  assert.equal(response.status, 201, JSON.stringify(review));
  const clientName = `Imported Client ${suffix}`;
  const projectName = `Imported Project ${suffix}`;
  const saved = await call(owner, 'PATCH', `/import-centre/batches/${review.id}/review`, {
    document: { ...review.document, title: 'Historical BOQ', projectId: null, projectName,
      companyId: 1, projectSite: 'Imported site', clientId: null, clientName,
      clientType: 'Organisation', clientAddress: 'Imported after document review' },
    rows: review.rows
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const confirmed = await call(owner, 'POST', `/import-centre/batches/${review.id}/confirm`, {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const project = await call(owner, 'GET', `/projects/${confirmed.body.projectId}`);
  assert.equal(project.status, 200, JSON.stringify(project.body));
  assert.equal(project.body.name, projectName);
  assert.equal(project.body.client, clientName);
  const boq = await call(owner, 'GET', `/boq/${confirmed.body.boqId}`);
  assert.equal(boq.body.projectId, confirmed.body.projectId);
  assert.equal(boq.body.client, clientName);
});

test('only the Managing Director resets another user password and old sessions are revoked', async () => {
  const owner = await login();
  const roles = await call(owner, 'GET', '/users/roles');
  const viewer = roles.body.find(role => role.name === 'Read-Only Viewer');
  assert.ok(viewer);
  const created = await call(owner, 'POST', '/users', {
    name: 'Password Reset Check', email: 'password.reset.check@gkuc.lk', password: 'FirstKey!2026A', roleId: viewer.id
  });
  assert.equal(created.status, 201);
  const firstLogin = await call('', 'POST', '/auth/login', { email: 'password.reset.check@gkuc.lk', password: 'FirstKey!2026A' });
  assert.equal(firstLogin.status, 200);
  const limited = await call(firstLogin.body.token, 'POST', `/users/${created.body.id}/reset-password`, { password: 'SecondKey!2026B' });
  assert.equal(limited.status, 403);
  const own = await call(owner, 'POST', `/users/${(await call(owner, 'GET', '/auth/me')).body.user.id}/reset-password`, { password: 'SecondKey!2026B' });
  assert.equal(own.status, 409);
  const reset = await call(owner, 'POST', `/users/${created.body.id}/reset-password`, { password: 'SecondKey!2026B' });
  assert.equal(reset.status, 204);
  assert.equal((await call(firstLogin.body.token, 'GET', '/auth/me')).status, 401);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'password.reset.check@gkuc.lk', password: 'FirstKey!2026A' })).status, 401);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'password.reset.check@gkuc.lk', password: 'SecondKey!2026B' })).status, 200);
});

test('HR records several attendance entries atomically without duplicating an employee date', async () => {
  const owner = await login();
  const employees = await call(owner, 'GET', '/employees');
  const ids = employees.body.slice(0, 3).map(row => row.id);
  assert.equal(ids.length, 3);
  const date = '2018-04-19';
  const common = { workLocation: 'Office', projectId: null, date, informationSource: 'Other', sourceNotes: 'Batch test' };
  const first = await call(owner, 'POST', '/attendance/bulk', { ...common, entries: [
    { employeeId: ids[0], state: 'On site', checkIn: '07:30', checkOut: '16:30' },
    { employeeId: ids[1], state: 'Absent' }
  ] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.count, 2);
  const duplicate = await call(owner, 'POST', '/attendance/bulk', { ...common, entries: [
    { employeeId: ids[0], state: 'On site' }, { employeeId: ids[2], state: 'On site' }
  ] });
  assert.equal(duplicate.status, 409);
  const records = await call(owner, 'GET', `/attendance?date=${date}`);
  assert.equal(records.status, 200);
  assert.equal(records.body.filter(row => ids.includes(row.employeeId)).length, 2);
});

test('attendance accepts an employee without a designation and ignores non-workforce legacy rows in rates', async () => {
  const hr = await login('hr@gkuc.lk');
  const created = await call(hr, 'POST', '/employees', { code: 'ATT-NO-ROLE-QA', name: 'Attendance No Role QA' });
  assert.equal(created.status, 201);
  const day = today();
  const attendance = await call(hr, 'POST', '/attendance', {
    employeeId: created.body.id, name: created.body.name, role: '', projectId: 1,
    date: day, state: 'On site', checkIn: '07:00', checkOut: '17:30', informationSource: 'Other'
  });
  assert.equal(attendance.status, 201, JSON.stringify(attendance.body));
  assert.equal(attendance.body.role, 'Employee');
  const beforeLegacyRows = await call(hr, 'GET', '/attendance/analytics');
  assert.equal(beforeLegacyRows.status, 200);
  const unknownNames = Array.from({ length: 30 }, (_, index) => `Former worker ${index}`);
  for (const name of unknownNames) {
    await admin.query(`INSERT INTO ${testDatabase}.attendance
      (employee_name,role,work_location,work_date,state,source) VALUES (?,'Worker','Office',?,'On site','Manual')`, [name, day]);
  }
  const analytics = await call(hr, 'GET', '/attendance/analytics');
  assert.equal(analytics.status, 200);
  assert.ok(analytics.body.today.rate <= 100);
  assert.equal(analytics.body.today.present, beforeLegacyRows.body.today.present);
  assert.ok(analytics.body.monthly.series.every(row => row.rate <= 100));
});

test('fleet accepts an active registered employee as driver', async () => {
  const owner = await login();
  const employee = await call(owner, 'POST', '/employees', { code: 'FLEET-DRIVER-QA', name: 'Fleet Driver QA' });
  assert.equal(employee.status, 201);
  const vehicle = await call(owner, 'POST', '/fleet', {
    vehicle: 'Fleet Driver Vehicle QA', registration: `FLEET-DRIVER-${Date.now()}`,
    driverEmployeeId: employee.body.id, status: 'Assigned', renewal: 'Insurance',
    dueDate: today(), projectId: 1, odometer: 1000, serviceIntervalKm: 0, serviceIntervalMonths: 0
  });
  assert.equal(vehicle.status, 201, JSON.stringify(vehicle.body));
  assert.equal(Number(vehicle.body.driverEmployeeId), Number(employee.body.id));
  const currentAssignment = (await call(owner, 'GET', `/fleet/${vehicle.body.id}`)).body.drivers[0];
  const handover = await call(owner, 'POST', `/fleet/${vehicle.body.id}/drivers`, {
    employeeId: employee.body.id, projectId: 1, assignedOn: currentAssignment.assignedOn,
    notes: 'Registered driver regression test'
  });
  assert.equal(handover.status, 201, JSON.stringify(handover.body));
});

test('site attendance is a proposal until HR reviews it',async()=>{
  const hr=await login('hr@gkuc.lk'),site=await login('supervisor@gkuc.lk');
  const created=await call(hr,'POST','/employees',{code:`SITE-MOBILE-${Date.now()}`,name:'Site Mobile QA'});
  assert.equal(created.status,201);
  const id=created.body.id,date=shift(-2);
  assert.equal((await call(site,'POST','/attendance',{employeeId:id,projectId:1,date})).status,403);
  const submitted=await call(site,'POST','/attendance/site-submissions',{projectId:1,date,entries:[{employeeId:id,state:'On site'}]});
  assert.equal(submitted.status,201,JSON.stringify(submitted.body));
  assert.equal((await call(site,'GET','/attendance/site-submissions')).status,403);
  assert.ok(!(await call(hr,'GET',`/attendance?date=${date}`)).body.some(row=>Number(row.employeeId)===id));
  const pending=(await call(hr,'GET','/attendance/site-submissions')).body.find(row=>Number(row.employeeId)===id);
  assert.ok(pending);
  assert.equal((await call(hr,'POST',`/attendance/site-submissions/${pending.id}/review`,{decision:'Approved'})).status,200);
  assert.ok((await call(hr,'GET',`/attendance?date=${date}`)).body.some(row=>Number(row.employeeId)===id));
  assert.equal((await call(hr,'POST',`/attendance/site-submissions/${pending.id}/review`,{decision:'Approved'})).status,409);
  await admin.query(`DELETE FROM ${testDatabase}.attendance WHERE employee_id=?`,[id]);
  await admin.query(`DELETE FROM ${testDatabase}.site_attendance_submissions WHERE employee_id=?`,[id]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[id]);
});

test('HR reviewed inputs reach weekly payroll once with separate OT, allowances and reimbursement snapshots',async()=>{
  const hr=await login('hr@gkuc.lk'),owner=await login(),site=await login('supervisor@gkuc.lk');
  const employee=await call(hr,'POST','/employees',{code:'HR-INPUT-QA',name:'HR Inputs QA',joinDate:shift(60)});assert.equal(employee.status,201);
  const employeeId=employee.body.id,date=shift(60);
  assert.equal((await call(hr,'PATCH',`/payroll/settings/employees/${employeeId}`,{payBasis:'Daily rate',payFrequency:'Weekly',payrollCategory:'Site labourer',basicSalary:0,weeklyRate:0,dailyRate:2500,compensationEffectiveFrom:date,epfEligible:false,etfEligible:false,allowanceEligibility:{transport:true,longDistance:true,motorcycle:true,machine:true,specialDuty:true}})).status,200);
  const policy={effectiveFrom:date,officeOtRate:225,siteLabourSiteOtRate:200,siteLabourTravelOtRate:100,driverOtRate:225,supervisorSiteOtRate:225,supervisorTravelOtRate:100,epfEmployeeRate:8,epfEmployerRate:12,etfEmployerRate:3,hrRules:{...INITIAL_HR_RULES,fullTransportDays:20}};
  assert.equal((await call(hr,'POST','/payroll/settings/policies',policy)).status,201);
  const attendance=await call(hr,'POST','/attendance',{employeeId,name:'HR Inputs QA',role:'Labourer',projectId:1,date,state:'On site',checkIn:'07:00',checkOut:'17:30',informationSource:'Signed timesheet',sourceNotes:'QA source'});assert.equal(attendance.status,201);
  assert.equal((await call(site,'GET','/payroll/inputs')).status,403);
  const suggestions=(await call(hr,'GET','/payroll/inputs')).body.suggestions;
  assert.equal(suggestions.find(r=>r.id===attendance.body.id).suggestion.hours,1.25);
  const suggested=await call(hr,'POST',`/payroll/inputs/suggestions/${attendance.body.id}`,{hours:1.5,reason:'Checked signed record'});assert.equal(suggested.status,201);
  assert.equal((await call(hr,'POST',`/payroll/inputs/suggestions/${attendance.body.id}`,{hours:1.5,reason:'Duplicate'})).status,409);
  const ot=(await call(hr,'GET','/employees/overtime/all')).body.find(o=>o.employee==='HR Inputs QA');
  assert.equal((await call(hr,'PATCH',`/employees/overtime/${ot.id}`,{status:'Approved'})).status,200);
  const travel={employeeId,workDate:date,projectId:1,kind:'Travel',departure:'07:00',arrival:'08:00',hours:1,distance:60,source:'Signed timesheet'};
  assert.equal((await call(hr,'POST','/payroll/inputs',travel)).status,409);
  const claims=[];
  for(const body of [{...travel,departure:'18:00',arrival:'19:00'},{employeeId,workDate:shift(61),projectId:1,kind:'Mileage',approvedKm:20,source:'Signed timesheet'},{employeeId,workDate:shift(61),projectId:1,kind:'Special duty',amount:500,source:'Management instruction'}]){
    const claim=await call(hr,'POST','/payroll/inputs',body);assert.equal(claim.status,201,JSON.stringify(claim.body));claims.push(claim.body.id);
    assert.equal((await call(hr,'PATCH',`/payroll/inputs/${claim.body.id}/review`,{status:'Approved',reason:'Too early'})).status,409);
    for(const status of ['Confirmed','Approved'])assert.equal((await call(hr,'PATCH',`/payroll/inputs/${claim.body.id}/review`,{status,reason:'Reviewed by HR'})).status,200);
  }
  assert.equal((await call(hr,'POST','/payroll/inputs',{employeeId,workDate:shift(62),kind:'Mileage',startOdometer:100,endOdometer:90,source:'Other'})).status,400);
  assert.equal((await call(hr,'POST','/payroll/inputs',{employeeId,workDate:shift(62),kind:'Mileage',approvedKm:20,fixedTravel:true,source:'Other'})).status,400);
  const run=await call(hr,'POST','/payroll',{periodStart:date,periodEnd:shift(66),payFrequency:'Weekly'});assert.equal(run.status,201,JSON.stringify(run.body));
  const before=(await call(hr,'GET',`/payroll/${run.body.id}`)).body;
  const slip=before.payslips.find(p=>p.employeeCode==='HR-INPUT-QA');assert.equal(slip.basic,2500);assert.equal(slip.siteOtPay,300);assert.equal(slip.travelOtPay,100);assert.equal(slip.allowanceTotal,1000);assert.equal(slip.reimbursementTotal,340);assert.equal(slip.netPay,4240);
  for(const status of ['Approved','Paid'])assert.equal((await call(hr,'PATCH',`/payroll/${run.body.id}`,{status})).status,200);
  assert.equal((await call(hr,'PATCH',`/payroll/${run.body.id}`,{status:'Draft'})).status,409);
  assert.equal((await call(hr,'POST','/payroll/settings/policies',{...policy,effectiveFrom:shift(62),siteLabourSiteOtRate:500})).status,201);
  const after=(await call(hr,'GET',`/payroll/${run.body.id}`)).body.payslips.find(p=>p.id===slip.id);assert.equal(after.netPay,slip.netPay);assert.equal(after.siteOtPay,slip.siteOtPay);
  const [[alloc]]=await admin.query(`SELECT SUM(amount) total,COUNT(*) n FROM ${testDatabase}.payroll_project_allocations WHERE employee_id=?`,[employeeId]);assert.equal(Number(alloc.total),4240);
  const audits=(await call(owner,'GET','/audit')).body;assert.ok(audits.some(a=>a.entity==='payroll_claim'&&a.action==='APPROVED'));
  await admin.query(`DELETE FROM ${testDatabase}.payroll_project_allocations WHERE employee_id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.payslip_components WHERE payslip_id IN (SELECT id FROM ${testDatabase}.payslips WHERE run_id=?)`,[run.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.payslips WHERE run_id=?`,[run.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_runs WHERE id=?`,[run.body.id]);
  for(const table of ['hr_payroll_claims','overtime_records','attendance'])await admin.query(`DELETE FROM ${testDatabase}.${table} WHERE employee_id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_policies WHERE effective_from IN (?,?)`,[date,shift(62)]);
});

test('HR decides one supervisor site charge per day and payroll allocates it once',async()=>{
  const hr=await login('hr@gkuc.lk'),site=await login('supervisor@gkuc.lk');
  const date=shift(90);
  const employee=await call(hr,'POST','/employees',{code:'SUP-CHARGE-QA',name:'Supervisor Charge QA',joinDate:date});assert.equal(employee.status,201);
  const employeeId=employee.body.id;
  assert.equal((await call(hr,'PATCH',`/payroll/settings/employees/${employeeId}`,{payBasis:'Daily rate',payFrequency:'Weekly',payrollCategory:'Supervisor',basicSalary:0,weeklyRate:0,dailyRate:3000,compensationEffectiveFrom:date,epfEligible:false,etfEligible:false})).status,200);
  const policy={effectiveFrom:date,officeOtRate:225,siteLabourSiteOtRate:200,siteLabourTravelOtRate:100,driverOtRate:225,supervisorSiteOtRate:225,supervisorTravelOtRate:100,epfEmployeeRate:8,epfEmployerRate:12,etfEmployerRate:3,hrRules:{...INITIAL_HR_RULES,supervisorSiteCharge:575}};
  assert.equal((await call(hr,'POST','/payroll/settings/policies',policy)).status,201);
  const claim={employeeId,workDate:date,projectId:1,kind:'Supervisor site charge',siteChargeReason:'Both',source:'Signed timesheet',notes:'Visited site and mobilized labour'};
  assert.equal((await call(site,'POST','/payroll/inputs',claim)).status,403);
  assert.equal((await call(hr,'POST','/payroll/inputs',{...claim,projectId:null})).status,400);
  const preview=await call(hr,'POST','/payroll/inputs',{...claim,preview:true});assert.equal(preview.status,200);assert.equal(preview.body.calculation.amount,575);
  const saved=await call(hr,'POST','/payroll/inputs',claim);assert.equal(saved.status,201,JSON.stringify(saved.body));
  assert.notEqual((await call(hr,'POST','/payroll/inputs',{...claim,siteChargeReason:'Site visit'})).status,201);
  for(const status of ['Confirmed','Approved'])assert.equal((await call(hr,'PATCH',`/payroll/inputs/${saved.body.id}/review`,{status,reason:'Checked source evidence'})).status,200);
  const run=await call(hr,'POST','/payroll',{periodStart:date,periodEnd:shift(96),payFrequency:'Weekly'});assert.equal(run.status,201,JSON.stringify(run.body));
  const [components]=await admin.query(`SELECT pc.name,pc.amount FROM ${testDatabase}.payslip_components pc JOIN ${testDatabase}.payslips ps ON ps.id=pc.payslip_id WHERE ps.run_id=? AND ps.employee_id=? AND pc.claim_id=?`,[run.body.id,employeeId,saved.body.id]);
  assert.equal(components.length,1);assert.equal(components[0].name,'Supervisor site charge');assert.equal(Number(components[0].amount),575);
  const [allocations]=await admin.query(`SELECT amount FROM ${testDatabase}.payroll_project_allocations WHERE source_type='Claim' AND source_id=?`,[saved.body.id]);assert.equal(allocations.length,1);assert.equal(Number(allocations[0].amount),575);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_project_allocations WHERE employee_id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.payslip_components WHERE payslip_id IN (SELECT id FROM ${testDatabase}.payslips WHERE run_id=?)`,[run.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.payslips WHERE run_id=?`,[run.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_runs WHERE id=?`,[run.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.hr_payroll_claims WHERE employee_id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_policies WHERE effective_from=?`,[date]);
});

test('daily-rate worker advances cannot exceed the daily salary across multiple entries',async()=>{
  const owner=await login(),hr=await login('hr@gkuc.lk');
  const employee=await call(hr,'POST','/employees',{code:'ADV-CAP-QA',name:'Advance Cap QA'});assert.equal(employee.status,201);
  const employeeId=employee.body.id;
  assert.equal((await call(hr,'PATCH',`/payroll/settings/employees/${employeeId}`,{payBasis:'Daily rate',payFrequency:'Weekly',payrollCategory:'Site labourer',basicSalary:0,weeklyRate:0,dailyRate:2500,compensationEffectiveFrom:today(),epfEligible:false,etfEligible:false})).status,200);
  const opened=await call(owner,'POST','/receivables/petty-cash',{name:'Advance cap QA float',accountType:'Salary advance',holderName:'Finance desk',ceiling:10000,lowAt:0});assert.equal(opened.status,201);
  const path=`/receivables/petty-cash/${opened.body.id}/entries`;
  assert.equal((await call(owner,'POST',path,{kind:'Top up',amount:10000,entryDate:today(),description:'Opening advance float'})).status,201);
  for(const amount of [500,1000,1000])assert.equal((await call(owner,'POST',path,{kind:'Spend',amount,entryDate:today(),description:'Worker requested advance',employeeId})).status,201);
  const rejected=await call(owner,'POST',path,{kind:'Spend',amount:1,entryDate:today(),description:'Exceeds daily rate',employeeId});assert.equal(rejected.status,400);assert.match(rejected.body.error,/daily salary rate/i);
  assert.equal((await call(owner,'POST',path,{kind:'Spend',amount:2500,entryDate:shift(1),description:'Next day advance',employeeId})).status,201);
  await admin.query(`DELETE FROM ${testDatabase}.petty_cash_entries WHERE float_id=?`,[opened.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.petty_cash_floats WHERE id=?`,[opened.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[employeeId]);
});

test('employee offboarding is blocked by assets, vehicles and unfinished tasks until cleared',async()=>{
  const hr=await login('hr@gkuc.lk'),qs=await login('qs@gkuc.lk');
  const person=await call(hr,'POST','/employees',{code:'ASSET-QA-01',name:'Asset Clearance QA'});assert.equal(person.status,201);
  const employeeId=person.body.id;
  const handover=await call(hr,'POST',`/employees/${employeeId}/assets`,{assetName:'Company phone',assetCode:'PHONE-QA-01',category:'Phone',handedOn:today(),conditionBefore:'Good condition, no scratches'});assert.equal(handover.status,201);
  assert.equal((await call(qs,'POST',`/employees/${employeeId}/assets`,{assetName:'Phone',assetCode:'QA-X',category:'Phone',handedOn:today(),conditionBefore:'Good'})).status,403);
  assert.equal((await call(hr,'PATCH',`/employees/${employeeId}`,{status:'Left'})).status,409);
  assert.equal((await call(hr,'PATCH',`/employees/${employeeId}/assets/${handover.body.id}/return`,{returnedOn:today(),conditionReturned:'Returned in good condition'})).status,200);
  const [[task]]=await admin.query(`SELECT id FROM ${testDatabase}.tasks WHERE status NOT IN ('Completed','Approved') LIMIT 1`);
  await admin.query(`INSERT INTO ${testDatabase}.task_assignees(task_id,employee_id) VALUES(?,?)`,[task.id,employeeId]);
  assert.equal((await call(hr,'PATCH',`/employees/${employeeId}`,{status:'Left'})).status,409);
  await admin.query(`DELETE FROM ${testDatabase}.task_assignees WHERE employee_id=?`,[employeeId]);
  const [[vehicle]]=await admin.query(`SELECT id,driver_employee_id FROM ${testDatabase}.fleet LIMIT 1`);
  await admin.query(`UPDATE ${testDatabase}.fleet SET driver_employee_id=? WHERE id=?`,[employeeId,vehicle.id]);
  assert.equal((await call(hr,'PATCH',`/employees/${employeeId}`,{status:'Left'})).status,409);
  await admin.query(`UPDATE ${testDatabase}.fleet SET driver_employee_id=? WHERE id=?`,[vehicle.driver_employee_id,vehicle.id]);
  assert.equal((await call(hr,'GET',`/employees/${employeeId}/offboarding`)).body.clear,true);
  assert.equal((await call(hr,'PATCH',`/employees/${employeeId}`,{status:'Left'})).status,200);
  await admin.query(`DELETE FROM ${testDatabase}.employee_asset_handovers WHERE employee_id=?`,[employeeId]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[employeeId]);
});

test('resignation creates distinct access and payroll clearances that gate offboarding',async()=>{
  const owner=lastOwnerToken||await login();
  const hr=await login('hr@gkuc.lk');
  const qs=await login('qs@gkuc.lk');
  const employee=await call(hr,'POST','/employees',{code:`RESIGN-QA-${Date.now()}`,name:'Resignation Checklist QA'});
  assert.equal(employee.status,201);
  const id=employee.body.id;
  assert.equal((await call(qs,'POST',`/employees/${id}/offboarding/start`,{requestedOn:today(),reason:'Employee resigned'})).status,403);
  const started=await call(hr,'POST',`/employees/${id}/offboarding/start`,{requestedOn:today(),reason:'Employee resigned'});
  assert.equal(started.status,201,JSON.stringify(started.body));
  assert.equal(Boolean(started.body.offboarding),true);
  assert.equal(Boolean(started.body.clear),false);
  assert.equal((await call(hr,'PATCH',`/employees/${id}`,{status:'Left'})).status,409);
  const queue=await call(owner,'GET','/dashboard/queue?companyId=1');
  assert.equal(queue.status,200,JSON.stringify(queue.body));
  assert.ok(queue.body.work.some(item=>item.kind==='offboarding-access'&&item.title.includes('Resignation Checklist QA')));
  assert.ok(queue.body.work.some(item=>item.kind==='offboarding-payroll'&&item.title.includes('Resignation Checklist QA')));
  assert.equal((await call(qs,'PATCH',`/employees/${id}/offboarding/clearance`,{area:'access',note:'Not authorised'})).status,403);
  assert.equal((await call(hr,'PATCH',`/employees/${id}/offboarding/clearance`,{area:'access',note:'Account disabled'})).status,403);
  assert.equal((await call(owner,'PATCH',`/employees/${id}/offboarding/clearance`,{area:'access',note:'Account disabled'})).status,200);
  assert.equal((await call(hr,'PATCH',`/employees/${id}/offboarding/clearance`,{area:'payroll',note:'Final pay reconciled'})).status,200);
  assert.equal((await call(hr,'GET',`/employees/${id}/offboarding`)).body.clear,true);
  assert.equal((await call(hr,'PATCH',`/employees/${id}`,{status:'Left'})).status,200);
  await admin.query(`DELETE FROM ${testDatabase}.employee_offboarding_cases WHERE employee_id=?`,[id]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[id]);
});

test('HR insurance connects to Fleet and sends custom reminders without duplicates',async()=>{
  const hr=await login('hr@gkuc.lk'),owner=await login(),qs=await login('qs@gkuc.lk');
  assert.equal((await call(hr,'GET','/fleet')).status,200);
  assert.equal((await call(qs,'GET','/insurance')).status,403);
  const options=(await call(hr,'GET','/insurance/options')).body;
  const vehicleId=options.vehicles[0].id;
  const [oldDocs]=await admin.query(`SELECT * FROM ${testDatabase}.vehicle_documents WHERE vehicle_id=? AND doc_type='Insurance'`,[vehicleId]);
  const fleetOnlyVehicle=await call(owner,'POST','/fleet',{vehicle:'Fleet-only insurance QA',
    registration:`FLEET-INSURANCE-${Date.now()}`,status:'Available',renewal:'Insurance',dueDate:shift(60),odometer:0});
  assert.equal(fleetOnlyVehicle.status,201,JSON.stringify(fleetOnlyVehicle.body));
  const existingPolicies=(await call(hr,'GET','/insurance')).body;
  const fleetOnly=existingPolicies.find(row=>row.isFleetOnly&&Number(row.vehicle_id)===Number(fleetOnlyVehicle.body.id));
  assert.ok(fleetOnly,'a Fleet-only policy appears in HR before its details are completed');
  const recordIds=[];
  const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const body={name:'Test site cover',kind:'Work site',projectId:options.projects[0].id,insurer:'Test insurer',startDate:stamp,endDate:shift(60),expiryDate:shift(60),reminders:[{unit:'Date',date:stamp},{unit:'Date',date:stamp}]};
  try {
    const site=await call(hr,'POST','/insurance',body);assert.equal(site.status,201,JSON.stringify(site.body));recordIds.push(site.body.id);
    const employee=await call(hr,'POST','/insurance',{...body,name:'Test life cover',kind:'Employee life',projectId:null,employeeId:options.employees[0].id,reminders:[]});assert.equal(employee.status,201);recordIds.push(employee.body.id);
    const vehicleBody={...body,name:'Test motor cover',kind:'Vehicle',projectId:null,vehicleId,policyNumber:'HR-TEST-POLICY',reminders:[]};
    const vehicle=await call(hr,'POST','/insurance',vehicleBody);assert.equal(vehicle.status,201);recordIds.push(vehicle.body.id);
    assert.equal((await call(hr,'POST','/insurance',vehicleBody)).status,409);
    const fleet=(await call(hr,'GET',`/fleet/${vehicleId}`)).body;
    assert.ok(fleet.documents.some(doc=>doc.docType==='Insurance'&&doc.reference==='HR-TEST-POLICY'&&doc.expiryDate===body.expiryDate));
    assert.ok(fleet.renewals.some(doc=>doc.docType==='Insurance'&&doc.reference==='HR-TEST-POLICY'),
      'HR policy changes appear in the shared Fleet renewal history');
    for(let i=0;i<2;i++)assert.equal((await call(owner,'POST','/notifications/scan',{})).status,200);
    const [[count]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`,[`insurance:${site.body.id}:%`]);assert.equal(count.n,1);
    assert.ok((await call(hr,'GET','/notifications')).body.some(n=>n.referenceType==='insurance'&&Number(n.referenceId)===site.body.id));
    assert.equal((await call(qs,'PATCH',`/insurance/${site.body.id}`,body)).status,403);
    assert.equal((await call(hr,'PATCH',`/insurance/${site.body.id}`,{...body,notes:'Renewal requested',status:'Archived'})).status,200);
  } finally {
    for(const id of recordIds){await admin.query(`DELETE FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`,[`insurance:${id}:%`]);await admin.query(`DELETE FROM ${testDatabase}.hr_insurance WHERE id=?`,[id]);}
    await admin.query(`DELETE FROM ${testDatabase}.vehicle_documents WHERE vehicle_id=? AND doc_type='Insurance'`,[vehicleId]);
    if(oldDocs[0]){const d=oldDocs[0];await admin.query(`INSERT INTO ${testDatabase}.vehicle_documents(id,vehicle_id,doc_type,reference,expiry_date,cost) VALUES(?,?,?,?,?,?)`,[d.id,d.vehicle_id,d.doc_type,d.reference,d.expiry_date,d.cost]);}
  }
});

test('HR can edit and clear employee job descriptions; other roles cannot',async()=>{
  const hr=await login('hr@gkuc.lk'),qs=await login('qs@gkuc.lk');
  const [[employee]]=await admin.query(`SELECT id FROM ${testDatabase}.employees LIMIT 1`);
  const description='Inspect daily site work\nCoordinate materials and labour';
  assert.equal((await call(hr,'PATCH',`/employees/${employee.id}`,{jobDescription:description})).status,200);
  assert.equal((await call(hr,'GET',`/employees/${employee.id}`)).body.jobDescription,description);
  assert.equal((await call(qs,'PATCH',`/employees/${employee.id}`,{jobDescription:'Changed'})).status,403);
  assert.equal((await call(hr,'PATCH',`/employees/${employee.id}`,{jobDescription:''})).status,200);
  assert.equal((await call(hr,'GET',`/employees/${employee.id}`)).body.jobDescription,'');
});

test('birthday notifications reach HR once and stay hidden from QS',async()=>{
  const owner=await login(),hr=await login('hr@gkuc.lk'),qs=await login('qs@gkuc.lk');
  const [[employee]]=await admin.query(`SELECT id,birth_date FROM ${testDatabase}.employees WHERE status='Active' LIMIT 1`);
  const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await admin.query(`UPDATE ${testDatabase}.employees SET birth_date=? WHERE id=?`,[`1990-${stamp.slice(5)}`,employee.id]);
  try {
    for(let i=0;i<2;i++)assert.equal((await call(owner,'POST','/notifications/scan',{})).status,200);
    const [[count]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`,[`employee-birthday:${employee.id}:%`]);
    assert.equal(count.n,1);
    const hasBirthday=rows=>rows.some(row=>row.title.startsWith('Birthday today')&&Number(row.referenceId)===employee.id);
    assert.ok(hasBirthday((await call(hr,'GET','/notifications')).body));
    assert.equal(hasBirthday((await call(qs,'GET','/notifications')).body),false);
  } finally {
    await admin.query(`UPDATE ${testDatabase}.employees SET birth_date=? WHERE id=?`,[employee.birth_date,employee.id]);
    await admin.query(`DELETE FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`,[`employee-birthday:${employee.id}:%`]);
  }
});

test('company registration and HR milestone letters are issued once with immutable PDFs', async () => {
  const owner = await login(), hr = await login('hr@gkuc.lk'), qs = await login('qs@gkuc.lk');
  const original = (await call(owner, 'GET', '/company?companyId=2')).body;
  const registrationNumber = `GKRM-BR-${Date.now()}`;
  const companyPayload = { name: original.name, address: original.address, telephone: original.telephone,
    email: original.email, registrationNumber, tin: original.tin, vatNumber: original.vatNumber,
    bankDetails: original.bankDetails, vatPercent: Number(original.vatPercent) };
  let employeeId;
  try {
    const saved = await call(owner, 'PUT', '/company?companyId=2', companyPayload);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.registrationNumber, registrationNumber);
    const [[dates]] = await admin.query(`SELECT DATE_FORMAT(DATE_SUB(CURDATE(),INTERVAL 6 MONTH),'%Y-%m-%d') probation,
      DATE_FORMAT(DATE_SUB(CURDATE(),INTERVAL 1 YEAR),'%Y-%m-%d') annual FROM ${testDatabase}.companies LIMIT 1`);
    const employee = await call(hr, 'POST', '/employees', { code: `LETTER-${Date.now()}`, name: 'Letter QA Employee',
      joinDate: dates.probation, designation: 'Site Engineer', payrollCompanyId: 2 });
    assert.equal(employee.status, 201, JSON.stringify(employee.body));
    employeeId = employee.body.id;
    assert.equal((await call(qs, 'GET', `/employees/${employeeId}/letters`)).status, 403);
    const first = (await call(hr, 'GET', `/employees/${employeeId}/letters`)).body;
    assert.equal(first.find(row => row.type === 'probation').due, true);
    assert.equal(first.find(row => row.type === 'one-year').due, false);
    assert.equal((await call(hr, 'POST', `/employees/${employeeId}/letters`, { type: 'one-year', companyId: 2 })).status, 400);
    const preview = await fetch(`${base}/employees/${employeeId}/letters/probation/document?companyId=2`,
      { headers: { authorization: `Bearer ${hr}` } });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /DRAFT - NOT ISSUED/);
    for (let i = 0; i < 2; i++) assert.equal((await call(owner, 'POST', '/notifications/scan', {})).status, 200);
    const [[noticeCount]] = await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.notifications
      WHERE dedupe_key LIKE ?`, [`employee-letter:${employeeId}:probation:%`]);
    assert.equal(noticeCount.n, 1);
    const issued = await call(hr, 'POST', `/employees/${employeeId}/letters`, { type: 'probation', companyId: 2 });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal((await call(hr, 'POST', `/employees/${employeeId}/letters`, { type: 'probation', companyId: 2 })).status, 409);
    const issuedPath = `/employees/${employeeId}/letters/probation/document`;
    const issuedDocument = await fetch(base + issuedPath, { headers: { authorization: `Bearer ${hr}` } });
    const issuedHtml = await issuedDocument.text();
    assert.equal(issuedDocument.status, 200);
    assert.match(issuedHtml, new RegExp(registrationNumber));
    assert.doesNotMatch(issuedHtml, /DRAFT - NOT ISSUED/);
    const ticket = await call(hr, 'POST', '/document-download-tickets', { path: `${issuedPath}?download=pdf` });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const pdf = await fetch(`http://127.0.0.1:${port}${ticket.body.url}`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await call(qs, 'GET', issuedPath)).status, 403);
    assert.equal((await call(hr, 'PATCH', `/employees/${employeeId}`, { name: 'Renamed Later' })).status, 200);
    const afterEdit = await fetch(base + issuedPath, { headers: { authorization: `Bearer ${hr}` } });
    assert.equal(await afterEdit.text(), issuedHtml);
    await admin.query(`UPDATE ${testDatabase}.employees SET join_date=? WHERE id=?`, [dates.annual, employeeId]);
    assert.equal((await call(hr, 'POST', `/employees/${employeeId}/letters`, { type: 'one-year', companyId: 2 })).status, 201);
    const records = (await call(hr, 'GET', `/employees/${employeeId}/letters`)).body;
    assert.equal(records.filter(row => row.issued).length, 2);
  } finally {
    if (employeeId) {
      await admin.query(`DELETE FROM ${testDatabase}.employee_letters WHERE employee_id=?`, [employeeId]);
      await admin.query(`DELETE FROM ${testDatabase}.notifications WHERE dedupe_key LIKE ?`, [`employee-letter:${employeeId}:%`]);
      await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`, [employeeId]);
    }
    await call(owner, 'PUT', '/company?companyId=2', { ...companyPayload, registrationNumber: original.registrationNumber || '' });
  }
});

test('hiring tracks interviews and converts selected candidates once with optional protected access',async()=>{
  const owner=await login();
  const candidate=await call(owner,'POST','/hiring',{name:'Hiring Test Candidate',phone:'0710000000',address:'Test address',email:'hiring.test@gkuc.lk',position:'Engineer'});
  assert.equal(candidate.status,201);
  const id=candidate.body.id;
  const interview=await call(owner,'POST',`/hiring/${id}/interviews`,{scheduledAt:'2027-01-05T10:00',interviewer:'HR Test',location:'Office'});
  assert.equal(interview.status,201);
  assert.equal((await call(owner,'PATCH',`/hiring/${id}/interviews/${interview.body.id}`,{scheduledAt:'2027-01-05T10:00',interviewer:'HR Test',status:'Completed',notes:'Recommended for selection.'})).status,200);
  const hiring={code:'HIRING-TEST',startDate:'2027-01-10',workerType:'Office',companyId:1};
  assert.equal((await call(owner,'POST',`/hiring/${id}/hire`,hiring)).status,409);
  await call(owner,'PATCH',`/hiring/${id}`,{status:'Selected',decisionNotes:'Approved after interview.'});
  const hired=await call(owner,'POST',`/hiring/${id}/hire`,hiring);
  assert.equal(hired.status,201);
  assert.equal(hired.body.userId,null);
  assert.equal((await call(owner,'POST',`/hiring/${id}/hire`,hiring)).status,409);
  const candidateWithAccess=await call(owner,'POST','/hiring',{name:'Hiring Access Test',email:'hiring.access.test@gkuc.lk'});
  await call(owner,'PATCH',`/hiring/${candidateWithAccess.body.id}`,{status:'Selected'});
  const roles=await call(owner,'GET','/hiring/roles');
  const role=roles.body.find(r=>r.name==='Read-Only Viewer');
  const withAccess=await call(owner,'POST',`/hiring/${candidateWithAccess.body.id}/hire`,{...hiring,code:'HIRING-ACCESS',createAccess:true,roleId:role.id,password:'AccessCheck!2026'});
  assert.equal(withAccess.status,201);
  assert.ok(withAccess.body.userId);
  const readOnly=await call('', 'POST','/auth/login',{email:'hiring.access.test@gkuc.lk',password:'AccessCheck!2026'});
  assert.equal(readOnly.status,200);
  assert.equal((await call(readOnly.body.token,'GET','/hiring')).status,403);
  await admin.query(`DELETE FROM ${testDatabase}.hiring_candidates WHERE id IN (?,?)`,[id,candidateWithAccess.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id IN (?,?)`,[hired.body.employeeId,withAccess.body.employeeId]);
  await call(owner,'PATCH',`/users/${withAccess.body.userId}`,{active:false});
});

test('custom feature permission grants template CRUD without granting HR, finance or administration', async () => {
  const owner=await login();
  const role=await call(owner,'POST','/access/roles',{name:'Feature Guard Test',permissions:['qs.view','qs.templates']});
  assert.equal(role.status,201);
  const user=await call(owner,'POST','/users',{name:'Feature Guard Test',email:'feature.guard.test@gkuc.lk',password:'AccessCheck!2026',roleId:role.body.id});
  assert.equal(user.status,201);
  const signedIn=await call('', 'POST','/auth/login',{email:'feature.guard.test@gkuc.lk',password:'AccessCheck!2026'});
  assert.equal(signedIn.status,200);
  const limited=signedIn.body.token;
  const note=await call(limited,'POST','/qs/quotation-note-templates',{name:'Feature guard test note',body:'Temporary note for permission verification.'});
  assert.equal(note.status,201);
  assert.equal((await call(limited,'PATCH',`/qs/quotation-note-templates/${note.body.id}`,{name:'Feature guard test note',body:'Updated test note.'})).status,200);
  for(const [method,path] of [['POST','/employees'],['PATCH','/employees/1'],['DELETE','/clients/1'],['POST','/receivables/invoices'],['GET','/access/permissions'],['GET','/payroll/settings'],['GET','/employees/1/conduct']]){
    assert.equal((await call(limited,method,path,method==='GET'?undefined:{})).status,403,`${method} ${path}`);
  }
  assert.equal((await call(owner,'PATCH',`/access/roles/${role.body.id}/permissions`,{permission:'qs.templates',granted:false})).status,200);
  assert.equal((await call(limited,'POST','/qs/quotation-note-templates',{name:'Forbidden note',body:'This should not be saved.'})).status,403);
  await admin.query(`DELETE FROM ${testDatabase}.quotation_note_templates WHERE id=?`,[note.body.id]);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE user_id=?`,[user.body.id]);
  await call(owner,'PATCH',`/users/${user.body.id}`,{active:false});
});

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
  const offence=await call(owner,'POST',`/employees/${id}/conduct`,{kind:'Offence',recordDate:today(),description:'Safety procedure not followed.'});
  assert.equal(offence.status,201);
  const recognition=await call(owner,'POST',`/employees/${id}/conduct`,{kind:'Good rating',recordDate:today(),description:'Excellent teamwork and timely delivery.',rating:5});
  assert.equal(recognition.status,201);
  const conduct=await call(owner,'GET',`/employees/${id}/conduct`);
  assert.equal(conduct.body.length,2);
  assert.equal(conduct.body[0].rating,5);
  assert.ok(conduct.body[0].recordedBy);
  assert.equal((await call(owner,'POST',`/employees/${id}/conduct`,{kind:'Offence',recordDate:today(),description:'Invalid rating',rating:4})).status,400);
  const missingStart=await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Paid',fromDate:'2027-01-01',toDate:'2027-01-01',reason:'Missing start date test'});
  assert.equal(missingStart.status,409);
  await call(owner,'PATCH',`/employees/${id}`,{joinDate:'2026-08-31'});
  const tooEarly=await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Paid',fromDate:'2027-02-27',toDate:'2027-02-27',reason:'Six months test'});
  assert.equal(tooEarly.status,409);
  const eligible=await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Paid',fromDate:'2027-02-28',toDate:'2027-02-28',reason:'Six month anniversary test'});
  assert.equal(eligible.status,201);
  await call(owner,'PATCH',`/employees/leave/${eligible.body.id}`,{status:'Rejected'});
  const earlyUnpaid = await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Unpaid',fromDate:'2027-01-01',toDate:'2027-01-01',reason:'Waiting period test'});
  assert.equal(earlyUnpaid.status,409);
  const leave = await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Unpaid',fromDate:'2027-03-01',toDate:'2027-03-05',reason:'Monthly leave test'});
  assert.equal(leave.status,201);
  const excess=await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType:'Paid',fromDate:'2027-03-06',toDate:'2027-03-06',reason:'Over monthly allowance test'});
  assert.equal(excess.status,409);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[id]);
});

test('HR previews, corrects and atomically imports employees from Excel', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const forbidden = await fetch(`${base}/employees/import/template`, { headers: { authorization: `Bearer ${qs}` } });
  assert.equal(forbidden.status, 403);

  const template = await fetch(`${base}/employees/import/template`, { headers: { authorization: `Bearer ${owner}` } });
  assert.equal(template.status, 200);
  assert.match(template.headers.get('content-type'), /spreadsheetml/);

  const suffix = Date.now();
  const xlsx = writeWorkbook([{ name: 'Employees', rows: [
    ['Employee code *', 'Full name *', 'Employment start date *', 'Employee type', 'Employment classification',
      'Pay basis', 'Payment frequency', 'Payroll category', 'Daily rate (LKR)', 'EPF eligible', 'ETF eligible'],
    [`BULK-${suffix}-1`, 'Name to correct', '2018-03-12', 'Site', 'Permanent', 'Daily rate', 'Monthly', 'Site labourer', 3250, 'Yes', 'Yes'],
    [`BULK-${suffix}-2`, 'Historical Employee Two', '2014-07-01', 'Office', 'Contract', 'Monthly salary', 'Monthly', 'Office employee', 0, 'No', 'No']
  ] }]);
  const form = new FormData();
  form.append('file', new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'employees.xlsx');
  const response = await fetch(`${base}/employees/import/preview`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form });
  const preview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(preview));
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.counts.blocked, 0, JSON.stringify(preview));
  assert.equal(preview.rows[0].data.joinDate, '2018-03-12');

  preview.rows[0].data.name = 'Corrected Historical Employee';
  const confirmed = await call(owner, 'POST', '/employees/import/confirm', { rows: preview.rows });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.created, 2);
  const employees = await call(owner, 'GET', '/employees');
  const imported = employees.body.filter(row => row.code.startsWith(`BULK-${suffix}`));
  assert.equal(imported.length, 2);
  assert.equal(imported.find(row => row.code.endsWith('-1')).name, 'Corrected Historical Employee');
  assert.equal(imported.find(row => row.code.endsWith('-1')).joinDate, '2018-03-12');

  const duplicate = await call(owner, 'POST', '/employees/import/confirm', { rows: preview.rows });
  assert.equal(duplicate.status, 422);
  assert.match(duplicate.body.error, /Correct/);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE code LIKE ?`, [`BULK-${suffix}-%`]);
});

test('existing accounts can relink and unlink employees without deleting either record', async () => {
  const owner = await login();
  const roles = await call(owner, 'GET', '/users/roles');
  const created = await call(owner, 'POST', '/users', { name: 'Relink Account', email: 'relink.account@gkuc.lk', password: 'TempPass2026!', roleId: roles.body[0].id });
  assert.equal(created.status, 201);
  const userId = created.body.id;
  const original = created.body.employeeId;
  const [insert] = await admin.query(`INSERT INTO ${testDatabase}.employees(code,name,designation,join_date,daily_rate) VALUES ('RELINK-TEST','Existing HR Profile','Officer','2026-01-01',1600)`);
  const target = insert.insertId;
  const path = `/users/${userId}/employee-link`;
  const site = await login('store@gkuc.lk');
  assert.equal((await call(site, 'GET', '/users/employee-links')).status, 403);
  assert.equal((await call(site, 'PUT', path, { employeeId: target, previousEmployeeIds: [original], reason: 'Unauthorized change' })).status, 403);
  const change = (employeeId, previousEmployeeIds) => call(owner, 'PUT', path, { employeeId, previousEmployeeIds, reason: 'Correct employee identity' });
  assert.equal((await change(target, [])).status, 409);
  assert.equal((await change(target, [original])).status, 200);
  const [profiles] = await admin.query(`SELECT id,user_id,daily_rate FROM ${testDatabase}.employees WHERE id IN (?,?) ORDER BY id`, [original,target]);
  assert.equal(profiles.length, 2);
  assert.equal(profiles.find(row => Number(row.id) === Number(original)).user_id, null);
  assert.equal(Number(profiles.find(row => Number(row.id) === Number(target)).user_id), Number(userId));
  assert.equal(Number(profiles.find(row => Number(row.id) === Number(target)).daily_rate), 1600);
  const other = await call(owner, 'POST', '/users', { name: 'Other Relink Account', email: 'other.relink@gkuc.lk', password: 'TempPass2026!', roleId: roles.body[0].id });
  assert.equal((await call(owner, 'PUT', `/users/${other.body.id}/employee-link`, { employeeId: target, previousEmployeeIds: [other.body.employeeId], reason: 'Attempt occupied profile' })).status, 409);
  assert.equal((await change(null, [target])).status, 200);
  const [accounts] = await admin.query(`SELECT id FROM ${testDatabase}.users WHERE id=?`, [userId]);
  assert.equal(accounts.length, 1);
  const [logs] = await admin.query(`SELECT id FROM ${testDatabase}.audit_logs WHERE entity='user_employee_link' AND entity_id=?`, [userId]);
  assert.equal(logs.length, 2);
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
  assert.ok(body.data.projects.length >= 3, 'seed projects remain available after earlier tests add projects');
  assert.equal(body.data.tasks.length, 5);
  assert.ok(body.data.employees.length >= 8, 'seed employees remain available after earlier tests add staff');
  assert.ok(body.data.employees.some(employee => employee.code === 'ATT-NO-ROLE-QA'));
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

  const finance = await login('finance@gkuc.lk');
  const invoice = await call(finance, 'POST', '/purchasing/invoices', {
    companyId: 1, orderId: order.body.id, supplierId: 1,
    invoiceNo: `MATCH-${Date.now()}`, amount: 250000, invoiceDate: today()
  });
  assert.equal(invoice.status, 201);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${invoice.body.id}/verify`, {})).status, 403,
    'the invoice creator cannot verify their own three-way match');
  assert.equal((await call(owner, 'POST', `/purchasing/invoices/${invoice.body.id}/verify`, {})).status, 200);
  const verifiedOrder = await call(owner, 'GET', `/purchasing/orders/${order.body.id}`);
  assert.ok(verifiedOrder.body.invoices.some(row => row.id === invoice.body.id && row.verifiedAt));
  const supplierStatement = await call(owner, 'GET', '/purchasing/suppliers/1/statement?companyId=1');
  assert.equal(supplierStatement.status, 200, JSON.stringify(supplierStatement.body));
  assert.ok(supplierStatement.body.rows.some(row => row.type === 'Delivery' && row.material === 'Portland cement 50kg'
    && Number(row.quantity) === 100 && Number(row.rate) === 2500 && row.project));
  assert.ok(supplierStatement.body.rows.some(row => row.type === 'Invoice' && row.invoiceNo === invoice.body.invoice_no));
  const statementDebits = supplierStatement.body.rows.reduce((sum,row)=>sum+Number(row.debit||0),0);
  const statementCredits = supplierStatement.body.rows.reduce((sum,row)=>sum+Number(row.credit||0),0);
  assert.equal(Number(supplierStatement.body.summary.outstanding), statementDebits-statementCredits);

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
  const secondIssue = await call(store, 'POST', '/materials/1/movements', { type: 'Issue', quantity: 5, projectId: 1, reference: 'SECOND-ISSUE' });
  assert.equal(secondIssue.status, 201);
  const [linkedCosts] = await admin.query(`SELECT e.origin_id,sm.material_id,sm.quantity,sm.reference
    FROM \`${testDatabase}\`.expenses e JOIN \`${testDatabase}\`.stock_movements sm ON sm.id=CAST(e.origin_id AS UNSIGNED)
    WHERE e.origin_type='stock_movement' AND sm.material_id=1 AND sm.project_id=1 ORDER BY e.id DESC LIMIT 2`);
  assert.equal(linkedCosts.length, 2, 'each issue has its own linked cost');
  assert.notEqual(linkedCosts[0].origin_id, linkedCosts[1].origin_id);
  assert.equal(linkedCosts[0].reference, 'SECOND-ISSUE');
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
  assert.equal((await call(owner,'POST','/qs/subcontractor-rates',{projectId,subcontractorId:subcontractor.body.id,
    workItem:'Membrane installation',unit:'m2',rate:850,agreedOn:today()})).status,409);
  assert.equal((await call(owner,'POST',`/projects/${projectId}/award`,{awardDate:today(),reference:'AWARD-QA-100'})).status,201);
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
  assert.equal((await call(owner,'PATCH',`/qs/quotations/${quote.body.id}`,{status:'Accepted'})).status,200);
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
  const ticket = await call(owner, 'POST', '/document-download-tickets', {
    path: `/qs/quotations/${quote.body.id}/document?download=pdf`
  });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  const tampered = await fetch(`http://127.0.0.1:${port}${ticket.body.url.replace(`/quotations/${quote.body.id}/`, '/quotations/999999/')}`);
  assert.equal(tampered.status, 401);
  const ticketedPdfResponse = await fetch(`http://127.0.0.1:${port}${ticket.body.url}`);
  assert.equal(ticketedPdfResponse.status, 200);
  assert.match(ticketedPdfResponse.headers.get('content-type'), /^application\/pdf/);
  assert.match(ticketedPdfResponse.headers.get('content-disposition'), /^attachment;/);
  const ticketedPdf = Buffer.from(await ticketedPdfResponse.arrayBuffer());
  assert.equal(ticketedPdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(ticketedPdf.subarray(-1024).toString().includes('startxref'));
  const inspected = spawnSync('pdfinfo', ['-'], { input: ticketedPdf });
  if (!inspected.error) assert.equal(inspected.status, 0, inspected.stderr.toString());
  assert.equal((await fetch(`http://127.0.0.1:${port}${ticket.body.url}`)).status, 401);
  assert.equal((await call(owner, 'POST', '/document-download-tickets', {
    path: 'https://outside.example/qs/quotations/1/document?download=pdf'
  })).status, 400);
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
  const invoiceTicket = await call(owner, 'POST', '/document-download-tickets', {
    path: `/receivables/invoices/${invoice.body.id}/document?download=pdf`
  });
  assert.equal(invoiceTicket.status, 200);
  const invoiceTicketResponse = await fetch(`http://127.0.0.1:${port}${invoiceTicket.body.url}`);
  assert.equal(invoiceTicketResponse.status, 200);
  assert.equal(Buffer.from(await invoiceTicketResponse.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
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

test('client consultation agency is separate from billing client and contact logs identify the party', async () => {
  const owner = await login();
  const client = await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Consultant Client ${Date.now()}`,
    contactPerson: 'Client manager', phone: '0771111111',
    consultantAgencyName: 'Example Consulting', consultantContactPerson: 'Consultant engineer',
    consultantPhone: '0772222222', consultantEmail: 'engineer@example.lk',
    preferredContact: 'Agency'
  });
  assert.equal(client.status, 201, JSON.stringify(client.body));
  assert.equal(client.body.preferredContact, 'Agency');
  const inquiry = await call(owner, 'POST', '/inquiries', {
    companyId: 1, clientId: client.body.id, location: 'Colombo', description: 'Construction proposal', expectedValue: 1000
  });
  assert.equal(inquiry.status, 201, JSON.stringify(inquiry.body));
  assert.equal(inquiry.body.contact, 'Consultant engineer');
  assert.equal(inquiry.body.phone, '0772222222');
  const routing = await call(owner, 'GET', `/inquiries/${inquiry.body.id}/contact-routing`);
  assert.equal(routing.body.consultantAgencyName, 'Example Consulting');
  const logged = await call(owner, 'POST', `/inquiries/${inquiry.body.id}/communications`, {
    direction: 'Outgoing', channel: 'Call', contactParty: 'Agency',
    contactPerson: 'Consultant engineer', summary: 'Discussed drawings'
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.equal(logged.body.contactParty, 'Agency');
  const profile = await call(owner, 'GET', `/clients/${client.body.id}`);
  assert.equal(profile.body.consultantPhone, '0772222222');
  assert.equal(profile.body.communications[0].contactParty, 'Agency');
  const withoutAgency = await call(owner, 'PATCH', `/clients/${client.body.id}`, { consultantAgencyName: null });
  assert.equal(withoutAgency.status, 400);
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
  assert.match(html, /<th class="ref">Item \/ surfacing<\/th>/);
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
  assert.equal((await call(owner, 'PATCH', `/qs/quotations/${quotation.body.id}`, { status: 'Accepted' })).status, 200);
  assert.equal((await call(qs, 'PATCH', `/qs/quotations/${quotation.body.id}`, { visibility })).status, 409);
  const acceptedProject = await call(owner, 'GET', `/projects/${project.body.id}`);
  assert.equal(Number(acceptedProject.body.budget), 51920);
});

test('finance numbering continues existing series and preserves payment records', async () => {
  const finance=await login('finance@gkuc.lk'),owner=await login(),site=await login('store@gkuc.lk');
  const client=await call(owner,'POST','/clients',{type:'Organisation',name:'Numbering Test Client',contactPerson:'Accounts'});
  assert.equal(client.status,201,JSON.stringify(client.body));
  const clients={body:[client.body]};
  const settings={companyId:1,format:'TEST-INV/{YYYY}/{N}',padding:5,nextValue:145,reason:'Continue previously issued documents'};
  assert.equal((await call(site,'PUT','/document-numbering/INV',settings)).status,403);
  assert.equal((await call(finance,'PUT','/document-numbering/INV',settings)).status,200);
  assert.equal((await call(finance,'PUT','/document-numbering/RCPT',{...settings,format:'TEST-R/{N}',nextValue:77})).status,200);
  assert.equal((await call(finance,'PUT','/document-numbering/INV',{...settings,format:'BAD/{N}/{N}'})).status,400);
  assert.equal((await call(finance,'PUT','/document-numbering/QUO',{...settings,format:'TEST-Q/{N}',nextValue:200})).status,200);
  const quote=await call(owner,'POST','/qs/quotations/manual',{companyId:1,clientId:clients.body[0].id,title:'Numbering quotation',quoteDate:today(),markupPercent:0,vatPercent:0,lines:[{category:'Work',description:'Numbering work',unit:'item',quantity:1,rate:1000}]});
  assert.equal(quote.status,201,JSON.stringify(quote.body));
  assert.equal(quote.body.reference,'TEST-Q/00200');
  assert.equal((await call(finance,'POST',`/qs/quotations/${quote.body.id}/finalize`,{})).status,200);
  assert.equal((await call(owner,'PATCH',`/qs/quotations/${quote.body.id}`,{status:'Accepted'})).status,200);
  const plan=await call(finance,'POST','/receivables/quotation-plans',{quotationId:quote.body.id,documentType:'Invoice',taxTreatment:'Exempt',vatRate:0,terms:[{label:'Full payment',percentage:100}]});
  assert.equal(plan.status,201,JSON.stringify(plan.body));
  const plans=await call(finance,'GET','/receivables/quotation-plans?companyId=1');
  const term=plans.body.find(item=>item.id===plan.body.id).terms[0];
  const converted=await call(finance,'POST',`/receivables/quotation-terms/${term.id}/invoice`,{invoiceDate:today(),reuseQuotationNumber:true});
  assert.equal(converted.status,201,JSON.stringify(converted.body));
  assert.equal(converted.body.reference,quote.body.reference);
  const body={companyId:1,clientId:clients.body[0].id,kind:'Other',title:'Numbering invoice',documentType:'Invoice',taxTreatment:'Exempt',invoiceDate:today(),items:[{description:'Services',quantity:1,rate:1000}]};
  const invoice=await call(finance,'POST','/receivables/invoices',body);
  assert.equal(invoice.status,201,JSON.stringify(invoice.body));
  assert.equal(invoice.body.reference,`TEST-INV/${new Date().getFullYear()}/00145`);
  const renamed=await call(finance,'PATCH',`/document-numbering/INV/${invoice.body.id}`,{reference:'LEGACY/146',previousReference:invoice.body.reference,reason:'Continue legacy book'});
  assert.equal(renamed.status,200,JSON.stringify(renamed.body));
  assert.equal((await call(finance,'POST',`/receivables/invoices/${invoice.body.id}/issue`,{})).status,204);
  const receipt=await call(finance,'POST',`/receivables/invoices/${invoice.body.id}/receipts`,{amount:100,receivedDate:today(),method:'Cash',reference:'BANK-REF',receiptNumber:'LEGACY-R/099'});
  assert.equal(receipt.status,201,JSON.stringify(receipt.body));
  assert.equal((await call(finance,'PATCH',`/document-numbering/RCPT/${receipt.body.receiptId}`,{reference:'LEGACY-R/100',previousReference:'LEGACY-R/099',reason:'Correct receipt book'})).status,200);
  const detail=await call(finance,'GET',`/receivables/invoices/${invoice.body.id}`);
  assert.equal(detail.body.receipts[0].receiptNumber,'LEGACY-R/100');
  assert.equal(detail.body.receipts[0].reference,'BANK-REF');
  assert.equal(Number(detail.body.receipts[0].amount),100);
  const secondReceipt=await call(finance,'POST',`/receivables/invoices/${invoice.body.id}/receipts`,{amount:50,receivedDate:today(),method:'Cash'});
  assert.equal(secondReceipt.status,201,JSON.stringify(secondReceipt.body));
  const after=await call(finance,'GET',`/receivables/invoices/${invoice.body.id}`);
  assert.equal(after.body.receipts[1].receiptNumber,'TEST-R/00077');
  assert.equal((await call(finance,'POST','/receivables/invoices',{...body,reference:'LEGACY/146'})).status,409);
  await admin.query(`DELETE FROM ${testDatabase}.document_numbering WHERE company_id=1`);
});

test('quotation revisions preserve the original and finalization is independently authorised', async () => {
  const owner = await login();
  const supervisor = await login('supervisor@gkuc.lk');
  const clients = await call(owner, 'GET', '/clients');
  const client = clients.body[0];
  assert.ok(client);
  const identity = await call(owner, 'GET', `/qs/quotation-identity?companyId=1&clientId=${client.id}`);
  const show = {
    company: { logo:true,name:true,address:true,telephone:true,email:true,registrationNumber:true,tin:true,vatNumber:true,svatNumber:true,bankDetails:false },
    client: { name:true,billingAddress:true,siteAddress:true,contactPerson:true,phone:true,alternatePhone:true,email:true,
      city:true,district:true,province:true,country:true,registrationNumber:true,tin:true,vatNumber:true,project:true }
  };
  const created = await call(owner, 'POST', '/qs/quotations/manual', { companyId:1, clientId:client.id,
    title:'Revision workflow test', quoteDate:today(), markupPercent:0, vatPercent:18,
    calculationMode:'Separate Category Totals', preparedByName:'Test Preparer', preparedByDesignation:'Quantity Surveyor',
    visibility:show, lines:[
      { category:'Tar', area:'T-01', description:'Tar item', unit:'m2', quantity:1, rate:100 },
      { category:'Concrete', area:'C-01', description:'Concrete item', unit:'m3', quantity:1, rate:200 }
    ] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call(supervisor, 'POST', `/qs/quotations/${created.body.id}/finalize`, {})).status, 403);
  const revised = await call(owner, 'POST', `/qs/quotations/${created.body.id}/revisions`, {
    title:'Revision workflow test', clientId:client.id, quoteDate:today(), markupPercent:0, vatPercent:18,
    calculationMode:'Separate Category Totals', preparedByName:'Another Preparer', preparedByDesignation:'Managing Director',
    visibility:show, lines:[
      { category:'Tar', area:'T-02', description:'Tar item revised', unit:'m2', quantity:2, rate:150 },
      { category:'Concrete', area:'C-01', description:'Concrete item', unit:'m3', quantity:1, rate:200 }
    ] });
  assert.equal(revised.status, 201, JSON.stringify(revised.body));
  assert.equal(revised.body.revisionNumber, 1);
  assert.equal(revised.body.revisedFromId, created.body.id);
  assert.equal(revised.body.reference, created.body.reference);
  const original = await call(owner, 'GET', `/qs/quotations/${created.body.id}`);
  assert.equal(Number(original.body.total), 354);
  assert.equal(Number(revised.body.total), 590);
  assert.equal((await call(owner, 'POST', `/qs/quotations/${revised.body.id}/finalize`, {})).status, 200);
  const final = await call(owner, 'GET', `/qs/quotations/${revised.body.id}`);
  assert.equal(final.body.status, 'Sent');
  assert.equal(final.body.preparedBy, 'Another Preparer');
  assert.equal(final.body.preparedByDesignation, 'Managing Director');
  assert.ok(final.body.revisions.some(row => Number(row.id) === Number(created.body.id)));
  const finance=await login('finance@gkuc.lk');
  const renumbered=await call(finance,'PATCH',`/document-numbering/QUO/${revised.body.id}`,{reference:'HISTORICAL/Q/145',previousReference:revised.body.reference,reason:'Match previously issued quotation book'});
  assert.equal(renumbered.status,200,JSON.stringify(renumbered.body));
  const family=await call(owner,'GET',`/qs/quotations/${created.body.id}`);
  assert.ok(family.body.revisions.every(row=>row.reference==='HISTORICAL/Q/145'));
  assert.ok(identity.body.company);
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
  assert.deepEqual([...ids].sort(), detail.body.team.filter(member => ['Site team', 'Foreman'].includes(member.projectRole))
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

test('project details can be edited and an uncommitted project can change company', async () => {
  const owner = await login();
  const data = (await call(owner, 'GET', '/bootstrap')).body.data;
  const manager = data.employees.find(employee => employee.status === 'Active');
  const client = (await call(owner, 'POST', '/clients', { type: 'Organisation', name: `Edit Client ${Date.now()}` })).body;
  const created = await call(owner, 'POST', '/projects', { companyId: 1, name: `Edit Project ${Date.now()}`,
    clientId: client.id, managerEmployeeId: manager.id, site: 'Original site', stage: 'Mid-way' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const changed = await call(owner, 'PATCH', `/projects/${created.body.id}`, {
    companyId: 2, name: 'Updated project name', site: 'Updated site', progress: 35, health: 'Watch'
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const detail = await call(owner, 'GET', `/projects/${created.body.id}`);
  assert.equal(detail.body.companyId, 2);
  assert.equal(detail.body.name, 'Updated project name');
  assert.equal(detail.body.site, 'Updated site');
  assert.equal(Number(detail.body.progress), 35);
});

test('project deletion is reversible and hides its linked work without deleting it', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const data = (await call(owner, 'GET', '/bootstrap')).body.data;
  const manager = data.employees.find(employee => employee.status === 'Active');
  const client = (await call(owner, 'POST', '/clients', {
    type: 'Organisation', name: `Recoverable Client ${Date.now()}`
  })).body;
  const created = await call(owner, 'POST', '/projects', {
    companyId: 1, name: `Recoverable Project ${Date.now()}`, clientId: client.id,
    managerEmployeeId: manager.id, site: 'Soft-delete test site', stage: 'Mid-way'
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = await call(owner, 'POST', '/tasks', {
    projectId: created.body.id, title: 'Retained project task', assigneeEmployeeIds: [manager.id],
    due: today(), dueDate: today(), priority: 'Medium', status: 'Not started', notes: 'Must survive recovery'
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));

  assert.equal((await call(qs, 'DELETE', `/projects/${created.body.id}`)).status, 403);
  assert.equal((await call(owner, 'DELETE', `/projects/${created.body.id}`)).status, 204);
  assert.equal((await call(owner, 'GET', `/projects/${created.body.id}`)).status, 404);
  assert.equal((await call(owner, 'GET', '/projects')).body.some(row => row.id === created.body.id), false);
  assert.equal((await call(owner, 'GET', '/tasks')).body.some(row => row.id === task.body.id), false);
  const deleted = await call(owner, 'GET', '/projects/deleted?companyId=1');
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.find(row => row.id === created.body.id)?.taskCount, 1);
  assert.equal((await call(qs, 'GET', '/projects/deleted')).status, 403);

  assert.equal((await call(owner, 'POST', `/projects/${created.body.id}/restore`, {})).status, 200);
  assert.equal((await call(owner, 'GET', `/projects/${created.body.id}`)).status, 200);
  assert.equal((await call(owner, 'GET', '/tasks')).body.some(row => row.id === task.body.id), true);
  assert.equal((await call(owner, 'POST', `/projects/${created.body.id}/restore`, {})).status, 409);
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

test('repeated alerts remain one actionable case with access controls and evidence history',async()=>{
  const owner=lastOwnerToken || await login();
  const [ownerRow]=await admin.query(`SELECT id FROM ${testDatabase}.users WHERE email='owner@gkuc.lk'`);
  const inserted=await admin.query(`INSERT INTO ${testDatabase}.client_invoices
    (company_id,reference,client,title,invoice_date,due_date,gross,net_payable,paid_amount,status,created_by)
    VALUES (1,?,'Case QA client','Overdue case QA',DATE_SUB(CURDATE(),INTERVAL 12 DAY),
      DATE_SUB(CURDATE(),INTERVAL 5 DAY),100,100,0,'Issued',?)`,[`CASE-QA-${Date.now()}`,ownerRow[0].id]);
  const invoiceId=inserted[0].insertId;
  try{
    assert.equal((await call(owner,'POST','/notifications/scan')).status,200);
    const find=rows=>rows.find(row=>row.referenceType==='client_invoice'&&Number(row.referenceId)===invoiceId);
    const first=find((await call(owner,'GET','/notification-cases')).body);
    assert.ok(first);
    await call(owner,'POST','/notifications/scan');
    const again=find((await call(owner,'GET','/notification-cases')).body);
    assert.equal(again.id,first.id);
    assert.equal((await call('', 'GET',`/notification-cases/${first.id}`)).status,401);
    assert.equal((await call(owner,'POST',`/notification-cases/${first.id}/actions`,{action:'resolve',note:'Checked'})).status,400);
    assert.equal((await call(owner,'POST',`/notification-cases/${first.id}/actions`,{action:'acknowledge'})).status,200);
    assert.equal((await call(owner,'POST',`/notification-cases/${first.id}/actions`,{action:'assign'})).status,200);
    assert.equal((await call(owner,'POST',`/notification-cases/${first.id}/actions`,{action:'start'})).status,200);
    assert.equal((await call(owner,'POST',`/notification-cases/${first.id}/actions`,
      {action:'resolve',note:'Client paid outside system; recorded separately',evidence:'BANK-CASE-QA'})).status,200);
    const detail=(await call(owner,'GET',`/notification-cases/${first.id}`)).body;
    assert.equal(detail.state,'Resolved');
    assert.ok(detail.events.some(event=>event.action==='resolve'&&event.evidence==='BANK-CASE-QA'));
  }finally{
    await admin.query(`DELETE FROM ${testDatabase}.notifications WHERE reference_type='client_invoice' AND reference_id=?`,[invoiceId]);
    await admin.query(`DELETE FROM ${testDatabase}.alert_case_events WHERE case_id IN
      (SELECT id FROM ${testDatabase}.alert_cases WHERE reference_type='client_invoice' AND reference_id=?)`,[invoiceId]);
    await admin.query(`DELETE FROM ${testDatabase}.alert_cases WHERE reference_type='client_invoice' AND reference_id=?`,[invoiceId]);
    await admin.query(`DELETE FROM ${testDatabase}.client_invoices WHERE id=?`,[invoiceId]);
  }
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
  const workerIds = options.body.employees.slice(0,2).map(employee => Number(employee.id));
  assert.ok(workerIds.length,'active employees must be available for completed project work');
  const unassignedTask = await call(qs,'POST','/boq/cost-control/tasks',{
    projectId:2,title:'Completed work awaiting worker allocation',workDate:today(),priority:'Low',
    notes:'Workers can be assigned later from the task record',employeeIds:[]
  });
  assert.equal(unassignedTask.status,201,JSON.stringify(unassignedTask.body));
  assert.deepEqual(unassignedTask.body.assigneeEmployeeIds,[]);
  assert.equal(unassignedTask.body.assignee,'Unassigned');
  const completedTask = await call(qs,'POST','/boq/cost-control/tasks',{
    projectId:2,title:'Roof installation completed from daily costs',workDate:today(),priority:'High',
    notes:'Recorded by QS while preparing the daily cost sheet',employeeIds:workerIds
  });
  assert.equal(completedTask.status,201,JSON.stringify(completedTask.body));
  assert.deepEqual(completedTask.body.assigneeEmployeeIds,workerIds);
  const visibleTask = (await call(owner,'GET','/tasks?projectId=2')).body.find(task=>task.id===completedTask.body.id);
  assert.ok(visibleTask,'a completed task created from daily costs must appear on Tasks');
  assert.equal(visibleTask.status,'Completed');
  const editedTask = await call(qs,'PATCH',`/boq/cost-control/tasks/${completedTask.body.id}`,{
    projectId:2,title:'Roof installation completed and checked',workDate:today(),priority:'Medium',
    notes:'Workers and completion details checked on site',employeeIds:workerIds
  });
  assert.equal(editedTask.status,200,JSON.stringify(editedTask.body));
  assert.equal(editedTask.body.title,'Roof installation completed and checked');
  const taskId = editedTask.body.id;
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

test('daily labour costs allow an unassigned employee and a manually entered amount',async()=>{
  const owner=await login(),qs=await login('qs@gkuc.lk');
  const options=(await call(qs,'GET','/boq/cost-control/options?projectId=1')).body;
  const taskId=options.tasks[0]?.id;
  assert.ok(taskId);
  const workDate=shift(-45);
  const description=`Unassigned labour ${Date.now()}`;
  const sheet=await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate,lines:[
      {taskId,source:'Labour',description,amount:875.25},
      {taskId,source:'Labour',description:`${description} additional`,amount:500}
    ]
  });
  assert.equal(sheet.status,201,JSON.stringify(sheet.body));
  const detail=await call(owner,'GET',`/boq/cost-control/daily-sheets/${sheet.body.id}`);
  assert.equal(detail.status,200);
  assert.equal(detail.body.lines.length,2);
  assert.ok(detail.body.lines.every(line=>line.employee_id===null));
  assert.equal((await call(owner,'POST',`/boq/cost-control/daily-sheets/${sheet.body.id}/review`,{decision:'Approved'})).status,200);
  const costs=(await call(owner,'GET','/finance/expenses?projectId=1')).body.filter(row=>
    row.originType==='daily_cost_line'&&row.description.startsWith(description));
  assert.equal(costs.length,2);
  assert.deepEqual(costs.map(row=>Number(row.amount)).sort((a,b)=>a-b),[500,875.25]);

  const worker=options.employees.find(employee=>Number(employee.dailyRate)>0);
  assert.ok(worker);
  const adjusted=await call(qs,'POST','/boq/cost-control/daily-sheets',{
    projectId:1,workDate:shift(-46),lines:[{taskId,source:'Labour',employeeId:worker.id,
      description:`Adjusted labour ${Date.now()}`,amount:Number(worker.dailyRate)+125}]
  });
  assert.equal(adjusted.status,201,JSON.stringify(adjusted.body));
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
  assert.equal(posted[0].originType, 'client_receipt');
  assert.equal(Number(posted[0].invoiceId), Number(invoice.body.id));
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

test('concrete uses a numbered direct-delivery route with document and receipt trail', async () => {
  const store=await login('store@gkuc.lk');
  const owner=lastOwnerToken||await login();
  const material=await call(store,'POST','/materials',{
    name:`Ready-mix concrete ${Date.now()}`,unit:'m3',stock:0,minimum:0,site:'Direct to site',unitCost:24500,
    stockKind:'Consumable',category:'Concrete',procurementRoute:'Direct delivery'
  });
  assert.equal(material.status,201,JSON.stringify(material.body));
  const order=await call(store,'POST','/purchasing/orders',{
    supplierId:1,projectId:1,orderDate:today(),items:[{materialId:material.body.id,
      description:material.body.name,unit:'m3',quantity:5,rate:24500}]
  });
  assert.equal(order.status,201,JSON.stringify(order.body));
  assert.match(order.body.reference,/^DD-/);
  assert.equal(order.body.procurementRoute,'Direct delivery');
  assert.equal(order.body.status,'Issued');
  const detail=await call(owner,'GET',`/purchasing/orders/${order.body.id}`);
  assert.equal(detail.status,200);
  assert.equal((await call(store,'POST',`/purchasing/orders/${order.body.id}/receive`,{
    lines:[{itemId:detail.body.items[0].id,quantity:5}],notes:'Delivered directly to project site'
  })).status,200);
  const document=await fetch(`${base}/purchasing/orders/${order.body.id}/document`,{headers:{authorization:`Bearer ${owner}`}});
  assert.equal(document.status,200);
  const html=await document.text();
  assert.match(html,/Direct Delivery Instruction/);
  assert.match(html,/Delivered directly|Direct site delivery/);
});

test('VAT clearance is company-specific with reminders, renewal history and a work-queue deadline',async()=>{
  const owner=lastOwnerToken||await login();
  const created=await call(owner,'POST','/company-compliance',{
    companyId:1,reference:`VAT-CLEAR-${Date.now()}`,issueDate:today(),expiryDate:shift(20),
    reminders:[{unit:'Days',value:30},{unit:'Days',value:7},{unit:'Days',value:0}],notes:'Original clearance'
  });
  assert.equal(created.status,201,JSON.stringify(created.body));
  const records=await call(owner,'GET','/company-compliance?companyId=1');
  assert.equal(records.status,200);
  const record=records.body.find(row=>row.id===created.body.id);
  assert.equal(record.reminders.length,3);
  assert.equal(record.renewals.length,1);
  const queue=await call(owner,'GET','/dashboard/queue?companyId=1');
  assert.ok(queue.body.work.some(item=>item.kind==='company-compliance'&&item.id===created.body.id));
  assert.equal((await call(owner,'POST','/notifications/scan',{})).status,200);
  const [[alert]]=await admin.query(`SELECT COUNT(*) total FROM ${testDatabase}.notifications
    WHERE reference_type='company_compliance' AND reference_id=?`,[created.body.id]);
  assert.ok(Number(alert.total)>=1,'configured clearance reminder raises an actionable notification');
  const renewed=await call(owner,'PUT',`/company-compliance/${created.body.id}/renew`,{
    reference:`VAT-RENEW-${Date.now()}`,issueDate:shift(15),expiryDate:shift(380),
    reminders:[{unit:'Months',value:1}],notes:'Renewed clearance'
  });
  assert.equal(renewed.status,200,JSON.stringify(renewed.body));
  const history=(await call(owner,'GET','/company-compliance?companyId=1')).body.find(row=>row.id===created.body.id);
  assert.equal(history.renewals.length,2);
  assert.equal(history.reminders[0].unit,'Months');
  assert.equal((await call(owner,'GET','/company-compliance?companyId=2')).body.length,0,'other company remains separate');
});

test('Other income stays company scoped, honors no-tax and VAT choices, and carries cheque tax only once',async()=>{
  const owner=await login(),date=today(),stamp=Date.now();
  const base={projectId:null,companyId:1,incomeSource:'Equipment rental',description:'Other income QA',amount:1000,receivedDate:date,method:'Cash',reference:`OTHER-${stamp}`};
  for(const incomeSource of [undefined,'   ','x'.repeat(181)])
    assert.equal((await call(owner,'POST','/finance/income',{...base,incomeSource})).status,400);
  const none=await call(owner,'POST','/finance/income',{...base,taxTreatment:'None',vatRate:18,amountIncludesVat:true});
  assert.equal(none.status,201,JSON.stringify(none.body));
  assert.equal(none.body.project_id,null);assert.equal(Number(none.body.company_id),1);
  assert.equal(Number(none.body.amount),1000);assert.equal(Number(none.body.vat_amount),0);assert.equal(Number(none.body.vat_rate),0);
  assert.equal((await call(owner,'POST','/finance/income',base)).status,409);
  assert.equal((await call(owner,'POST','/finance/income',{...base,companyId:undefined})).status,400);
  const otherCompany=await call(owner,'POST','/finance/income',{...base,companyId:2});
  assert.equal(otherCompany.status,201,JSON.stringify(otherCompany.body));
  const exclusive=await call(owner,'POST','/finance/income',{...base,reference:`TAX-EX-${stamp}`,taxTreatment:'Standard',vatRate:18});
  assert.equal(exclusive.status,201,JSON.stringify(exclusive.body));
  assert.equal(Number(exclusive.body.amount),1180);assert.equal(Number(exclusive.body.vat_amount),180);
  const inclusive=await call(owner,'POST','/finance/income',{...base,reference:`NO-TRACK-${stamp}`,amount:1180,taxTreatment:'None',vatRate:18});
  assert.equal(inclusive.status,201,JSON.stringify(inclusive.body));
  assert.equal(Number(inclusive.body.amount),1180);assert.equal(Number(inclusive.body.net_amount),1180);
  assert.equal(Number(inclusive.body.vat_amount),0);
  const listed=(await call(owner,'GET','/finance/income?companyId=1')).body;
  assert.equal(listed.find(row=>row.id===none.body.id).project,'Other');
  assert.equal(listed.find(row=>row.id===none.body.id).incomeSource,'Equipment rental');
  assert.ok(!listed.some(row=>row.id===otherCompany.body.id));
  const schedule=async()=>(await call(owner,'GET',`/finance/vat?companyId=1&start=${date}&end=${date}`)).body;
  let vat=await schedule();
  assert.ok(!vat.output.some(row=>row.id===`income-${none.body.id}`));
  assert.equal(vat.output.find(row=>row.id===`income-${exclusive.body.id}`).vatAmount,180);
  const cheque=await call(owner,'POST','/receivables/cheques',{companyId:1,projectId:null,incomeSource:'Equipment rental cheque',chequeNumber:`OTHER-CHQ-${stamp}`,bank:'QA Bank',payer:'Other payer',purpose:'Other cheque income',amount:1000,
    receivedDate:date,chequeDate:date,depositBy:date,taxTreatment:'Standard',vatRate:18});
  assert.equal(cheque.status,201,JSON.stringify(cheque.body));
  assert.equal(Number(cheque.body.amount),1180);
  const incomeCount=async()=>{const [[row]]=await admin.query(`SELECT COUNT(*) count FROM ${testDatabase}.incomes WHERE origin_type='received_cheque' AND origin_id=?`,[String(cheque.body.id)]);return Number(row.count)};
  assert.equal(await incomeCount(),0);
  for(let attempt=0;attempt<2;attempt++)assert.equal((await call(owner,'PATCH',`/receivables/cheques/${cheque.body.id}`,{status:'Cleared'})).status,200);
  assert.equal(await incomeCount(),1);
  const [[cleared]]=await admin.query(`SELECT income_source FROM ${testDatabase}.incomes WHERE origin_type='received_cheque' AND origin_id=?`,[String(cheque.body.id)]);
  assert.equal(cleared.income_source,'Equipment rental cheque');
  vat=await schedule();
  assert.equal(vat.output.filter(row=>row.documentNumber===cheque.body.cheque_number).length,1);
  assert.equal(Number(vat.output.find(row=>row.documentNumber===cheque.body.cheque_number).vatAmount),180);
});

test('Finance creates company VAT ledgers and manual entries without changing cash ledgers',async()=>{
  const finance=await login('finance@gkuc.lk'),site=await login('supervisor@gkuc.lk');
  const period={companyId:1,start:'2041-01-01',end:'2041-03-31'};
  assert.equal((await call(finance,'POST','/finance/vat/periods',{...period,start:'2041-02-30'})).status,400);
  assert.equal((await call(site,'POST','/finance/vat/periods',period)).status,403);
  assert.equal((await call(site,'GET','/finance/vat/periods?companyId=1')).status,403);
  const made=await call(finance,'POST','/finance/vat/periods',period);
  assert.equal(made.status,201,JSON.stringify(made.body));assert.equal(made.body.period.status,'Draft');
  assert.equal((await call(finance,'POST','/finance/vat/periods',period)).status,409);
  assert.equal((await call(finance,'POST','/finance/vat/periods',{...period,start:'2041-02-01'})).status,409);
  const second=await call(finance,'POST','/finance/vat/periods',{...period,companyId:2});
  assert.equal(second.status,201,JSON.stringify(second.body));
  const list=await call(finance,'GET','/finance/vat/periods?companyId=1');
  assert.ok(list.body.some(row=>row.id===made.body.period.id));
  assert.ok(!list.body.some(row=>row.id===second.body.period.id));
  const [[counts]]=await admin.query(`SELECT (SELECT COUNT(*) FROM ${testDatabase}.incomes) incomes,(SELECT COUNT(*) FROM ${testDatabase}.expenses) expenses`);
  const entry={...period,direction:'Output',documentDate:'2041-01-15',documentNumber:`MANUAL-VAT-${Date.now()}`,counterparty:'VAT entry QA',taxableAmount:2000,vatRate:18};
  assert.equal((await call(site,'POST','/finance/vat/entries',entry)).status,403);
  const output=await call(finance,'POST','/finance/vat/entries',entry);
  assert.equal(output.status,201,JSON.stringify(output.body));assert.equal(output.body.vatAmount,360);
  assert.equal((await call(finance,'POST','/finance/vat/entries',entry)).status,409);
  assert.equal((await call(finance,'POST','/finance/vat/entries',{...entry,documentDate:'2040-12-31'})).status,400);
  assert.equal((await call(finance,'POST','/finance/vat/entries',{...entry,start:'2043-01-01',end:'2043-03-31',documentDate:'2043-01-15'})).status,409);
  const reconciled=await call(finance,'PUT','/finance/vat/period',{...period,status:'Reconciled'});
  assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
  const input=await call(finance,'POST','/finance/vat/entries',{...entry,direction:'Input',taxableAmount:1000});
  assert.equal(input.status,201,JSON.stringify(input.body));
  let schedule=(await call(finance,'GET',`/finance/vat?companyId=1&start=${period.start}&end=${period.end}`)).body;
  assert.equal(schedule.period.status,'Draft','new manual entries require reconciliation again');
  assert.equal(schedule.totals.outputVat,360);assert.equal(schedule.totals.inputVat,180);assert.equal(schedule.totals.netVatPayable,180);
  assert.equal(schedule.output.find(row=>row.id===`vat-manual-${output.body.id}`).source,'Manual VAT entry');
  const otherSchedule=(await call(finance,'GET',`/finance/vat?companyId=2&start=${period.start}&end=${period.end}`)).body;
  assert.equal(otherSchedule.totals.netVatPayable,0);
  const [[afterCounts]]=await admin.query(`SELECT (SELECT COUNT(*) FROM ${testDatabase}.incomes) incomes,(SELECT COUNT(*) FROM ${testDatabase}.expenses) expenses`);
  assert.deepEqual(afterCounts,counts);
  const [[source]]=await admin.query(`SELECT reference FROM ${testDatabase}.client_invoices WHERE company_id=1 AND status NOT IN ('Draft','Cancelled') LIMIT 1`);
  if(source)assert.equal((await call(finance,'POST','/finance/vat/entries',{...entry,documentNumber:source.reference})).status,409);
  const filed={...period,status:'Filed',filingReference:'VAT-QA-FILING'};
  assert.equal((await call(finance,'PUT','/finance/vat/period',filed)).status,200);
  assert.equal((await call(finance,'PUT','/finance/vat/period',{...filed,outputAdjustment:10,adjustmentNote:'Attempted change'})).status,409);
  assert.equal((await call(finance,'POST','/finance/vat/entries',{...entry,documentNumber:'FILED-ENTRY'})).status,409);
  const concurrent=await Promise.all([1,2].map(()=>call(finance,'POST','/finance/vat/periods',{companyId:1,start:'2042-01-01',end:'2042-03-31'})));
  assert.deepEqual(concurrent.map(row=>row.status).sort(),[201,409]);
});

test('VAT periods reconcile accrual schedules, export Excel and keep SVAT historical',async()=>{
  const owner=lastOwnerToken||await login();
  const date=today(),start=`${date.slice(0,7)}-01`;
  const schedule=await call(owner,'GET',`/finance/vat?companyId=1&start=${start}&end=${date}`);
  assert.equal(schedule.status,200,JSON.stringify(schedule.body));
  assert.equal(schedule.body.basis,'Invoice date (accrual); manual taxable income by receipt date');
  assert.ok(Array.isArray(schedule.body.output));
  assert.ok(Array.isArray(schedule.body.input));
  const saved=await call(owner,'PUT','/finance/vat/period',{companyId:1,start,end:date,status:'Reconciled',
    outputAdjustment:25,inputAdjustment:5,adjustmentNote:'Verified rounding difference against source tax invoices'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.period.status,'Reconciled');
  assert.equal(saved.body.totals.netVatPayable,saved.body.totals.outputVat+25-saved.body.totals.inputVat-5);
  const exportResponse=await fetch(`${base}/finance/vat/export?companyId=1&start=${start}&end=${date}`,{headers:{authorization:`Bearer ${owner}`}});
  assert.equal(exportResponse.status,200);
  const bytes=Buffer.from(await exportResponse.arrayBuffer());
  assert.equal(bytes.subarray(0,2).toString(),'PK','VAT export is an Excel workbook');
  const invalidSvat=await call(owner,'POST','/finance/vat/svat-entries',{companyId:1,periodStart:start,periodEnd:date,
    direction:'Output',scheduleType:'SVAT 05',documentDate:date,documentNumber:`SVAT-CURRENT-${Date.now()}`,
    counterparty:'Current customer',taxableAmount:1000,suspendedVat:180});
  assert.equal(invalidSvat.status,409);
  const historical=await call(owner,'POST','/finance/vat/svat-entries',{companyId:1,periodStart:'2025-07-01',periodEnd:'2025-09-30',
    direction:'Output',scheduleType:'SVAT 05',documentDate:'2025-09-15',documentNumber:`SVAT-HIST-${Date.now()}`,
    counterparty:'Historical customer',taxableAmount:1000,suspendedVat:180});
  assert.equal(historical.status,201,JSON.stringify(historical.body));
  const oldSchedule=await call(owner,'GET','/finance/vat?companyId=1&start=2025-07-01&end=2025-09-30');
  assert.ok(oldSchedule.body.historicalSvat.some(row=>row.documentNumber===historical.body.document_number));
});

test('equipment cannot be assigned twice without a return', async () => {
  const owner = await login();
  assert.equal((await call(owner, 'POST', '/equipment/3/assign', { projectId: 1, assignedTo: 'Tharushi Wickrama', assignedAt: today() })).status, 201);
  assert.equal((await call(owner, 'POST', '/equipment/3/assign', { projectId: 2, assignedTo: 'M. Rizwan', assignedAt: today() })).status, 409);
  assert.equal((await call(owner, 'POST', '/equipment/3/return', { returnedAt: today(), status: 'Available' })).status, 200);
});

test('supplier payments cannot exceed the invoice', async () => {
  const finance = await login('finance@gkuc.lk');
  const owner = lastOwnerToken || await login();
  const invoice = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 2, invoiceNo: 'INV-TEST-1', amount: 100000, invoiceDate: today(), dueDate: shift(14)
  });
  assert.equal(invoice.status, 201);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${invoice.body.id}/payments`, { amount: 150000, paidDate: today() })).status, 409);
  assert.equal((await call(owner, 'POST', `/purchasing/invoices/${invoice.body.id}/payment-exception`, {
    reason: 'Verified this standalone supplier invoice with the supplier and purchasing records'
  })).status, 204);
  const paid = await call(finance, 'POST', `/purchasing/invoices/${invoice.body.id}/payments`, { amount: 100000, paidDate: today() });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.status, 'Paid');
});

test('supplier invoice duplicate check and independent no-PO payment exception', async () => {
  const finance = lastFinanceToken || await login('finance@gkuc.lk');
  const owner = lastOwnerToken || await login();
  const invoiceNo = `RISK-${Date.now()}`;
  const first = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 2, invoiceNo, amount: 43210, invoiceDate: today()
  });
  assert.equal(first.status, 201);
  const duplicate = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 2, invoiceNo, amount: 43210, invoiceDate: today()
  });
  assert.equal(duplicate.status, 409);
  assert.ok(duplicate.body.warnings?.some(warning => warning.code === 'duplicate_invoice'));
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${first.body.id}/payment-exception`, {
    reason: 'Self approval must not be allowed'
  })).status, 403);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${first.body.id}/payments`, {
    amount: 43210, paidDate: today()
  })).status, 409);
  assert.equal((await call(owner, 'POST', `/purchasing/invoices/${first.body.id}/payment-exception`, {
    reason: 'Independently checked the standalone invoice and authorised the exception'
  })).status, 204);
  assert.equal((await call(finance, 'POST', `/purchasing/invoices/${first.body.id}/payments`, {
    amount: 43210, paidDate: today()
  })).status, 201);
  const accepted = await call(finance, 'POST', '/purchasing/invoices', {
    supplierId: 2, invoiceNo: `${invoiceNo}-B`, amount: 43210, invoiceDate: today(),
    riskAccepted: true, riskReason: 'Checked the second signed invoice and confirmed a separate delivery'
  });
  assert.equal(accepted.status, 201);
  assert.equal((await call(finance, 'GET', '/integrity/findings?status=Open')).status, 403);
  const findings = await call(owner, 'GET', '/integrity/findings?status=Open');
  const finding = findings.body.find(row => row.entity === 'supplier_invoice' && Number(row.entityId) === Number(accepted.body.id));
  assert.ok(finding, 'accepted warning becomes an investigation finding');
  assert.equal((await call(finance, 'POST', `/integrity/findings/${finding.id}/review`, {
    status: 'Dismissed', note: 'I recorded this invoice myself'
  })).status, 403);
  const [[ownerRow]] = await admin.query(`SELECT id FROM \`${testDatabase}\`.users WHERE email='owner@gkuc.lk'`);
  assert.equal((await call(owner, 'POST', `/integrity/findings/${finding.id}/review`, {
    status: 'Confirmed', note: 'Investigate the supporting delivery', assignedUserId: ownerRow.id,
    resolutionDueAt: new Date(Date.now() + 86400000).toISOString()
  })).status, 204);
  assert.equal((await call(owner, 'POST', `/integrity/findings/${finding.id}/comments`, {
    body: 'Requested the signed delivery note and bank advice.'
  })).status, 201);
  assert.equal((await call(owner, 'POST', `/integrity/findings/${finding.id}/review`, {
    status: 'Resolved', resolutionProof: 'Signed delivery note reviewed; separate goods received.'
  })).status, 204);
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
  assert.equal((await call(owner, 'POST', `/purchasing/invoices/${supplierInvoice.body.id}/payment-exception`, {
    reason: 'Verified this standalone VAT invoice against the original supplier document'
  })).status, 204);
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
  assert.ok((await call(finance,'GET','/finance/income?projectId=1')).body.some(row=>row.reference===received.body.cheque_number
    && row.originType==='client_receipt'&&Number(row.invoiceId)===Number(clientInvoice.body.id)));
});

test('finance reporting reconciles company and project scopes', async () => {
  const owner = await login();
  const company = await call(owner, 'GET', '/finance/reporting?projectId=all');
  assert.equal(company.status, 200);
  assert.equal(company.body.scope.projectId, 'all');
  assert.ok(company.body.projects.length >= 3);
  for (const ledger of ['expenses', 'incomes', 'clientInvoices', 'purchaseOrders', 'supplierInvoices',
    'pettyCash', 'retentions', 'bonds', 'variations', 'payroll', 'acceptedQuotations', 'approvedVariationsAll']) assert.ok(Array.isArray(company.body[ledger]), ledger);

  const project = await call(owner, 'GET', `/finance/reporting?projectId=1&from=${shift(-3650)}&to=${shift(3650)}`);
  assert.equal(project.status, 200);
  assert.equal(project.body.projects.length, 1);
  assert.equal(Number(project.body.projects[0].id), 1);
  for (const ledger of ['expenses', 'incomes', 'clientInvoices', 'purchaseOrders', 'retentions', 'variations', 'acceptedQuotations', 'approvedVariationsAll'])
    assert.ok(project.body[ledger].every(row => Number(row.projectId) === 1), `${ledger} obeys project scope`);
  assert.deepEqual(project.body.payroll, [], 'payroll is not falsely allocated to a project');
  assert.equal((await call(owner, 'GET', '/finance/reporting?projectId=invalid')).status, 400);
});

test('monthly management pack separates companies and preserves versioned close snapshots', async () => {
  const owner = await login();
  const qs = await login('qs@gkuc.lk');
  const period = today().slice(0, 7);
  const url = companyId => `/finance/management-accounts?companyId=${companyId}&period=${period}`;
  assert.equal((await call(qs, 'GET', url(1))).status, 200, 'QS may view company reports when finance.view is delegated');
  assert.equal((await call(qs, 'POST', '/finance/management-accounts/close', {
    companyId: 1, period, note: 'Unauthorized period close attempt.'
  })).status, 403);
  const initial = await call(owner, 'GET', url(1));
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.company.id, 1);
  assert.ok(initial.body.accrual && initial.body.cash && initial.body.workingCapital && initial.body.wip);
  const change = await call(owner, 'POST', '/finance/management-accounts/adjustments', {
    companyId: 1, period, category: 'Revenue', amount: 1250,
    explanation: 'Accrued approved month end adjustment', reference: 'MGT-REV-001'
  });
  assert.equal(change.status, 201, JSON.stringify(change.body));
  const adjusted = await call(owner, 'GET', url(1));
  assert.equal(adjusted.body.accrual.result, initial.body.accrual.result + 1250);
  const otherCompany = await call(owner, 'GET', url(2));
  assert.equal(otherCompany.status, 200);
  assert.ok(!otherCompany.body.adjustments.some(row => row.reference === 'MGT-REV-001'));
  const closed = await call(owner, 'POST', '/finance/management-accounts/close', {
    companyId: 1, period, note: 'Reviewed source records and management adjustments.'
  });
  assert.equal(closed.status, 201, JSON.stringify(closed.body));
  assert.equal(closed.body.version, 1);
  assert.equal((await call(owner, 'POST', '/finance/management-accounts/adjustments', {
    companyId: 1, period, category: 'Cost', amount: 10,
    explanation: 'Attempted post close adjustment', reference: 'MGT-COST-001'
  })).status, 409);
  const snapshot = await call(owner, 'GET', url(1));
  assert.equal(snapshot.body.close.status, 'Closed');
  assert.equal(snapshot.body.accrual.result, adjusted.body.accrual.result);
  const reopened = await call(owner, 'POST', '/finance/management-accounts/reopen', {
    companyId: 1, period, reason: 'Supplier document arrived after management close.'
  });
  assert.equal(reopened.status, 200);
  const reclosed = await call(owner, 'POST', '/finance/management-accounts/close', {
    companyId: 1, period, note: 'Reviewed the reopened period and source documents.'
  });
  assert.equal(reclosed.status, 201, JSON.stringify(reclosed.body));
  assert.equal(reclosed.body.version, 2);
});

test('daily expense register merges direct and petty payments once by company and location', async () => {
  const owner = await login();
  const date = today();
  const suffix = Date.now();
  const expense = await call(owner,'POST','/finance/expenses',{
    projectId:1,source:'Overhead',description:`Direct site payment ${suffix}`,
    amount:345,expenseDate:date,reference:`DIRECT-${suffix}`,payee:'Site vendor',
    paymentMethod:'Bank transfer',paidDate:date
  });
  assert.equal(expense.status,201,JSON.stringify(expense.body));
  const float = await call(owner,'POST','/receivables/petty-cash',{
    companyId:1,name:`Daily register float ${suffix}`,accountType:'Office expenses',
    holderName:'Finance test',projectId:1,ceiling:1000,lowAt:100
  });
  assert.equal(float.status,201,JSON.stringify(float.body));
  const floatId=float.body.id;
  assert.equal((await call(owner,'POST',`/receivables/petty-cash/${floatId}/entries`,{
    kind:'Top up',amount:500,entryDate:date,description:'Float funding'
  })).status,201);
  const spend=await call(owner,'POST',`/receivables/petty-cash/${floatId}/entries`,{
    kind:'Spend',amount:120,entryDate:date,description:`Site consumables ${suffix}`,
    category:'Consumables',payee:'Hardware shop',projectId:1
  });
  assert.equal(spend.status,201,JSON.stringify(spend.body));
  const register=await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=${date}`);
  assert.equal(register.status,200,JSON.stringify(register.body));
  const direct=register.body.entries.filter(row=>row.reference===`DIRECT-${suffix}`);
  const petty=register.body.entries.filter(row=>row.description===`Site consumables ${suffix}`);
  assert.equal(direct.length,1);
  assert.equal(petty.length,1,'petty spend and its linked project cost appear as one payment');
  assert.equal(direct[0].payee,'Site vendor');
  assert.equal(direct[0].paymentMethod,'Bank transfer');
  assert.equal(petty[0].payee,'Hardware shop');
  assert.equal(petty[0].locationType,'Project site');
  const unverified=await call(owner,'POST','/finance/expenses',{
    projectId:1,source:'Overhead',description:`Legacy unpaid expense ${suffix}`,
    amount:55,expenseDate:date,reference:`UNVERIFIED-${suffix}`
  });
  assert.equal(unverified.status,201);
  const beforePayment=await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=${date}`);
  assert.ok(!beforePayment.body.entries.some(row=>row.reference===`UNVERIFIED-${suffix}`));
  assert.ok(beforePayment.body.unverifiedManualExpenses >= 1);
  assert.equal((await call(owner,'PATCH',`/finance/expenses/${unverified.body.id}/payment`,{
    payee:'Office vendor',paymentMethod:'Bank transfer',paidDate:date
  })).status,200);
  const afterPayment=await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=${date}`);
  assert.equal(afterPayment.body.entries.filter(row=>row.reference===`UNVERIFIED-${suffix}`).length,1);
  assert.equal((await call(owner,'PATCH',`/finance/expenses/${unverified.body.id}/payment`,{
    payee:'Office vendor',paymentMethod:'Bank transfer',paidDate:date
  })).status,409,'the same direct expense cannot be marked paid twice');
  const officeBody={companyId:1,paymentDate:date,category:'Office supplies',payee:'Stationery shop',
    paymentMethod:'Bank transfer',description:'Office paper',reference:`OFFICE-${suffix}`,amount:85};
  assert.equal((await call(owner,'POST','/finance/office-expense-payments',officeBody)).status,201);
  assert.equal((await call(owner,'POST','/finance/office-expense-payments',officeBody)).status,409);
  const withOffice=await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=${date}`);
  const officeRows=withOffice.body.entries.filter(row=>row.reference===`OFFICE-${suffix}`);
  assert.equal(officeRows.length,1);
  assert.equal(officeRows[0].locationType,'Office');
  const other=await call(owner,'GET',`/finance/daily-expenses?companyId=2&date=${date}`);
  assert.equal(other.status,200);
  assert.ok(!other.body.entries.some(row=>row.reference===`DIRECT-${suffix}`));
  assert.equal((await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=wrong`)).status,400);
});

test('expected outflows schedule source bills once and keep companies separate', async () => {
  const owner=await login(), due=shift(8), revised=shift(12), suffix=Date.now();
  const bill=await call(owner,'POST','/finance/bills',{companyId:1,billType:'Electricity',provider:'Utility forecast test',
    reference:`FORECAST-${suffix}`,billDate:today(),dueDate:due,netAmount:200,taxTreatment:'Exempt',vatRate:0});
  assert.equal(bill.status,201,JSON.stringify(bill.body));
  const first=await call(owner,'GET','/finance/expected-outflows?companyId=1');
  assert.equal(first.status,200,JSON.stringify(first.body));
  const source=first.body.entries.find(row=>row.sourceType==='Operating bill'&&row.sourceId===bill.body.id);
  assert.equal(source.amount,200);assert.equal(source.expectedDate,due);
  const plan={companyId:1,sourceType:'Operating bill',sourceId:bill.body.id,expectedDate:revised,confidence:'Medium',notes:'Awaiting approval'};
  assert.equal((await call(owner,'POST','/finance/expected-outflows/plans',plan)).status,201);
  const updated=await call(owner,'GET','/finance/expected-outflows?companyId=1');
  assert.equal(updated.body.entries.filter(row=>row.sourceType==='Operating bill'&&row.sourceId===bill.body.id).length,1);
  assert.equal(updated.body.entries.find(row=>row.sourceType==='Operating bill'&&row.sourceId===bill.body.id).expectedDate,revised);
  assert.equal((await call(owner,'POST','/finance/expected-outflows/plans',{...plan,companyId:2})).status,404);
  assert.equal((await call(owner,'GET','/finance/expected-outflows?companyId=2')).body.entries.some(row=>row.reference===`FORECAST-${suffix}`),false);
  const standalone=await call(owner,'POST','/finance/expected-outflows/plans',{companyId:1,payee:'Expected vendor',
    description:'Planned equipment deposit',amount:350,expectedDate:due,confidence:'Low'});
  assert.equal(standalone.status,201,JSON.stringify(standalone.body));
  assert.equal((await call(owner,'PATCH',`/finance/expected-outflows/plans/${standalone.body.id}`,{companyId:1,status:'Paid'})).status,200);
  assert.equal((await call(owner,'GET','/finance/expected-outflows?companyId=1')).body.entries.some(row=>row.key===`Plan:${standalone.body.id}`),false);
});

test('cash comparison separates companies, compares periods and requires a balanced verified close', async () => {
  const owner=await login(),period=today().slice(0,7),reference=`CASH-COMP-${Date.now()}`;
  const baseline=await call(owner,'GET',`/finance/cash-comparison?companyId=1&period=${period}`);
  assert.equal(baseline.status,200,JSON.stringify(baseline.body));
  const opening=1500;
  const closing=opening+baseline.body.current.movement;
  const saved=await call(owner,'PUT','/finance/cash-comparison/period',{
    companyId:1,period,budgetReceipts:5000,budgetPayments:4000,openingBalance:opening,
    verifiedClosingBalance:closing,reconciliationAdjustment:0,balanceSource:reference
  });
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const report=await call(owner,'GET',`/finance/cash-comparison?companyId=1&period=${period}`);
  assert.equal(report.body.current.reconciliationStatus,'Reconciled');
  assert.equal(report.body.current.difference,0);
  assert.equal(report.body.comparison.receiptsVsBudget,report.body.current.receipts-5000);
  assert.equal(report.body.months.length,12);
  const other=await call(owner,'GET',`/finance/cash-comparison?companyId=2&period=${period}`);
  assert.equal(other.status,200);
  assert.equal(other.body.current.balanceSource,null);
  assert.equal(other.body.current.reconciliationStatus,'Missing balance');
  assert.equal((await call(owner,'PUT','/finance/cash-comparison/period',{
    companyId:1,period,budgetReceipts:null,budgetPayments:null,openingBalance:opening,
    verifiedClosingBalance:closing+100,reconciliationAdjustment:0,balanceSource:reference
  })).status,200);
  const unbalanced=await call(owner,'GET',`/finance/cash-comparison?companyId=1&period=${period}`);
  assert.equal(unbalanced.body.current.reconciliationStatus,'Difference');
  assert.equal(unbalanced.body.current.difference,100);
  assert.equal((await call(owner,'PUT','/finance/cash-comparison/period',{
    companyId:1,period,budgetReceipts:null,budgetPayments:null,openingBalance:opening,
    verifiedClosingBalance:closing+100,reconciliationAdjustment:100,balanceSource:reference
  })).status,400,'a nonzero reconciliation adjustment requires an explanation');
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
  const hr=await login('hr@gkuc.lk');
  assert.equal((await call(supervisor,'GET','/attendance')).status,403);
  const worker=await call(hr,'POST','/employees',{code:'TEST-ATT-HR',name:'Test Worker'});
  const first = await call(hr, 'POST', '/attendance', {
    employeeId:worker.body.id,name: 'Test Worker', role: 'Carpenter', projectId: 1, date: today(), state: 'On site'
  });
  assert.equal(first.status, 201);
  const duplicate = await call(hr, 'POST', '/attendance', {
    employeeId:worker.body.id,name: 'Test Worker', role: 'Carpenter', projectId: 1, date: today(), state: 'On site'
  });
  assert.equal(duplicate.status, 409);

  assert.equal((await call(supervisor,'PATCH',`/attendance/${first.body.id}`,{state:'Late',reason:'Denied correction'})).status,403);
  const corrected = await call(hr, 'PATCH', `/attendance/${first.body.id}`, { state: 'Late', reason: 'Arrived after gate close' });
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

test('project gallery accepts a photo and serves it through the protected file route', async () => {
  const owner = await login();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const form = new FormData();
  form.append('file', new Blob([png], { type:'image/png' }), 'gallery-check.png');
  const response = await fetch(`${base}/projects/1/gallery/photos`, {
    method:'POST',headers:{authorization:`Bearer ${owner}`},body:form
  });
  const photo = await response.json();
  assert.equal(response.status,201,JSON.stringify(photo));
  const listing = await call(owner,'GET','/projects/1/gallery/photos?folderId=none');
  assert.equal(listing.status,200);
  assert.ok(listing.body.some(row=>row.id===photo.id));
  const file = await fetch(`${base}/gallery/photos/${photo.id}/file`, {
    headers:{authorization:`Bearer ${owner}`}
  });
  assert.equal(file.status,200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
  await admin.query(`DELETE FROM ${testDatabase}.gallery_photos WHERE id=?`,[photo.id]);
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

test('statutory contributions use the full basis only in monthly payroll drafts', async () => {
  const owner=await login();
  const policy=await call(owner,'POST','/payroll/settings/policies',{companyId:1,effectiveFrom:'2034-01-01',
    officeOtRate:225,siteLabourSiteOtRate:200,siteLabourTravelOtRate:100,driverOtRate:225,
    supervisorSiteOtRate:225,supervisorTravelOtRate:100,epfEmployeeRate:8,epfEmployerRate:12,etfEmployerRate:3});
  assert.equal(policy.status,201,JSON.stringify(policy.body));
  for(const frequency of ['Daily','Weekly','Monthly']) {
    const person=await call(owner,'POST','/employees',{code:`EPF-${frequency}-${Date.now()}`,name:'Contribution Frequency QA',
      joinDate:'2034-01-01',compensationEffectiveFrom:'2034-01-01',payBasis:'Daily rate',payFrequency:frequency,
      employmentType:'Permanent',basicSalary:30000,dailyRate:5000,epfEligible:true,etfEligible:true,
      contributionStartDate:'2034-01-01'});
    assert.equal(person.status,201,JSON.stringify(person.body));
    const body={companyId:1,periodStart:'2034-02-01',periodEnd:'2034-02-01',payFrequency:frequency};
    const run=await call(owner,'POST','/payroll',body);
    assert.equal(run.status,201,JSON.stringify(run.body));
    for(let attempt=0;attempt<2;attempt++) {
      const detail=await call(owner,'GET',`/payroll/${run.body.id}`);
      const slip=detail.body.payslips.find(row=>row.employeeCode===person.body.code);
      assert.ok(slip);
      const monthly=frequency==='Monthly';
      assert.equal(Number(slip.contributionBase),monthly?30000:0);
      assert.equal(Number(slip.epfEmployeeDeduction),monthly?2400:0);
      assert.equal(Number(slip.epfEmployerContribution),monthly?3600:0);
      assert.equal(Number(slip.etfEmployerContribution),monthly?900:0);
      if(attempt===0) {
        const rebuilt=await call(owner,'POST','/payroll',body);
        assert.equal(rebuilt.status,201,JSON.stringify(rebuilt.body));
        assert.equal(rebuilt.body.id,run.body.id);
      }
    }
    assert.equal((await call(owner,'DELETE',`/payroll/${run.body.id}`)).status,204);
  }
});

test('approved paid leave restores LKR 1600 across payroll frequencies without paying unpaid leave twice', async () => {
  const owner=await login();
  const dates=['2033-02-01','2033-02-02','2033-02-03','2033-02-04'];
  const leavePolicy=await call(owner,'POST','/employees/leave/settings',{effectiveFrom:dates[0],annualDefault:14,
    casualDefault:7,monthlyLimit:5,waitingMonths:0,allowUnpaidDuringWait:true});
  assert.equal(leavePolicy.status,201,JSON.stringify(leavePolicy.body));
  for(const frequency of ['Daily','Weekly','Monthly']) {
    const person=await call(owner,'POST','/employees',{code:`LEAVE-PAY-${frequency}-${Date.now()}`,name:'Paid Leave Payroll QA',
      joinDate:'2033-01-01',compensationEffectiveFrom:'2033-01-01',payBasis:'Daily rate',payFrequency:frequency,
      dailyRate:1600,epfEligible:false,etfEligible:false});
    assert.equal(person.status,201,JSON.stringify(person.body));
    const id=person.body.id;
    await admin.query(`INSERT INTO ${testDatabase}.attendance(employee_id,employee_name,role,work_date,state,check_in,check_out,project_id)
      VALUES (?,?,'Worker',?,'Checked out','07:30','16:30',1),(?,?,'Worker',?,'Absent',NULL,NULL,NULL)`,
      [id,person.body.name,dates[0],id,person.body.name,dates[1]]);
    const requests=[];
    for(const [index,paymentType] of ['Paid','Unpaid','Paid'].entries()) {
      const leave=await call(owner,'POST',`/employees/${id}/leave`,{leaveType:'Annual',paymentType,
        fromDate:dates[index+1],toDate:dates[index+1],reason:'Paid and unpaid payroll regression'});
      assert.equal(leave.status,201,JSON.stringify(leave.body));requests.push(leave.body.id);
    }
    const body={companyId:1,periodStart:dates[0],periodEnd:dates[3],payFrequency:frequency};
    const initial=await call(owner,'POST','/payroll',body);
    assert.equal(initial.status,201,JSON.stringify(initial.body));
    const findSlip=async()=> (await call(owner,'GET',`/payroll/${initial.body.id}`)).body.payslips.find(row=>row.employeeCode===person.body.code);
    const before=await findSlip();
    assert.equal(Number(before.basic),1600,'pending leave is not paid');
    for(const requestId of requests.slice(0,2))assert.equal((await call(owner,'PATCH',`/employees/leave/${requestId}`,{status:'Approved'})).status,200);
    const rebuilt=await call(owner,'POST','/payroll',body);
    assert.equal(rebuilt.status,201,JSON.stringify(rebuilt.body));
    assert.equal(rebuilt.body.id,initial.body.id);
    const after=await findSlip();
    assert.equal(Number(after.daysPresent),1);
    assert.equal(Number(after.daysAbsent),0,'approved leave supersedes an absent import marker');
    assert.equal(Number(after.paidLeaveDays),1);
    assert.equal(Number(after.unpaidLeaveDays),1);
    assert.equal(Number(after.payableDays),2);
    assert.equal(Number(after.paidLeavePay),1600);
    assert.equal(Number(after.basic)-Number(before.basic),1600);
    assert.equal(Number(after.basic),3200);
    assert.equal(Number(after.netPay),3200);
    assert.equal(Number(after.unpaidLeaveDeduction),0);
    assert.equal(Number(after.overtimePay),0);
    assert.equal(Number(after.lateDeduction),0);
    const [[allocation]]=await admin.query(`SELECT SUM(amount) amount FROM ${testDatabase}.payroll_project_allocations
      WHERE employee_id=? AND source_type='Attendance'`,[id]);
    assert.equal(Number(allocation.amount),1600,'paid leave is not spread over the site worked-day allocation');
    await admin.query(`UPDATE ${testDatabase}.attendance SET state='Checked out',check_in='07:30',check_out='16:30' WHERE employee_id=? AND work_date=?`,[id,dates[1]]);
    const conflict=await call(owner,'POST','/payroll',body);
    assert.equal(conflict.status,409,JSON.stringify(conflict.body));
    assert.match(conflict.body.error,/leave conflicts with worked attendance/);
    assert.deepEqual(await findSlip(),after,'conflict rolls back the entire rebuild');
    await admin.query(`UPDATE ${testDatabase}.attendance SET state='Absent',check_in=NULL,check_out=NULL WHERE employee_id=? AND work_date=?`,[id,dates[1]]);
    for(const status of ['Approved','Paid'])assert.equal((await call(owner,'PATCH',`/payroll/${initial.body.id}`,{status})).status,200);
    assert.equal((await call(owner,'PATCH',`/employees/leave/${requests[0]}`,{status:'Pending'})).status,200);
    assert.equal(Number((await findSlip()).paidLeavePay),1600,'paid history is never recalculated from changed leave requests');
    assert.equal((await call(owner,'POST','/payroll',body)).status,409);
    // Test-only cleanup: production endpoints never reopen a paid run.
    await admin.query(`UPDATE ${testDatabase}.payroll_runs SET status='Draft' WHERE id=?`,[initial.body.id]);
    assert.equal((await call(owner,'DELETE',`/payroll/${initial.body.id}`)).status,204);
  }
  await admin.query(`DELETE FROM ${testDatabase}.leave_policies WHERE id=?`,[leavePolicy.body.id]);
});

test('biometric attendance pays automatic OT and minute lateness for every category using dated settings', async () => {
  const owner=await login();
  const firstDate=shift(1400),secondDate=shift(1401);
  const policy={companyId:1,effectiveFrom:firstDate,officeOtRate:225,siteLabourSiteOtRate:200,
    siteLabourTravelOtRate:100,driverOtRate:250,driverSiteOtRate:275,driverTravelOtRate:125,
    supervisorSiteOtRate:300,supervisorTravelOtRate:150,customOfficeOtRate:400,customSiteOtRate:350,customTravelOtRate:175,
    epfEmployeeRate:8,epfEmployerRate:12,etfEmployerRate:3,hrRules:INITIAL_HR_RULES};
  const oldPolicy=await call(owner,'POST','/payroll/settings/policies',policy);
  assert.equal(oldPolicy.status,201,JSON.stringify(oldPolicy.body));
  const newPolicy=await call(owner,'POST','/payroll/settings/policies',{...policy,effectiveFrom:secondDate,
    officeOtRate:450,siteLabourSiteOtRate:400,driverOtRate:500,driverSiteOtRate:550,
    supervisorSiteOtRate:600,customOfficeOtRate:800,customSiteOtRate:700,
    hrRules:{...INITIAL_HR_RULES,normalStart:'08:00',normalEnd:'16:00'}});
  assert.equal(newPolicy.status,201,JSON.stringify(newPolicy.body));
  const people=[];
  for(const [index,[category,workerType,expectedOt]] of [
    ['Office employee','Office',731.25],['Site labourer','Site',650],['Supervisor','Site',975],
    ['Driver','Office',812.5],['Driver','Site',893.75],['Custom','Site',1137.5],['Custom','Office',1300]
  ].entries()) {
    const code=`AUTOPAY-${Date.now()}-${index}`;
    const created=await call(owner,'POST','/employees',{code,name:'Shared Automatic Payroll QA',
      joinDate:firstDate,compensationEffectiveFrom:firstDate,payrollCategory:category,workerType,
      dailyRate:3200,epfEligible:false,etfEligible:false});
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal((await call(owner,'POST','/biometric/mappings',{code,employeeId:created.body.id})).status,200);
    people.push({...created.body,expectedOt});
  }
  const imported=await call(owner,'POST','/biometric/commit',{rows:people.flatMap(person=>[
    {code:person.code,date:firstDate,checkIn:'08:15:00',checkOut:'17:30:00'},
    {code:person.code,date:secondDate,checkIn:'08:45:00',checkOut:'17:30:00'}])});
  assert.equal(imported.status,201,JSON.stringify(imported.body));
  await admin.query(`UPDATE ${testDatabase}.attendance SET project_id=1 WHERE employee_id=?`,[people[0].id]);
  await admin.query(`UPDATE ${testDatabase}.attendance SET work_location='Site' WHERE employee_id=?`,[people[4].id]);
  const body={companyId:1,periodStart:firstDate,periodEnd:secondDate,payFrequency:'Monthly'};
  const generated=await call(owner,'POST','/payroll',body);
  assert.equal(generated.status,201,JSON.stringify(generated.body));
  const detail=(await call(owner,'GET',`/payroll/${generated.body.id}`)).body;
  for(const person of people) {
    const slip=detail.payslips.find(s=>s.employeeCode===person.code);
    assert.equal(Number(slip.daysPresent),2);
    assert.equal(Number(slip.overtimeHours),2);
    assert.equal(Number(slip.overtimePay),person.expectedOt,person.payrollCategory);
    assert.equal(Number(slip.lateMinutes),90);
    assert.equal(Number(slip.lateDeduction),200);
    assert.equal(Number(slip.netPay),6200+person.expectedOt);
    const calculation=typeof slip.calculationDetail==='string'?JSON.parse(slip.calculationDetail):slip.calculationDetail;
    assert.deepEqual(calculation.attendance.map(row=>row.policyId),[oldPolicy.body.id,newPolicy.body.id]);
    assert.ok(calculation.overtime.every(row=>row.source==='Attendance'));
    const [[records]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.overtime_records WHERE employee_id=?`,[person.id]);
    assert.equal(Number(records.n),0,'draft payroll does not fabricate approved OT source records');
  }
  const repeated=await call(owner,'POST','/payroll',body);
  assert.equal(repeated.status,201,JSON.stringify(repeated.body));
  assert.equal(repeated.body.id,generated.body.id);
  assert.equal(Number(repeated.body.total),Number(generated.body.total));
  const [[autoAllocations]]=await admin.query(`SELECT COUNT(*) n,SUM(amount) amount FROM ${testDatabase}.payroll_project_allocations
    WHERE employee_id=? AND source_type='Attendance OT'`,[people[0].id]);
  assert.equal(Number(autoAllocations.n),2);
  assert.equal(Number(autoAllocations.amount),people[0].expectedOt);
  assert.equal((await call(owner,'DELETE',`/payroll/${generated.body.id}`)).status,204);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_policies WHERE id IN (?,?)`,[oldPolicy.body.id,newPolicy.body.id]);
});

test('draft payroll can be rebuilt and deleted atomically without losing source records', async () => {
  const owner=await login();
  const store=await login('store@gkuc.lk');
  const workDate=shift(1100);
  const person=await call(owner,'POST','/employees',{code:`REBUILD-${Date.now()}`,name:'Payroll Rebuild QA',
    joinDate:today(),dailyRate:1000,epfEligible:false,etfEligible:false});
  assert.equal(person.status,201,JSON.stringify(person.body));
  const id=person.body.id;
  await admin.query(`INSERT INTO ${testDatabase}.attendance(employee_id,employee_name,role,work_date,check_in,check_out,state,project_id)
    VALUES (?,? ,'Labourer',?,'07:30','16:30','Checked out',1)`,[id,person.body.name,workDate]);
  const [ot]=await admin.query(`INSERT INTO ${testDatabase}.overtime_records(employee_id,project_id,work_date,hours,rate,status)
    VALUES (?,1,?,2,200,'Approved')`,[id,workDate]);
  const body={companyId:1,periodStart:workDate,periodEnd:workDate,payFrequency:'Monthly'};
  const first=await call(owner,'POST','/payroll',body);
  assert.equal(first.status,201,JSON.stringify(first.body));
  const runId=first.body.id;
  const before=(await call(owner,'GET',`/payroll/${runId}`)).body;
  assert.equal(Number(before.payslips.find(row=>row.employeeCode===person.body.code).netPay),1400);
  assert.equal((await call(store,'DELETE',`/payroll/${runId}`)).status,403);
  await admin.query(`UPDATE ${testDatabase}.employees SET daily_rate=1500 WHERE id=?`,[id]);
  const second=await call(owner,'POST','/payroll',body);
  assert.equal(second.status,201,JSON.stringify(second.body));
  assert.equal(second.body.id,runId);
  assert.equal(second.body.reference,first.body.reference);
  const detail=(await call(owner,'GET',`/payroll/${runId}`)).body;
  const slip=detail.payslips.find(row=>row.employeeCode===person.body.code);
  assert.equal(Number(slip.netPay),1900);
  const [[allocated]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.payroll_project_allocations WHERE source_type='Overtime' AND source_id=?`,[ot.insertId]);
  assert.equal(Number(allocated.n),1);
  assert.equal((await call(owner,'POST','/payroll',{...body,periodEnd:shift(1101)})).status,409,'partial overlap stays blocked');

  // A calculation failure must restore the old slips, allocations and audit trail.
  await admin.query(`UPDATE ${testDatabase}.employees SET allowance_eligibility=? WHERE id=?`,[JSON.stringify({transport:true}),id]);
  const [component]=await admin.query(`INSERT INTO ${testDatabase}.employee_pay_components
    (employee_id,name,kind,amount,pay_frequency,effective_from,created_by,calculation_method,allowance_type)
    VALUES (?,'Invalid transport rule','Allowance',100,'Monthly',?,1,'Attendance-prorated amount','Transport')`,[id,workDate]);
  const invalid=await call(owner,'POST','/payroll',body);
  assert.equal(invalid.status,409,JSON.stringify(invalid.body));
  assert.deepEqual((await call(owner,'GET',`/payroll/${runId}`)).body,detail);
  await admin.query(`DELETE FROM ${testDatabase}.employee_pay_components WHERE id=?`,[component.insertId]);
  const concurrent=await Promise.all([call(owner,'POST','/payroll',body),call(owner,'POST','/payroll',body)]);
  assert.ok(concurrent.every(row=>row.status===201&&row.body.id===runId),JSON.stringify(concurrent));

  assert.equal((await call(owner,'PATCH',`/payroll/${runId}`,{status:'Approved'})).status,200);
  assert.equal((await call(owner,'DELETE',`/payroll/${runId}`)).status,409);
  assert.equal((await call(owner,'POST','/payroll',body)).status,409);
  assert.equal((await call(owner,'PATCH',`/payroll/${runId}`,{status:'Paid'})).status,200);
  assert.equal((await call(owner,'DELETE',`/payroll/${runId}`)).status,409);
  // Restore Draft only in the disposable test database to exercise deletion.
  await admin.query(`UPDATE ${testDatabase}.payroll_runs SET status='Draft' WHERE id=?`,[runId]);
  assert.equal((await call(owner,'DELETE',`/payroll/${runId}`)).status,204);
  assert.equal((await call(owner,'GET',`/payroll/${runId}`)).status,404);
  for(const table of ['payroll_project_allocations','payslip_components','salary_advance_recoveries']) {
    const [[orphans]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.${table} child LEFT JOIN ${testDatabase}.payslips ps ON ps.id=child.payslip_id WHERE ps.id IS NULL`);
    assert.equal(Number(orphans.n),0,table);
  }
  const [[source]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.overtime_records WHERE id=?`,[ot.insertId]);
  assert.equal(Number(source.n),1);
  const [[deleted]]=await admin.query(`SELECT before_json FROM ${testDatabase}.audit_logs WHERE entity='payroll_run' AND entity_id=? AND action='DELETE'`,[String(runId)]);
  const snapshot=typeof deleted.before_json==='string'?JSON.parse(deleted.before_json):deleted.before_json;
  assert.ok(snapshot.payslips.length);
  assert.ok(snapshot.payroll_project_allocations.length);
  const rebuilt=await call(owner,'POST','/payroll',body);
  assert.equal(rebuilt.status,201,JSON.stringify(rebuilt.body));
  const sql=await readFile(new URL('../../ops/delete-draft-payroll.sql',import.meta.url),'utf8');
  const procedure=sql.match(/CREATE PROCEDURE[\s\S]*?END\$\$/)[0].slice(0,-2);
  const connection=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:testDatabase});
  try {
    await connection.query(procedure);
    await assert.rejects(connection.query('CALL gkuc_delete_draft_payroll_v1(0)'),/existing Draft/);
    await connection.query("UPDATE payroll_runs SET status='Approved' WHERE id=?",[rebuilt.body.id]);
    await assert.rejects(connection.query('CALL gkuc_delete_draft_payroll_v1(?)',[rebuilt.body.id]),/existing Draft/);
    await connection.query("UPDATE payroll_runs SET status='Draft' WHERE id=?",[rebuilt.body.id]);
    const preserved=(await call(owner,'GET',`/payroll/${rebuilt.body.id}`)).body;
    await connection.query('CREATE TABLE test_payroll_delete_blocker (run_id BIGINT UNSIGNED, FOREIGN KEY(run_id) REFERENCES payroll_runs(id)) ENGINE=InnoDB');
    await connection.query('INSERT INTO test_payroll_delete_blocker VALUES (?)',[rebuilt.body.id]);
    await assert.rejects(connection.query('CALL gkuc_delete_draft_payroll_v1(?)',[rebuilt.body.id]));
    assert.deepEqual((await call(owner,'GET',`/payroll/${rebuilt.body.id}`)).body,preserved,'SQL error rolls back all child deletions');
    await connection.query('DROP TABLE test_payroll_delete_blocker');
    await connection.query('CALL gkuc_delete_draft_payroll_v1(?)',[rebuilt.body.id]);
    assert.equal((await call(owner,'GET',`/payroll/${rebuilt.body.id}`)).status,404);
  } finally {
    await connection.query('DROP TABLE IF EXISTS test_payroll_delete_blocker');
    await connection.query('DROP PROCEDURE IF EXISTS gkuc_delete_draft_payroll_v1');
    await connection.end();
  }
});

test('employee forms cannot override payroll OT settings', async () => {
  const hr = await login('hr@gkuc.lk');
  assert.equal((await call(hr, 'PATCH', '/employees/2', {overtimeRate: 999})).status, 400);
  for (const field of ['customOfficeOtRate', 'customSiteOtRate', 'customTravelOtRate']) {
    assert.equal((await call(hr, 'PATCH', '/employees/2', {[field]: 999})).status, 400);
    const profile = {payBasis:'Daily rate',payFrequency:'Weekly',payrollCategory:'Custom',
      basicSalary:0,weeklyRate:0,dailyRate:2500,compensationEffectiveFrom:today(),
      epfEligible:false,etfEligible:false,[field]:999};
    assert.equal((await call(hr, 'PATCH', '/payroll/settings/employees/2', profile)).status, 400);
  }
  const policy = await call(hr, 'POST', '/payroll/settings/policies', {
    effectiveFrom: shift(800), officeOtRate:225,siteLabourSiteOtRate:200,siteLabourTravelOtRate:100,
    driverOtRate:225,supervisorSiteOtRate:225,supervisorTravelOtRate:100,
    epfEmployeeRate:8,epfEmployerRate:12,etfEmployerRate:3,
    customOfficeOtRate:310,customSiteOtRate:360,customTravelOtRate:160
  });
  assert.equal(policy.status, 201, JSON.stringify(policy.body));
  const rules = typeof policy.body.hrRules === 'string' ? JSON.parse(policy.body.hrRules) : policy.body.hrRules;
  assert.equal(rules.customOfficeOtRate, 310);
  assert.equal(rules.customSiteOtRate, 360);
  assert.equal(rules.customTravelOtRate, 160);
  await admin.query(`DELETE FROM ${testDatabase}.payroll_policies WHERE id=?`, [policy.body.id]);
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
    kind: 'Spend', amount: 4000, entryDate: today(), description: 'Worker salary advance', employeeId: 2
  })).status, 201);

  const invalidOvertime = await call(supervisor, 'POST', '/employees/2/overtime', {
    workDate: today(), hours: 1, overtimeType: 'Office'
  });
  assert.equal(invalidOvertime.status, 403, 'site-role users cannot access HR overtime');
  const overtime = await call(hr, 'POST', '/employees/2/overtime', { workDate: today(), hours: 4, overtimeType: 'Site',startTime:'17:00',endTime:'21:00',reason:'Signed overtime sheet confirmed by HR' });
  assert.equal(overtime.status, 201);
  assert.equal(Number(overtime.body.rate), 200);
  await call(hr, 'PATCH', `/employees/overtime/${overtime.body.id}`, { status: 'Approved' });
  assert.equal((await call(supervisor,'POST','/employees/2/overtime',{workDate:today(),hours:2,overtimeType:'Travel'})).status,403);
  await admin.query(`UPDATE ${testDatabase}.employees SET allowance_eligibility=? WHERE id=2`,[JSON.stringify({longDistance:true})]);
  const travel=await call(hr,'POST','/payroll/inputs',{employeeId:2,projectId:1,workDate:today(),kind:'Travel',departure:'21:00',arrival:'23:00',hours:2,distance:10,source:'Signed timesheet'});
  assert.equal(travel.status,201,JSON.stringify(travel.body));
  assert.equal((await call(hr,'PATCH',`/payroll/inputs/${travel.body.id}/review`,{status:'Confirmed',reason:'HR reviewed times'})).status,200);
  assert.equal((await call(hr,'PATCH',`/payroll/inputs/${travel.body.id}/review`,{status:'Approved',reason:'HR final approval'})).status,200);

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
  assert.equal(Number(slip.basic), 26400, 'earned salary is daily rate × six attended days');
  assert.equal(Number(slip.contributionBase), 98000, 'every run uses the full configured monthly statutory basis');
  assert.equal(Number(slip.epfEmployeeDeduction), 7840);
  assert.equal(Number(slip.epfEmployerContribution), 11760);
  assert.equal(Number(slip.etfEmployerContribution), 2940);
  assert.equal(Number(slip.otherDeduction), 500);
  assert.equal(Number(slip.unpaidLeaveDeduction), 0);
  assert.equal(Number(slip.salaryAdvanceDeduction), 4000, 'the named worker advance is recovered');
  assert.equal(Number(slip.deductions), 12340, 'the salary sheet reconciles statutory, recurring and advance deductions');
  assert.equal(Number(slip.netPay), 19060);
  assert.equal(Number(slip.employerCost), 46100);
  assert.equal(slip.components.length, 4, 'the payslip preserves recurring components and the linked travel allowance calculation');
  assert.equal(Number(slip.advanceRecoveries[0].amount), 4000);
  const advances = (await call(owner, 'GET', `/receivables/petty-cash/${advanceFloat}/entries`)).body;
  assert.equal(Number(advances.find(row => row.employeeId === 2).outstandingAdvance), 0);

  const rebuilt=await call(hr, 'POST', '/payroll', { periodStart: shift(-30), periodEnd: today() });
  assert.equal(rebuilt.status,201,JSON.stringify(rebuilt.body));
  assert.equal(rebuilt.body.id,run.body.id);
  const rebuiltSlip=(await call(hr,'GET',`/payroll/${run.body.id}`)).body.payslips.find(row=>row.employeeCode==='EMP-0002');
  assert.equal(Number(rebuiltSlip.salaryAdvanceDeduction),4000,'rerunning releases and reapplies the same advance once');
  assert.equal(rebuiltSlip.components.length,4,'claim components are rebuilt, not lost or duplicated');
  assert.equal(Number(rebuiltSlip.netPay),Number(slip.netPay));

  assert.equal((await call(hr, 'PATCH', '/payroll/settings/employees/3', {
    payBasis: 'Daily rate', payFrequency: 'Weekly', payrollCategory: 'Site labourer',
    basicSalary: 0, weeklyRate: 0, dailyRate: 3300, compensationEffectiveFrom: shift(-1),
    epfEligible: false, etfEligible: false, customOfficeOtRate: null, customSiteOtRate: null, customTravelOtRate: null
  })).status, 200);
  assert.equal((await call(hr,'POST','/payroll',{periodStart:shift(-6),periodEnd:today(),payFrequency:'Weekly'})).status,409,'an employee cannot be paid twice after changing frequency');
  const weeklyRun = await call(hr, 'POST', '/payroll', { periodStart: shift(1), periodEnd: shift(7), payFrequency: 'Weekly' });
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
  const report=await call(transport,'GET',`/fleet/monthly-report?companyId=1&period=${today().slice(0,7)}`);
  assert.ok(report.body.rows.some(row=>row.vehicleId===1&&row.projectId===null&&row.serviceCost>=32000),
    'company fleet service appears in the selected company monthly report');
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
    cost, odometer: 120, vendor: 'Test fuel station' });
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
  const daily=(await call(owner,'GET',`/finance/daily-expenses?companyId=1&date=${today()}`)).body;
  const dailyFuel=daily.entries.filter(row=>row.reference===`Fleet fuel #${saved.body.id}`);
  assert.equal(dailyFuel.length,1,'Fleet, petty cash and project cost resolve to one daily payment');
  assert.equal(dailyFuel[0].payee,'Test fuel station');
  assert.equal((await call(transport, 'POST', path, fuel(4000))).status, 409);
  const concurrent = await Promise.all([1, 2].map(() => call(transport, 'POST', path, {
    ...fuel(2000), odometer: 130
  })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409]);
  const balanceAfter = (await call(owner, 'GET', '/receivables/petty-cash?companyId=1')).body
    .find(row => row.id === floatId).balance;
  assert.equal(Number(balanceAfter), 1000);
  const monthly=await call(transport,'GET',`/fleet/monthly-report?companyId=1&period=${today().slice(0,7)}`);
  assert.equal(monthly.status,200);
  const vehicleMonth=monthly.body.rows.find(row=>row.vehicleId===vehicle.body.id&&row.projectId===1);
  assert.equal(vehicleMonth.fuelLitres,40);
  assert.equal(vehicleMonth.fuelCost,14000);
  assert.equal(vehicleMonth.distanceKm,10);
  assert.equal(vehicleMonth.costPerKm,1400);

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
  const otherReport=await call(transport,'GET',`/fleet/monthly-report?companyId=2&period=${today().slice(0,7)}`);
  assert.ok(!otherReport.body.rows.some(row=>row.vehicleId===vehicle.body.id),'shared vehicle costs stay with the company that paid them');
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
  const insurance=(await call(owner,'GET','/insurance')).body.find(policy=>Number(policy.vehicle_id)===Number(id)&&policy.status==='Active');
  assert.ok(insurance&&!insurance.isFleetOnly,'Fleet renewal creates the matching HR policy record');
  assert.equal(insurance.policy_number,'POL-2027');
  assert.equal((await call(owner,'POST',`/fleet/${id}/documents`,{docType:'Insurance',reference:'POL-2027',
    renewedOn:today(),expiryDate:today(),cost:24000})).status,409,'the same renewal cannot be recorded twice');
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
    filename: 'mixed.xlsx', rows: [{ ...rows[0], date: shift(-97), workLocation: undefined, projectId: undefined }]
  });
  assert.equal(missing.status, 201, JSON.stringify(missing.body));
  const unassigned = (await call(token, 'GET', `/attendance?date=${shift(-97)}`)).body
    .find(item => item.employeeId === person.body.id);
  assert.equal(unassigned.workLocation, 'Unassigned');
  assert.equal(unassigned.projectId, null);
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
  const reimport = await call(token, 'POST', '/biometric/commit', {
    filename: 'without-locations.xlsx', rows: rows.map(({ workLocation, projectId, ...row }) => row)
  });
  assert.equal(reimport.status, 201, JSON.stringify(reimport.body));
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

  const employee = (await call(token, 'GET', '/employees')).body.find(row => row.id !== created.body.id
    && row.status === 'Active' && row.joinDate && String(row.joinDate).slice(0, 10) <= date);
  assert.ok(employee, 'a current employee with a recorded start date is available for the office check');
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

test('salary bank account is HR-only and new employees start statutory contributions from employment', async () => {
  const hr = await login('hr@gkuc.lk');
  const site = await login('supervisor@gkuc.lk');
  const joined = shift(-20);
  const created = await call(hr, 'POST', '/employees', { code: 'BANK-STAT-QA', name: 'Bank Stat QA', joinDate: joined });
  assert.equal(created.status, 201);
  assert.equal(Boolean(created.body.epfEligible), true);
  assert.equal(Boolean(created.body.etfEligible), true);
  assert.equal(String(created.body.contributionStartDate).slice(0, 10), joined);
  const id = created.body.id;
  const account = { bankName: 'Test Bank', branchName: 'Main Branch', accountNumber: '123456789012', accountHolderName: 'Bank Stat QA' };
  assert.equal((await call(site, 'GET', `/employees/${id}/bank-account`)).status, 403);
  assert.equal((await call(site, 'PUT', `/employees/${id}/bank-account`, account)).status, 403);
  assert.equal((await call(hr, 'PUT', `/employees/${id}/bank-account`, account)).status, 200);
  assert.equal((await call(hr, 'GET', `/employees/${id}/bank-account`)).body.accountNumber, account.accountNumber);
  const general = await call(site, 'GET', `/employees/${id}`);
  if (general.status === 200) assert.equal(general.body.accountNumber, undefined);
});

test('applicant CV screening scores and shortlisting gate interviews', async () => {
  const hr = await login('hr@gkuc.lk');
  const site = await login('supervisor@gkuc.lk');
  const applicant = await call(hr,'POST','/hiring/applicants',{name:'Screening QA',email:'screening.qa@gkuc.lk',position:'Site engineer'});
  assert.equal(applicant.status,201);
  const id = applicant.body.id;
  assert.equal((await call(hr,'GET',`/hiring/${id}`)).body.status,'Applicant');
  assert.equal((await call(site,'GET',`/hiring/${id}`)).status,403);
  const cvForm = new FormData();
  cvForm.append('file', new Blob([Buffer.from('%PDF-1.4\nCV test content')], { type:'application/pdf' }), 'candidate-cv.pdf');
  cvForm.append('title', 'Candidate CV');
  const cvResponse = await fetch(`${base}/uploads/candidate/${id}`, {
    method:'POST',headers:{authorization:`Bearer ${hr}`},body:cvForm
  });
  const cv = await cvResponse.json();
  assert.equal(cvResponse.status,201,JSON.stringify(cv));
  assert.equal((await call(site,'GET',`/uploads/candidate/${id}`)).status,403);
  const interview={scheduledAt:'2027-04-01T10:00',interviewer:'HR test'};
  assert.equal((await call(hr,'POST',`/hiring/${id}/interviews`,interview)).status,409);
  assert.equal((await call(hr,'PATCH',`/hiring/${id}`,{status:'Selected'})).status,409);
  const screen=await call(hr,'PATCH',`/hiring/${id}/screening`,{experience:4,qualifications:5,roleFit:3,notes:'Relevant project and safety experience.',decision:'Shortlisted'});
  assert.equal(screen.status,200);
  assert.equal(screen.body.scores.total,12);
  assert.equal((await call(hr,'POST',`/hiring/${id}/interviews`,interview)).status,201);
  assert.equal((await call(hr,'DELETE',`/uploads/${cv.id}`)).status,204);
  await admin.query(`DELETE FROM ${testDatabase}.hiring_candidates WHERE id=?`,[id]);
});

test('HR leave policy and individual entitlements enforce yearly, monthly and waiting-period rules',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const policy={effectiveFrom:'2035-01-01',annualDefault:10,casualDefault:3,monthlyLimit:2,waitingMonths:3,allowUnpaidDuringWait:false};
  assert.equal((await call(site,'POST','/employees/leave/settings',policy)).status,403);
  assert.equal((await call(owner,'POST','/employees/leave/settings',policy)).status,201);
  const created=await call(owner,'POST','/employees',{code:'LEAVE-POLICY-QA',name:'Leave Policy QA',joinDate:'2035-01-01'});
  assert.equal(created.status,201);
  const id=created.body.id;
  assert.equal(Number((await call(owner,'GET',`/employees/${id}/leave-entitlement`)).body.annual),14);
  assert.equal((await call(site,'PUT',`/employees/${id}/leave-entitlement`,{annual:4,casual:1})).status,403);
  assert.equal((await call(owner,'PUT',`/employees/${id}/leave-entitlement`,{annual:4,casual:1})).status,200);
  const request=(fromDate,toDate,paymentType='Paid',leaveType='Annual')=>call(owner,'POST',`/employees/${id}/leave`,{leaveType,paymentType,fromDate,toDate,reason:'Policy check'});
  assert.equal((await request('2035-02-01','2035-02-01','Unpaid')).status,409);
  assert.equal((await request('2035-04-01','2035-04-02')).status,201);
  assert.equal((await request('2035-04-03','2035-04-03')).status,409);
  assert.equal((await request('2035-05-01','2035-05-02')).status,201);
  assert.equal((await request('2035-06-01','2035-06-01')).status,409);
  assert.equal((await request('2035-06-01','2035-06-01','Paid','Casual')).status,201);
  assert.equal((await request('2035-06-02','2035-06-02','Paid','Casual')).status,409);
  await admin.query(`DELETE FROM ${testDatabase}.employees WHERE id=?`,[id]);
});

test('credit purchase reminders are targeted, recurring, company scoped and stop after payment',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const users=await call(owner,'GET','/purchasing/credit-reminder-users');
  assert.equal(users.status,200);
  assert.equal((await call(site,'GET','/purchasing/credit-reminder-users')).status,403);
  const ownerId=users.body.find(user=>user.role==='Managing Director').id;
  const creditReminder={description:'Cement bought on credit',startDate:today(),frequency:'Daily',userIds:[ownerId,ownerId]};
  const payload={companyId:1,supplierId:2,invoiceNo:`CREDIT-${Date.now()}`,amount:12345.67,
    invoiceDate:today(),dueDate:shift(7),creditReminder,riskAccepted:true,riskReason:'Distinct credit purchase for reminder integration testing.'};
  assert.equal((await call(owner,'POST','/purchasing/invoices',{...payload,creditReminder:{...creditReminder,userIds:[]}})).status,400);
  assert.equal((await call(owner,'POST','/purchasing/invoices',{...payload,creditReminder:{...creditReminder,userIds:[999999999]}})).status,400);
  const created=await call(owner,'POST','/purchasing/invoices',payload);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.id;
  const reminders=async(token,company=1)=>(await call(token,'GET',`/dashboard/queue?companyId=${company}`)).body.creditReminders;
  assert.equal((await reminders(owner)).filter(row=>row.id===id).length,1);
  assert.equal((await reminders(site)).some(row=>row.id===id),false);
  assert.equal((await reminders(owner,2)).some(row=>row.id===id),false);
  assert.equal((await call(site,'POST',`/dashboard/credit-reminders/${id}/acknowledge`,{})).status,404);
  assert.equal((await call(owner,'POST',`/dashboard/credit-reminders/${id}/acknowledge`,{})).status,204);
  assert.equal((await reminders(owner)).some(row=>row.id===id),false);
  assert.equal((await call(owner,'POST',`/dashboard/credit-reminders/${id}/acknowledge`,{})).status,404);
  await admin.query(`UPDATE ${testDatabase}.supplier_credit_reminder_users SET next_date='2000-01-01' WHERE invoice_id=?`,[id]);
  await admin.query(`UPDATE ${testDatabase}.supplier_invoices SET paid_amount=1000 WHERE id=?`,[id]);
  assert.equal(Number((await reminders(owner)).find(row=>row.id===id).outstanding),11345.67);
  await admin.query(`UPDATE ${testDatabase}.supplier_invoices SET paid_amount=amount,status='Paid' WHERE id=?`,[id]);
  assert.equal((await reminders(owner)).some(row=>row.id===id),false);
});

test('bonds accept a pending number, support audited edits and confirmed deletion without other data changes',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const payload={companyId:1,kind:'Other',beneficiary:'Bond QA beneficiary',bank:'QA Bank',amount:5000,
    marginHeld:1000,commission:50,issuedDate:'2026-01-01',expiryDate:'2027-01-01',reminderDays:0};
  const created=await call(owner,'POST','/receivables/bonds',payload);assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.id;
  assert.equal((await call(site,'PUT',`/receivables/bonds/${id}`,payload)).status,403);
  assert.equal((await call(site,'DELETE',`/receivables/bonds/${id}`)).status,403);
  assert.equal((await call(owner,'PUT',`/receivables/bonds/${id}`,{...payload,companyId:2})).status,400);
  assert.equal((await call(owner,'PUT',`/receivables/bonds/${id}`,{...payload,expiryDate:'2026-02-30'})).status,400);
  assert.equal((await call(owner,'POST',`/receivables/bonds/${id}/extend`,{newExpiryDate:'2027-06-01',extendedOn:'2026-12-01',reminderDays:20,additionalCommission:25})).status,200);
  const updated={...payload,bondNumber:'BANK-123',amount:6000,expiryDate:'2027-06-01',commission:75,notes:'Corrected guarantee'};
  assert.equal((await call(owner,'PUT',`/receivables/bonds/${id}`,updated)).status,204);
  const row=(await call(owner,'GET','/receivables/bonds?companyId=1')).body.find(row=>row.id===id);
  assert.equal(row.bond_number,'BANK-123');assert.equal(Number(row.amount),6000);assert.equal(Number(row.extensions),1);assert.equal(row.reminderDays,0);
  assert.equal((await call(owner,'DELETE',`/receivables/bonds/${id}`)).status,204);
  assert.equal((await call(owner,'GET','/receivables/bonds?companyId=1')).body.some(row=>row.id===id),false);
  assert.equal((await call(owner,'DELETE',`/receivables/bonds/${id}`)).status,404);
  const [logs]=await admin.query(`SELECT before_json FROM ${testDatabase}.audit_logs WHERE entity='bank_bond' AND entity_id=? AND action='DELETE'`,[String(id)]);
  assert.equal(logs.length,1);const snapshot=typeof logs[0].before_json==='string'?JSON.parse(logs[0].before_json):logs[0].before_json;
  assert.equal(snapshot.bond_number,'BANK-123');assert.equal(snapshot.extensions.length,1);
});

test('bond register supports workbook security references, dates, types and release records',async()=>{
  const owner=await login();
  const payload={companyId:2,kind:'ESHS performance',beneficiary:'Deputy Project Director, '.repeat(12),bank:'Peoples Bank',
    amount:214224.60,issuedDate:'2025-03-20',startDate:'2025-03-21',expiryDate:'2026-11-18',
    fdReference:'1856001149014 & 1856001148998',projectDescription:'Unawarded tender / historical project',
    processNotes:'Letter issued; awaiting release',status:'Live'};
  const created=await call(owner,'POST','/receivables/bonds',payload);
  assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;
  const read=async()=>(await call(owner,'GET','/receivables/bonds?companyId=2')).body.find(row=>row.id===id);
  let row=await read();assert.equal(row.fd_reference,payload.fdReference);assert.equal(row.start_date,payload.startDate);
  assert.equal(row.project_description,payload.projectDescription);assert.equal(row.process_notes,payload.processNotes);
  assert.equal(row.beneficiary,payload.beneficiary.trim());assert.equal(row.kind,'ESHS performance');
  assert.equal((await call(owner,'POST','/receivables/bonds',{...payload,startDate:'2026-11-19'})).status,400);
  assert.equal((await call(owner,'POST','/receivables/bonds',{...payload,startDate:'2025-06-31'})).status,400);
  assert.equal((await call(owner,'PUT',`/receivables/bonds/${id}`,{...payload,kind:'Cash',status:'Released',releasedDate:'2026-10-26',processNotes:'Released by bank'})).status,204);
  row=await read();assert.equal(row.kind,'Cash');assert.equal(row.status,'Released');assert.equal(row.released_date,'2026-10-26');
  const {fdReference,projectDescription,startDate,processNotes,status,...legacy}=payload;
  assert.equal((await call(owner,'PUT',`/receivables/bonds/${id}`,legacy)).status,204);
  row=await read();assert.equal(row.fd_reference,payload.fdReference);assert.equal(row.status,'Released');
  assert.equal((await call(owner,'GET','/receivables/bonds?companyId=1')).body.some(row=>row.id===id),false);
  assert.equal((await call(owner,'DELETE',`/receivables/bonds/${id}`)).status,204);
});

test('one-time salary deductions require approval and reduce payroll once, including draft recalculation',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const person=await call(owner,'POST','/employees',{code:`DEDUCT-${Date.now()}`,name:'Deduction Payroll QA',joinDate:'2038-01-01',compensationEffectiveFrom:'2038-01-01',
    payBasis:'Daily rate',payFrequency:'Daily',dailyRate:1600,epfEligible:false,etfEligible:false});
  assert.equal(person.status,201,JSON.stringify(person.body));const employeeId=person.body.id;
  await admin.query(`INSERT INTO ${testDatabase}.attendance(employee_id,employee_name,role,work_date,state,check_in,check_out,project_id)
    VALUES (?,?,'Worker','2038-02-01','Checked out','07:30','16:30',1)`,[employeeId,person.body.name]);
  const input={kind:'Salary deduction',employeeId,workDate:'2038-02-01',amount:275,source:'Management instruction',notes:'Agreed one-time deduction'};
  assert.equal((await call(site,'POST','/payroll/inputs',input)).status,403);
  assert.equal((await call(owner,'POST','/payroll/inputs',{...input,amount:-1})).status,400);
  assert.equal((await call(owner,'POST','/payroll/inputs',{...input,notes:''})).status,400);
  const created=await call(owner,'POST','/payroll/inputs',input);assert.equal(created.status,201,JSON.stringify(created.body));
  const body={companyId:1,payFrequency:'Daily',periodStart:'2038-02-01',periodEnd:'2038-02-01'};
  const initial=await call(owner,'POST','/payroll',body);assert.equal(initial.status,201,JSON.stringify(initial.body));
  const slip=async()=>(await call(owner,'GET',`/payroll/${initial.body.id}`)).body.payslips.find(row=>row.employeeCode===person.body.code);
  assert.equal(Number((await slip()).otherDeduction),0);
  assert.equal((await call(owner,'PATCH',`/payroll/inputs/${created.body.id}/review`,{status:'Approved',reason:'Checked agreement'})).status,409);
  for(const status of ['Confirmed','Approved'])assert.equal((await call(owner,'PATCH',`/payroll/inputs/${created.body.id}/review`,{status,reason:'Checked agreement'})).status,200);
  for(let attempt=0;attempt<2;attempt++){
    assert.equal((await call(owner,'POST','/payroll',body)).status,201);
    assert.equal(Number((await slip()).otherDeduction),275);assert.equal(Number((await slip()).netPay),1325);
  }
  const later=await call(owner,'POST','/payroll',{...body,periodStart:'2038-02-02',periodEnd:'2038-02-02'});
  assert.equal(later.status,201,JSON.stringify(later.body));
  const next=(await call(owner,'GET',`/payroll/${later.body.id}`)).body.payslips.find(row=>row.employeeCode===person.body.code);
  assert.equal(Number(next.otherDeduction),0);
});

test('travel allowances support manual amounts and existing calculated claims without adding manual travel OT',async()=>{
  const owner=await login();
  const person=await call(owner,'POST','/employees',{code:`MANUAL-TRAVEL-${Date.now()}`,name:'Manual Travel QA',joinDate:'2039-01-01',compensationEffectiveFrom:'2039-01-01',payBasis:'Daily rate',payFrequency:'Daily',dailyRate:1600,epfEligible:false,etfEligible:false});
  assert.equal(person.status,201);const employeeId=person.body.id;
  const input={kind:'Travel',calculationMethod:'Manual',employeeId,workDate:'2039-02-01',amount:875,source:'Management instruction',notes:'Approved fixed travel allowance'};
  for(const bad of [{amount:0},{amount:-1},{notes:''},{workDate:'2039-02-30'}])assert.equal((await call(owner,'POST','/payroll/inputs',{...input,...bad})).status,400);
  const preview=await call(owner,'POST','/payroll/inputs',{...input,preview:true});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.calculation.allowance,875);assert.equal(preview.body.calculation.travelHours,0);
  const created=await call(owner,'POST','/payroll/inputs',input);assert.equal(created.status,201);
  for(const status of ['Confirmed','Approved'])assert.equal((await call(owner,'PATCH',`/payroll/inputs/${created.body.id}/review`,{status,reason:'Verified fixed travel approval'})).status,200);
  const run=await call(owner,'POST','/payroll',{companyId:1,payFrequency:'Daily',periodStart:'2039-02-01',periodEnd:'2039-02-01'});assert.equal(run.status,201,JSON.stringify(run.body));
  const slip=(await call(owner,'GET',`/payroll/${run.body.id}`)).body.payslips.find(row=>row.employeeCode===person.body.code);
  assert.equal(Number(slip.allowanceTotal),875);assert.equal(Number(slip.travelOtPay),0);assert.equal(Number(slip.netPay),875);
  const calculated=await call(owner,'POST','/payroll/inputs',{employeeId,kind:'Travel',workDate:'2039-02-02',projectId:1,departure:'07:00',arrival:'08:00',hours:1,distance:60,source:'Signed timesheet',preview:true});
  assert.equal(calculated.status,200,JSON.stringify(calculated.body));assert.equal(calculated.body.calculation.travelHours,1);assert.notEqual(calculated.body.calculation.method,'Manual');
});

test('batch payroll allowances preview separately and save atomically without duplicates',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');const ids=[];
  for(let i=0;i<2;i++){
    const person=await call(owner,'POST','/employees',{code:`BATCH-CLAIM-${Date.now()}-${i}`,name:`Batch Allowance QA ${i}`,joinDate:'2040-01-01',compensationEffectiveFrom:'2040-01-01'});
    assert.equal(person.status,201);ids.push(person.body.id);
  }
  const claim={kind:'Travel',calculationMethod:'Manual',workDate:'2040-02-01',amount:875,source:'Management instruction',notes:'Same fixed travel allowance for team'};
  const body={employeeIds:ids,claim};
  assert.equal((await call(site,'POST','/payroll/inputs/batch',body)).status,403);
  assert.equal((await call(owner,'POST','/payroll/inputs/batch',{...body,employeeIds:[ids[0],ids[0]]})).status,400);
  const preview=await call(owner,'POST','/payroll/inputs/batch',{...body,claim:{...claim,preview:true}});
  assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.results.length,2);
  for(const row of preview.body.results)assert.equal(row.calculation.allowance,875);
  const count=async()=>{const [[row]]=await admin.query(`SELECT COUNT(*) n FROM ${testDatabase}.hr_payroll_claims WHERE employee_id IN (?,?)`,ids);return Number(row.n);};
  assert.equal(await count(),0);
  assert.equal((await call(owner,'POST','/payroll/inputs/batch',{...body,employeeIds:[ids[0],999999999]})).status,400);
  assert.equal(await count(),0,'failed second employee rolls back the first claim');
  const saved=await call(owner,'POST','/payroll/inputs/batch',body);assert.equal(saved.status,201,JSON.stringify(saved.body));
  assert.equal(saved.body.results.length,2);assert.equal(await count(),2);
  assert.equal((await call(owner,'POST','/payroll/inputs/batch',body)).status,409);assert.equal(await count(),2);
});

test('QS printable applications and payment letters persist authoring details and percentage-valued sums',async()=>{
  const owner=await login(),site=await login('store@gkuc.lk');
  const project=await call(owner,'POST','/projects',{companyId:1,name:`Printable QS ${Date.now()}`,client:'Document Client',manager:'Project Manager',site:'Office',stage:'Planning'});
  assert.equal(project.status,201,JSON.stringify(project.body));
  const schedule=await call(owner,'POST','/progress-claims/schedules',{projectId:project.body.id,source:'QS prepared',revisionReason:'Prepare printable application',items:[
    {code:'A-1',basis:'Note',description:'Preliminaries\nContract conditions apply.',unit:'Note',quantity:1,rate:0},
    {code:'A-2',basis:'Percentage',description:'Insurance',unit:'P.S',quantity:1,rate:165000},
    {code:'A-4',basis:'Percentage',description:'Contractor facilities',unit:'L.Sum',quantity:1,rate:50000}]});
  assert.equal(schedule.status,201,JSON.stringify(schedule.body));
  assert.equal((await call(owner,'PATCH',`/progress-claims/schedules/${schedule.body.id}`,{status:'Internally approved',reference:'Approved QS valuation'})).status,204);
  const body={scheduleId:schedule.body.id,applicationDate:'2042-03-01',periodFrom:'2042-02-01',periodTo:'2042-02-28',quantities:{'A-1':0,'A-2':1,'A-4':.8},
    documentDetails:{billNumber:'02',projectReference:'S/232/26',recipientTitle:'Deputy General Manager',recipientOrganisation:'Example Corporation',recipientAddress:'P.O. Box 56\nRajagiriya',signatoryName:'Authorised Signatory',signatoryDesignation:'Managing Director',letterBody:'Please arrange payment for bill 02.\n<script>unsafe()</script>'}};
  const claim=await call(owner,'POST','/progress-claims',body);assert.equal(claim.status,201,JSON.stringify(claim.body));
  assert.equal((await call(site,'PUT',`/progress-claims/${claim.body.id}`,body)).status,403);
  const document=await fetch(`${base}/progress-claims/${claim.body.id}/document?type=application`,{headers:{authorization:`Bearer ${owner}`}});
  const html=await document.text();assert.equal(document.status,200);assert.match(html,/Interim Payment Application No 02/);assert.match(html,/80%/);assert.match(html,/40,000.00/);assert.match(html,/205,000.00/);
  const letter=await fetch(`${base}/progress-claims/${claim.body.id}/document?type=letter`,{headers:{authorization:`Bearer ${owner}`}});
  const text=await letter.text();assert.match(text,/Deputy General Manager/);assert.match(text,/Authorised Signatory/);assert.match(text,/&lt;script&gt;/);assert.doesNotMatch(text,/<script>unsafe/);
  const {documentDetails,...oldClientBody}=body;
  assert.equal((await call(owner,'PUT',`/progress-claims/${claim.body.id}`,oldClientBody)).status,204);
  const data=await call(owner,'GET','/progress-claims?companyId=1');
  const saved=data.body.claims.find(row=>row.id===claim.body.id);
  assert.equal(saved.document_details.billNumber,'02');assert.equal(Number(saved.submitted_amount),205000);
  assert.equal(saved.invoice_id,null,'printing claims must not create invoices or income');
  assert.equal((await call(owner,'PATCH',`/progress-claims/${claim.body.id}/status`,{status:'Submitted',reason:'Send approved application'})).status,204);
  assert.equal((await call(owner,'PUT',`/progress-claims/${claim.body.id}`,body)).status,409);
});

test('progress claims freeze BOQ versions, separate certification and reuse one receivable for optional invoicing and payments',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const project=await call(owner,'POST','/projects',{companyId:1,name:`Progress billing QA ${Date.now()}`,client:'Progress Client',manager:'Project Manager',site:'QA Site',stage:'Planning'});
  assert.equal(project.status,201,JSON.stringify(project.body));const projectId=project.body.id;
  const scheduleBody={projectId,source:'QS prepared',revisionReason:'Initial measured valuation schedule',items:[{code:'D1',description:'Drainage work',unit:'m',quantity:100,rate:100}]};
  assert.equal((await call(site,'POST','/progress-claims/schedules',scheduleBody)).status,403);
  const schedule=await call(owner,'POST','/progress-claims/schedules',scheduleBody);assert.equal(schedule.status,201,JSON.stringify(schedule.body));
  const application={scheduleId:schedule.body.id,applicationDate:'2042-02-28',periodFrom:'2042-02-01',periodTo:'2042-02-28',quantities:{D1:30}};
  assert.equal((await call(owner,'POST','/progress-claims',application)).status,409);
  assert.equal((await call(owner,'PUT',`/progress-claims/schedules/${schedule.body.id}`,scheduleBody)).status,204);
  assert.equal((await call(owner,'PATCH',`/progress-claims/schedules/${schedule.body.id}`,{status:'Internally approved',reference:'Approved QS estimate QA'})).status,204);
  const claim=await call(owner,'POST','/progress-claims',application);assert.equal(claim.status,201,JSON.stringify(claim.body));
  assert.equal((await call(owner,'DELETE',`/progress-claims/schedules/${schedule.body.id}`,{reason:'Cannot delete a used version'})).status,409);
  assert.equal((await call(owner,'PUT',`/progress-claims/${claim.body.id}`,{...application,quantities:{D1:35}})).status,204);
  assert.equal((await call(owner,'PUT',`/progress-claims/${claim.body.id}`,application)).status,204);
  assert.equal((await call(owner,'POST','/progress-claims',application)).status,409);
  assert.equal((await call(owner,'PUT',`/progress-claims/schedules/${schedule.body.id}`,scheduleBody)).status,409);
  assert.equal((await call(owner,'POST','/progress-claims/schedules',scheduleBody)).status,409);
  assert.equal((await call(owner,'PATCH',`/progress-claims/${claim.body.id}/status`,{status:'Submitted',reason:'Measured works submitted'})).status,204);
  assert.equal((await call(owner,'PUT',`/progress-claims/${claim.body.id}`,application)).status,409);
  const certificate={certificateReference:'CLIENT-PC-1',certifiedDate:'2042-03-01',dueDate:'2042-03-15',quantities:{D1:20},retention:200,retentionReleaseDate:'2043-03-01',advance:300,other:10,stampDuty:25,vatRate:18,taxBasis:'After recoveries',reason:'Client measured twenty metres only'};
  assert.equal((await call(site,'POST',`/progress-claims/${claim.body.id}/certify`,certificate)).status,403);
  assert.equal((await call(owner,'POST',`/progress-claims/${claim.body.id}/certify`,{...certificate,quantities:{D1:31}})).status,400);
  const certified=await call(owner,'POST',`/progress-claims/${claim.body.id}/certify`,certificate);assert.equal(certified.status,201,JSON.stringify(certified.body));
  assert.equal(certified.body.gross,2000);assert.equal(certified.body.net,1733.2);
  assert.equal((await call(owner,'POST',`/progress-claims/${claim.body.id}/certify`,certificate)).status,409);
  const invoiceId=certified.body.invoiceId;
  assert.equal((await call(owner,'POST',`/receivables/invoices/${invoiceId}/receipts`,{amount:1000,receivedDate:'2042-03-02',method:'Bank transfer',reference:'PROGRESS-PAY-1'})).status,201);
  assert.equal((await call(owner,'POST',`/progress-claims/${claim.body.id}/invoice`,{})).status,201);
  assert.equal((await call(owner,'POST',`/progress-claims/${claim.body.id}/invoice`,{})).status,409);
  const [[count]]=await admin.query(`SELECT COUNT(*) n,SUM(paid_amount) paid FROM ${testDatabase}.client_invoices WHERE project_id=?`,[projectId]);
  assert.equal(Number(count.n),1);assert.equal(Number(count.paid),1000);
  const legacyInvoice=await call(owner,'POST','/receivables/invoices',{companyId:1,projectId,kind:'Interim',title:'Must not create another balance',invoiceDate:'2042-03-01',taxTreatment:'Exempt',documentType:'Invoice',items:[{description:'Duplicate progress work',quantity:1,rate:2000}]});
  assert.equal(legacyInvoice.status,409,JSON.stringify(legacyInvoice.body));
  const [[tax]]=await admin.query(`SELECT taxable_base FROM ${testDatabase}.client_invoices WHERE id=?`,[invoiceId]);assert.equal(Number(tax.taxable_base),1490);
  assert.equal((await call(owner,'PATCH',`/progress-claims/schedules/${schedule.body.id}`,{status:'Client agreed',reference:'Signed client measurement agreement'})).status,204);
  const doc=await fetch(`${base}/progress-claims/${claim.body.id}/document`,{headers:{authorization:`Bearer ${owner}`}});
  assert.equal(doc.status,200);const html=await doc.text();assert.ok(html.includes('Internally approved'));assert.ok(html.includes('3,000.00'));
  const ticket=await call(owner,'POST','/document-download-tickets',{path:`/progress-claims/${claim.body.id}/document?type=application&download=pdf`});
  assert.equal(ticket.status,200,JSON.stringify(ticket.body));
  assert.equal((await fetch(`http://127.0.0.1:${port}${ticket.body.url.replace('type=application','type=letter')}`)).status,401);
  const pdf=await fetch(`http://127.0.0.1:${port}${ticket.body.url}`);assert.equal(pdf.status,200);
  assert.match(pdf.headers.get('content-type'),/^application\/pdf/);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  assert.equal((await fetch(`http://127.0.0.1:${port}${ticket.body.url}`)).status,401);
  assert.equal((await call(owner,'POST','/progress-claims/schedules',{...scheduleBody,items:[{...scheduleBody.items[0],rate:200}]})).status,409);
  const revision=await call(owner,'POST','/progress-claims/schedules',{...scheduleBody,revisionReason:'Add new approved extra work',items:[...scheduleBody.items,{code:'V1',description:'Extra work',unit:'sum',quantity:1,rate:500}]});
  assert.equal(revision.status,201,JSON.stringify(revision.body));
  assert.equal((await call(owner,'PATCH',`/progress-claims/schedules/${revision.body.id}`,{status:'Internally approved',reference:'Approved variation QA'})).status,204);
  const next=await call(owner,'POST','/progress-claims',{...application,scheduleId:revision.body.id,applicationDate:'2042-03-31',periodFrom:'2042-02-01',periodTo:'2042-03-31',quantities:{D1:40,V1:1}});
  assert.equal(next.status,201,JSON.stringify(next.body));
  const all=await call(owner,'GET','/progress-claims?companyId=1');
  assert.equal(Number(all.body.claims.find(row=>row.id===next.body.id).submitted_amount),2500,'uses certified 2000 baseline, not claimed 3000 or paid 1000');
  assert.equal((await call(owner,'GET','/progress-claims?companyId=2')).body.claims.some(row=>row.id===claim.body.id),false);
});

test('unused approved valuation BOQ deletion is audited and restores the original billing route',async()=>{
  const owner=await login(),site=await login('supervisor@gkuc.lk');
  const project=await call(owner,'POST','/projects',{companyId:1,name:`Delete test valuation ${Date.now()}`,client:'QA client',manager:'Project Manager',site:'QA site',stage:'Planning'});
  assert.equal(project.status,201);
  const created=await call(owner,'POST','/progress-claims/schedules',{projectId:project.body.id,source:'QS prepared',revisionReason:'Temporary test valuation',items:[{code:'A1',description:'Test item',unit:'sum',quantity:1,rate:100}]});
  assert.equal(created.status,201);const id=created.body.id;
  assert.equal((await call(owner,'PATCH',`/progress-claims/schedules/${id}`,{status:'Internally approved',reference:'Test approval'})).status,204);
  assert.equal((await call(site,'DELETE',`/progress-claims/schedules/${id}`,{reason:'Test removal'})).status,403);
  assert.equal((await call(owner,'DELETE',`/progress-claims/schedules/${id}`,{reason:''})).status,400);
  assert.equal((await call(owner,'DELETE',`/progress-claims/schedules/${id}`,{reason:'Remove test valuation'})).status,204);
  const [[row]]=await admin.query(`SELECT billing_route FROM ${testDatabase}.projects WHERE id=?`,[project.body.id]);assert.equal(row.billing_route,'Quotation and invoice');
  const [logs]=await admin.query(`SELECT before_json FROM ${testDatabase}.audit_logs WHERE entity='progress_schedule' AND entity_id=? AND action='DELETE'`,[String(id)]);
  assert.equal(logs.length,1);const snapshot=typeof logs[0].before_json==='string'?JSON.parse(logs[0].before_json):logs[0].before_json;assert.equal(snapshot.status,'Internally approved');
  assert.equal((await call(owner,'DELETE',`/progress-claims/schedules/${id}`,{reason:'Repeat deletion'})).status,404);
});

test('payment suspension blocks business data while status and session hygiene remain available',async()=>{
  const owner=await login();
  try {
    await admin.query(`UPDATE ${testDatabase}.system_access_state
      SET status='payment_overdue',message='Payment test lock' WHERE id=1`);
    const statusResponse=await fetch(`${base}/service-status`);
    assert.equal(statusResponse.status,200);
    const status=await statusResponse.json();
    assert.equal(status.status,'payment_overdue');
    assert.equal(status.message,'Payment test lock');

    const blocked=await call(owner,'GET','/bootstrap');
    assert.equal(blocked.status,423);
    assert.equal(blocked.body.code,'PAYMENT_OVERDUE');
    assert.equal(blocked.body.serviceAccess.status,'payment_overdue');

    const stillCanLogin=await fetch(`${base}/auth/login`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})
    });
    assert.equal(stillCanLogin.status,200);
    const loginBody=await stillCanLogin.json();
    const logout=await fetch(`${base}/auth/logout`,{
      method:'POST',headers:{authorization:`Bearer ${loginBody.token}`}
    });
    assert.equal(logout.status,204);
    assert.equal((await fetch(`${base}/health`)).status,200);
  } finally {
    await admin.query(`UPDATE ${testDatabase}.system_access_state
      SET status='active',message=NULL WHERE id=1`);
    await fetch(`${base}/service-status`);
  }
});
