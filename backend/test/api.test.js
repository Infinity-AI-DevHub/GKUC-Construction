import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const port = 43971;
const base = `http://127.0.0.1:${port}/api`;
const testDatabase = 'gkuc_siteops_test';
let server;
let admin;

const today = () => new Date().toISOString().slice(0, 10);
const shift = days => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

before(async () => {
  admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.query(`CREATE DATABASE \`${testDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  server = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DB_NAME: testDatabase }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Test server did not start');
});

after(async () => {
  server?.kill('SIGTERM');
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.end();
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
  assert.equal(body.user.role, 'Owner / Director');
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

  /* Receiving goods charges the project, so budget monitoring reflects it immediately. */
  const expenses = await call(owner, 'GET', '/finance/expenses?projectId=1');
  assert.ok(expenses.body.some(expense => expense.originType === 'purchase_order'));
});

test('issuing stock cannot drive a balance negative', async () => {
  const store = await login('store@gkuc.lk');
  const result = await call(store, 'POST', '/materials/4/movements', { type: 'Issue', quantity: 100000 });
  assert.equal(result.status, 409);
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

  /* The file is served back and appears on the record it belongs to. */
  const served = await fetch(`http://127.0.0.1:${port}${stored.body.url}`);
  assert.equal(served.status, 200);
  const task = await call(owner, 'GET', '/tasks/1');
  assert.ok(task.body.attachments.some(file => file.id === stored.body.id));

  assert.equal((await call(owner, 'DELETE', `/uploads/${stored.body.id}`)).status, 204);
  assert.equal((await fetch(`http://127.0.0.1:${port}${stored.body.url}`)).status, 404, 'deleting removes the object too');
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

  const overtime = await call(supervisor, 'POST', '/employees/2/overtime', { workDate: today(), hours: 4 });
  assert.equal(overtime.status, 201);
  await call(hr, 'PATCH', `/employees/overtime/${overtime.body.id}`, { status: 'Approved' });

  const run = await call(hr, 'POST', '/payroll', { periodStart: shift(-30), periodEnd: today() });
  assert.equal(run.status, 201);
  assert.ok(Number(run.body.total) > 0);

  const detail = await call(hr, 'GET', `/payroll/${run.body.id}`);
  const slip = detail.body.payslips.find(row => row.employeeCode === 'EMP-0002');
  assert.equal(Number(slip.overtimeHours), 4, 'approved overtime reaches the payslip');
  assert.equal(Number(slip.overtimePay), 4 * 620, 'paid at the employee overtime rate');

  assert.equal((await call(hr, 'POST', '/payroll', { periodStart: shift(-30), periodEnd: today() })).status, 409);

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

test('the completion report is assembled from live project data', async () => {
  const owner = await login();
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

test('deactivating a user ends their session', async () => {
  const owner = await login();
  const created = await call(owner, 'POST', '/users', {
    name: 'Temporary Viewer', email: 'temp.viewer@gkuc.lk', password: 'TempPass2026!', role: 'Read-Only Viewer'
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
