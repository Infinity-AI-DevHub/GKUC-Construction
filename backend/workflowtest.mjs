import mysql from 'mysql2/promise';

/*
 * One job, walked through every department.
 *
 * The other suites each prove one module in isolation. This one exists for the joins
 * between them — the places where a real company's work crosses a departmental boundary and
 * a figure has to arrive intact on the other side. A purchase that never becomes a project
 * cost, a certificate that never becomes income, a payroll run that ignores the attendance
 * it was built from: each of those is invisible inside the module that caused it and
 * obvious the moment the two are read together.
 */

const BASE = 'http://127.0.0.1:4400/api';
const stamp = Date.now().toString(36).slice(-5).toUpperCase();

let pass = 0, fail = 0;
const failures = [];
const check = (ok, label, detail = '') => {
  if (ok) pass += 1;
  else { fail += 1; failures.push(`${label} ${detail}`); console.log('   FAIL', label, detail); }
};
const section = name => console.log(`\n=== ${name} ===`);

const db = await mysql.createConnection({
  host: '127.0.0.1', port: 8889, user: 'root', password: 'root', database: 'gkuc_siteops'
});
const scalar = async (sql, params = []) => {
  const [rows] = await db.query(sql, params);
  return rows[0] ? Number(Object.values(rows[0])[0]) : 0;
};

const signIn = async (email, password) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const body = await r.json();
  return body.token || null;
};

const md = await signIn('owner@gkuc.lk', 'GKUC@2026');
if (!md) { console.log('Could not sign in as the MD — is the server running?'); process.exit(1); }

const as = token => async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
};
const call = as(md);
const said = result => (typeof result.body === 'string' ? result.body : JSON.stringify(result.body)).slice(0, 140);

const today = new Date().toISOString().slice(0, 10);
const laterBy = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- projects */
section('a project is opened');

let r = await call('POST', '/projects', {
  name: `Matale Bridge Deck ${stamp}`, client: `Central Provincial Council ${stamp}`,
  manager: 'Kasun Perera', site: 'Matale', stage: 'Substructure', health: 'On track',
  progress: 0, budget: 24000000, startDate: today, endDate: laterBy(180)
});
check(r.status === 201, 'project created', said(r));
const project = r.body?.id;

r = await call('POST', `/projects/${project}/milestones`, {
  title: 'Piling complete', dueDate: laterBy(30), status: 'Pending'
});
check(r.status === 201, 'milestone added', said(r));

r = await call('PATCH', `/projects/${project}`, { progress: 15, stage: 'Piling' });
check(r.status === 200, 'progress updated', said(r));

const backwards = await call('PATCH', `/projects/${project}`, { startDate: laterBy(10), endDate: today });
check(backwards.status === 400, 'a finish date before the start is refused', String(backwards.status));

/* ---------------------------------------------------------------- QS */
section('the quantity surveyor prices it');

r = await call('POST', '/boq', {
  projectId: project, title: `Deck works ${stamp}`,
  items: [
    { category: 'Material', description: 'Grade 40 concrete to deck', unit: 'm3', quantity: 320, rate: 44000 },
    { category: 'Labour', description: 'Placing and finishing', unit: 'm3', quantity: 320, rate: 3800 }
  ]
});
check(r.status === 201, 'BOQ created in the system', said(r));
const boq = r.body?.id;
const boqTotal = 320 * 44000 + 320 * 3800;
check(Math.abs(Number(r.body?.total) - boqTotal) < 1, 'BOQ total is quantity times rate', `${r.body?.total} vs ${boqTotal}`);

r = await call('GET', `/boq/${boq}`);
check(r.status === 200 && r.body.items.length === 2, 'both lines are on it', said(r));
check(r.body.status === 'Draft', 'it arrives as a draft', r.body.status);

r = await call('PATCH', `/boq/${boq}`, { status: 'Approved' });
check([200, 201, 204].includes(r.status), 'BOQ approved', said(r));

r = await call('POST', '/qs/quotations', {
  boqId: boq, clientName: `Central Provincial Council ${stamp}`,
  title: `Deck quotation ${stamp}`, validUntil: laterBy(30), markupPercent: 12
});
check(r.status === 201, 'a quotation is built from the BOQ', said(r));
const quotation = r.body?.id;
if (quotation) {
  r = await call('GET', `/qs/quotations/${quotation}`);
  check(r.status === 200, 'the quotation reads back', said(r));
  check(Number(r.body?.total) > boqTotal, 'the markup is on top of the BOQ',
    `quotation ${r.body?.total} vs boq ${boqTotal}`);
}

/* ------------------------------------------------------- store & purchasing */
section('the store buys what the site needs');

r = await call('POST', '/purchasing/suppliers', {
  name: `Matale Hardware ${stamp}`, contactPerson: 'A. Nimal', phone: '0812234567', email: `nimal${stamp}@example.lk`
});
check(r.status === 201, 'supplier added', said(r));
const supplier = r.body?.id;

r = await call('POST', '/purchasing/requests', {
  projectId: project, neededBy: laterBy(7), notes: `Deck pour ${stamp}`,
  items: [{ description: 'Cement 50kg', unit: 'bag', quantity: 400, estimatedRate: 2450 }]
});
check(r.status === 201, 'purchase request raised', said(r));
const request = r.body?.id;

r = await call('PATCH', `/purchasing/requests/${request}`, { status: 'Approved' });
check([200, 204].includes(r.status), 'request approved', said(r));

r = await call('POST', '/purchasing/orders', {
  requestId: request, supplierId: supplier, projectId: project, orderDate: today,
  items: [{ description: 'Cement 50kg', unit: 'bag', quantity: 400, rate: 2400 }]
});
check(r.status === 201, 'purchase order placed', said(r));
const order = r.body?.id;

r = await call('POST', '/purchasing/invoices', {
  supplierId: supplier, orderId: order, invoiceNo: `SUP-${stamp}`,
  amount: 960000, invoiceDate: today, dueDate: laterBy(30)
});
check(r.status === 201, 'supplier invoice recorded', said(r));
const supplierInvoice = r.body?.id;

/*
 * When the job is charged for what it bought.
 *
 * Not on payment, and not on receipt of anything that goes into the store — that would bill
 * the project for the same tonne of asphalt twice, once when it arrived and again when it
 * was issued. A non-stock line is a cost the moment it arrives, because it never sits in
 * the store to be issued later. Paying the invoice afterwards settles a debt that has
 * already been counted, and must not move the project's cost again.
 */
const costBefore = await scalar('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=?', [project]);
const placed = await call('GET', `/purchasing/orders/${order}`);
const orderLine = placed.body?.items?.[0];
check(Boolean(orderLine), 'the order line reads back', said(placed));

r = await call('POST', `/purchasing/orders/${order}/receive`, {
  lines: [{ itemId: orderLine.id, quantity: 400 }], notes: `Delivered ${stamp}`
});
check(r.status === 200, 'goods received against the order', said(r));
const costReceived = await scalar('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=?', [project]);
check(costReceived - costBefore === 400 * 2400, 'receiving a non-stock line charges the project once',
  `${costBefore} -> ${costReceived}`);

r = await call('POST', `/purchasing/invoices/${supplierInvoice}/payments`, {
  amount: 960000, paidDate: today, method: 'Bank transfer', reference: `PAY-${stamp}`
});
check(r.status === 201, 'the supplier is paid', said(r));
const costAfter = await scalar('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=?', [project]);
check(costAfter === costReceived, 'and paying the invoice does not charge it a second time',
  `${costReceived} -> ${costAfter}`);

const overpay = await call('POST', `/purchasing/invoices/${supplierInvoice}/payments`, {
  amount: 1, paidDate: today, method: 'Bank transfer'
});
check(overpay.status === 409, 'paying more than the invoice is refused', String(overpay.status));

/* ---------------------------------------------------------------- people */
section('people are recorded on site');

r = await call('POST', '/employees', {
  code: `EMP-${stamp}`, name: `Bandula Rathnayake ${stamp}`, designation: 'Mason',
  joinDate: today, status: 'Active', basicSalary: 85000, dailyRate: 3400, overtimeRate: 640
});
check(r.status === 201, 'employee added', said(r));
const employee = r.body?.id;

r = await call('POST', '/attendance', {
  employeeId: employee, name: `Bandula Rathnayake ${stamp}`, role: 'Mason',
  projectId: project, date: today, state: 'On site'
});
check(r.status === 201, 'attendance recorded', said(r));

const duplicate = await call('POST', '/attendance', {
  employeeId: employee, name: `Bandula Rathnayake ${stamp}`, role: 'Mason',
  projectId: project, date: today, state: 'On site'
});
check(duplicate.status >= 400, 'the same person cannot be marked in twice on one day', String(duplicate.status));

r = await call('POST', `/employees/${employee}/leave`, {
  leaveType: 'Casual', fromDate: laterBy(20), toDate: laterBy(21), days: 2, reason: 'Family matter'
});
check(r.status === 201, 'leave requested', said(r));
const leave = r.body?.id;

r = await call('PATCH', `/employees/leave/${leave}`, { status: 'Approved' });
check([200, 204].includes(r.status), 'leave approved', said(r));

r = await call('GET', `/hr/leave-register?year=${today.slice(0, 4)}`);
const registered = r.body?.rows?.find(row => row.id === employee);
check(Boolean(registered), 'the person appears on the leave register');
check(registered && registered.casualTaken >= 2, 'and the approved days are counted against them',
  `casual taken ${registered?.casualTaken}`);

r = await call('GET', `/hr/attendance-register?month=${today.slice(0, 7)}`);
const onRoll = r.body?.rows?.find(row => row.name.includes(stamp));
check(Boolean(onRoll), 'and on the muster roll for the month');
check(onRoll && onRoll.present >= 1, 'marked present for the day recorded', `present ${onRoll?.present}`);

/* ---------------------------------------------------------------- fleet */
section('plant and tools');

r = await call('POST', '/equipment', {
  code: `EQ-${stamp}`, name: `Poker vibrator ${stamp}`, category: 'Concreting',
  status: 'Available', purchaseDate: today, purchaseCost: 145000
});
check(r.status === 201, 'equipment added', said(r));
const asset = r.body?.id;

r = await call('POST', `/equipment/${asset}/assign`, {
  projectId: project, assignedTo: `Bandula Rathnayake ${stamp}`, assignedAt: today,
  dueBack: laterBy(14), issuedCondition: 'Good'
});
check(r.status === 201, 'lent out with a due-back date', said(r));

const twice = await call('POST', `/equipment/${asset}/assign`, {
  projectId: project, assignedTo: 'Somebody Else', assignedAt: today
});
check(twice.status === 409, 'the same asset cannot go out twice', `${twice.status} ${said(twice)}`);

const availability = await call('GET', '/resources/availability');
const seen = availability.body.equipment.filter(row => row.id === asset);
check(seen.length === 1, 'it appears exactly once on the availability board', `${seen.length} rows`);
check(seen[0]?.availability === 'Committed', 'and reads as committed to the site', seen[0]?.availability);

r = await call('POST', `/equipment/${asset}/return`, {
  returnedAt: today, returnedCondition: 'Fair', status: 'Available'
});
check(r.status === 200, 'returned', said(r));
const backOut = await call('POST', `/equipment/${asset}/assign`, {
  projectId: project, assignedTo: 'Second Holder', assignedAt: today
});
check(backOut.status === 201, 'and can go out again once it is back', `${backOut.status} ${said(backOut)}`);

/* ---------------------------------------------------------------- site */
section('the site reports its day');

r = await call('POST', '/reports', {
  projectId: project, reportDate: today, workforce: 18,
  work: 'Deck shuttering to grid 4-7 completed.',
  issue: 'Rain stopped work for one hour', weather: 'Showers', delayHours: 1
});
check(r.status === 201, 'daily report filed', said(r));

r = await call('POST', '/tasks', {
  title: `Strike deck formwork ${stamp}`, projectId: project, assignee: 'Dilan Fernando',
  due: 'Friday', dueDate: laterBy(5), priority: 'High', status: 'Not started', notes: 'After 7-day cure'
});
check(r.status === 201, 'task assigned', said(r));
const task = r.body?.id;

r = await call('PATCH', `/tasks/${task}`, { status: 'Completed' });
check([200, 204].includes(r.status), 'task completed', said(r));

/* ---------------------------------------------------------------- money in */
section('the client is billed and pays');

r = await call('POST', '/receivables/invoices', {
  projectId: project, kind: 'Interim', title: `IPA No. 1 ${stamp}`,
  invoiceDate: today, dueDate: laterBy(30),
  taxTreatment: 'Standard', vatRate: 18, retentionPercent: 10, advanceRecovery: 0,
  items: [{ description: 'Deck concrete to date', unit: 'm3', quantity: 200, rate: 44000 }]
});
check(r.status === 201, 'certificate raised', said(r));
const certificate = r.body;
const work = 200 * 44000;
check(Math.abs(certificate.netPayable - (work + work * 0.18 - work * 0.10)) < 1,
  'net payable is work plus VAT less retention', String(certificate.netPayable));

await call('POST', `/receivables/invoices/${certificate.id}/issue`);
const incomeBefore = await scalar('SELECT COALESCE(SUM(amount),0) FROM incomes WHERE project_id=?', [project]);
r = await call('POST', `/receivables/invoices/${certificate.id}/receipts`, {
  amount: 1000000, receivedDate: today, reference: `BOC-${stamp}`
});
check(r.status === 201, 'a part payment is recorded', said(r));
const incomeAfter = await scalar('SELECT COALESCE(SUM(amount),0) FROM incomes WHERE project_id=?', [project]);
check(incomeAfter - incomeBefore === 1000000, 'and it lands as project income once, for the amount received',
  `${incomeBefore} -> ${incomeAfter}`);

/* -------------------------------------------------- does finance agree? */
section('every department agrees on the figures');

r = await call('GET', '/finance/summary');
const line = r.body?.projects?.find(row => row.projectId === project);
check(Boolean(line), 'the project is on the financial summary');
check(line && Math.abs(line.expenses - costAfter) < 1, 'recorded cost matches the ledger',
  `summary ${line?.expenses} vs ledger ${costAfter}`);
check(line && Math.abs(line.income - incomeAfter) < 1, 'income matches the ledger',
  `summary ${line?.income} vs ledger ${incomeAfter}`);
/*
 * Approving a BOQ writes its total onto the project budget on purpose, so the approved
 * budget is the priced work rather than the figure somebody typed when the job was opened.
 */
check(line && Math.abs(line.budget - boqTotal) < 1,
  'the approved budget is the total of the approved BOQ', `${line?.budget} vs ${boqTotal}`);

const ageing = await call('GET', '/receivables/ageing');
const owed = Number(certificate.netPayable) - 1000000;
const clientRow = ageing.body?.rows?.find(row => row.client.includes(stamp));
check(Boolean(clientRow), 'the client shows on the ageing view');
check(clientRow && Math.abs(Number(clientRow.outstanding) - owed) < 1,
  'owing the balance of the certificate', `${clientRow?.outstanding} vs ${owed}`);

/* ------------------------------------------------- is any of it recorded? */
section('and it is all on the record');

const audited = await scalar(
  "SELECT COUNT(*) FROM audit_logs WHERE entity='project' AND entity_id=?", [project]);
check(audited > 0, 'the project changes are in the audit log', `${audited} entries`);

r = await call('GET', `/projects/${project}`);
check(r.status === 200, 'the project reads back with everything hung off it', said(r));
check(Array.isArray(r.body?.milestones) && r.body.milestones.length >= 1, 'milestones',
  String(r.body?.milestones?.length));

/* ----------------------------------------------------- departmental reach */
section('each department sees its own work and no more');

const people = [
  ['store@gkuc.lk', 'GKUC@2026', '/materials', '/payroll'],
  ['finance@gkuc.lk', 'GKUC@2026', '/finance/summary', '/payroll'],
  ['hr@gkuc.lk', 'Kandy-Viaduct-77-Rail', '/employees', '/finance/expenses'],
  ['qs@gkuc.lk', 'Kandy-Viaduct-77-Rail', '/boq', '/payroll'],
  ['transport@gkuc.lk', 'Kandy-Viaduct-77-Rail', '/fleet', '/employees']
];
for (const [email, password, allowed, forbidden] of people) {
  const token = await signIn(email, password);
  if (!token) { check(false, `${email} can sign in`); continue; }
  const mine = await as(token)('GET', allowed);
  const theirs = await as(token)('GET', forbidden);
  check(mine.status === 200, `${email.padEnd(20)} reaches ${allowed}`, String(mine.status));
  check(theirs.status === 403, `${email.padEnd(20)} is refused ${forbidden}`, String(theirs.status));
}

/* ---------------------------------------------------------------- teardown */

/*
 * The suite runs against the working database, so it clears up after itself.
 *
 * It used to leave its project behind on every run, and the demo filled with "Matale Bridge
 * Deck" jobs that no one had built — they reached the dashboard, the dropdowns, and the
 * evening summary that goes to the Managing Director. A test that dirties the system it is
 * testing stops being something anybody wants to run.
 */
async function removeWhatThisRunCreated() {
  if (!project) return;
  const child = (table, column = 'project_id') => db.query(`DELETE FROM ${table} WHERE ${column}=?`, [project]);
  await db.query(`DELETE FROM client_receipts WHERE invoice_id IN
    (SELECT id FROM client_invoices WHERE project_id=?)`, [project]);
  await db.query(`DELETE FROM client_invoice_items WHERE invoice_id IN
    (SELECT id FROM client_invoices WHERE project_id=?)`, [project]);
  await child('client_invoices');
  await db.query(`DELETE FROM quotation_items WHERE quotation_id IN
    (SELECT id FROM quotations_client WHERE project_id=?)`, [project]);
  await child('quotations_client');
  await db.query('DELETE FROM boq_items WHERE boq_id IN (SELECT id FROM boqs WHERE project_id=?)', [project]);
  await child('boqs');
  await db.query(`DELETE FROM supplier_payments WHERE invoice_id IN (SELECT id FROM supplier_invoices
    WHERE order_id IN (SELECT id FROM purchase_orders WHERE project_id=?))`, [project]);
  await db.query(`DELETE FROM supplier_invoices WHERE order_id IN
    (SELECT id FROM purchase_orders WHERE project_id=?)`, [project]);
  await db.query(`DELETE FROM goods_receipts WHERE order_id IN
    (SELECT id FROM purchase_orders WHERE project_id=?)`, [project]);
  await db.query(`DELETE FROM purchase_order_items WHERE order_id IN
    (SELECT id FROM purchase_orders WHERE project_id=?)`, [project]);
  await child('purchase_orders');
  await db.query(`DELETE FROM purchase_request_items WHERE request_id IN
    (SELECT id FROM purchase_requests WHERE project_id=?)`, [project]);
  await child('purchase_requests');
  await child('equipment_assignments');
  await child('attendance');
  await child('project_team');
  await child('daily_reports');
  await db.query('DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)', [project]);
  await child('tasks');
  await child('project_milestones');
  await child('expenses');
  await child('incomes');
  await child('site_status_log');
  await db.query('UPDATE employees SET current_project_id=NULL WHERE current_project_id=?', [project]);

  if (employee) {
    await db.query('DELETE FROM payslips WHERE employee_id=?', [employee]);
    await db.query('DELETE FROM leave_requests WHERE employee_id=?', [employee]);
    await db.query('DELETE FROM overtime_records WHERE employee_id=?', [employee]);
    await db.query('DELETE FROM attendance WHERE employee_id=?', [employee]);
    await db.query('DELETE FROM employees WHERE id=?', [employee]);
  }
  if (asset) {
    await db.query('DELETE FROM equipment_assignments WHERE equipment_id=?', [asset]);
    await db.query('DELETE FROM equipment WHERE id=?', [asset]);
  }
  if (supplier) {
    await db.query('DELETE FROM quotations WHERE supplier_id=?', [supplier]);
    await db.query('DELETE FROM suppliers WHERE id=?', [supplier]);
  }
  await db.query('DELETE FROM projects WHERE id=?', [project]);
}

try {
  await removeWhatThisRunCreated();
  console.log('\n  (the records this run created have been removed)');
} catch (error) {
  console.log(`\n  NOTE: could not fully clear up after this run — ${error.message}`);
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
if (failures.length) console.log('\n  Unresolved:\n' + failures.map(f => '   - ' + f).join('\n'));
await db.end();
process.exit(fail ? 1 : 0);
