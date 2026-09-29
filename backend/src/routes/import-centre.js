import { Router } from 'express';
import crypto from 'node:crypto';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, wrap } from '../lib/http.js';
import { readUpload, readUploadedFile } from '../lib/storage.js';
import { readWorkbook, serialToDate } from '../lib/xlsx.js';

const router = Router();
const definitions = {
  clients: { sheet: 'Clients', key: 'CLIENT_CODE', required: ['CLIENT_TYPE', 'CLIENT_NAME', 'BILLING_ADDRESS', 'ACTIVE'], permission: 'clients.manage' },
  subcontractors: { sheet: 'Subcontractors', key: 'SUBCONTRACTOR_CODE', required: ['NAME', 'CONTACT_TYPE', 'TRADE', 'PHONE', 'ACTIVE'], permission: 'subcontractors.manage' },
  projects: { sheet: 'Projects', key: 'PROJECT_CODE', required: ['COMPANY', 'PROJECT_NAME', 'CLIENT_CODE', 'SITE_ADDRESS', 'PROJECT_MANAGER_EMPLOYEE_CODE', 'STAGE', 'STATUS', 'HEALTH', 'PROGRESS_PERCENT', 'START_DATE'], permission: 'projects.manage' },
  boqs: { sheet: 'BOQ Headers', key: 'BOQ_CODE', required: ['PROJECT_CODE', 'ORIGINAL_REFERENCE', 'TITLE', 'STATUS', 'DECLARED_TOTAL_LKR', 'SOURCE_FILENAME'], permission: 'qs.boq' },
  quotations: { sheet: 'Quotation Headers', key: 'QUOTATION_CODE', required: ['CLIENT_CODE', 'COMPANY', 'ORIGINAL_REFERENCE', 'TITLE', 'QUOTE_DATE', 'STATUS', 'ENGAGEMENT', 'SUBTOTAL_LKR', 'TOTAL_LKR', 'SOURCE_FILENAME'], permission: 'qs.quotation' },
  costs: { sheet: 'Expenses', key: 'EXPENSE_CODE', required: ['PROJECT_CODE', 'EXPENSE_DATE', 'SOURCE', 'COST_TYPE', 'DESCRIPTION', 'AMOUNT_LKR', 'REFERENCE'], permission: 'qs.costControl' },
  retentions: { sheet: 'Retentions', key: 'RETENTION_CODE', required: ['PROJECT_CODE', 'DESCRIPTION', 'AMOUNT_LKR', 'HELD_FROM', 'STATUS'], permission: 'qs.retention' }
};
const supported = new Set(['clients', 'subcontractors', 'projects']);
const clean = value => String(value ?? '').trim();
const asDate = value => typeof value === 'number' ? serialToDate(value) : clean(value).slice(0, 10);
const validDate = value => { const date = asDate(value); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)); };
const canImport = (req, kind) => req.user.permissions.includes(definitions[kind].permission);
const issue = (sheet, row, message) => ({ sheet, row, message });

function readRows(workbook, definition) {
  const sheet = workbook.sheet(definition.sheet);
  if (!sheet) throw Object.assign(new Error(`The ${definition.sheet} sheet is missing. Use the matching GKUC template.`), { status: 422 });
  const headerRow = sheet.rows.findIndex(row => row?.some(cell => clean(cell).replace(/^\*\s*/, '') === definition.key));
  if (headerRow < 0) throw Object.assign(new Error(`The ${definition.sheet} sheet does not have its expected column headings.`), { status: 422 });
  const headers = (sheet.rows[headerRow] || []).map(cell => clean(cell).replace(/^\*\s*/, ''));
  const missing = [definition.key, ...definition.required].filter(key => !headers.includes(key));
  if (missing.length) throw Object.assign(new Error(`${definition.sheet} is missing columns: ${missing.join(', ')}.`), { status: 422 });
  return sheet.rows.slice(headerRow + 1).map((cells, index) => ({
    sheet: definition.sheet, row: headerRow + index + 1,
    data: Object.fromEntries(headers.map((header, col) => [header, cells?.[col] ?? null]).filter(([header]) => header))
  })).filter(record => Object.values(record.data).some(value => clean(value)));
}

function populatedRelatedSheets(workbook, primary) {
  return workbook.names.filter(name => !['Instructions', 'Field Guide', primary].includes(name))
    .filter(name => workbook.sheet(name)?.rows?.slice(4).some(row => row?.some(cell => clean(cell))));
}

async function inspect(kind, rows) {
  const definition = definitions[kind];
  const links = await query('SELECT kind,source_code sourceCode,target_id targetId FROM historical_import_links');
  const link = (type, code) => links.find(row => row.kind === type && row.sourceCode === code);
  const seen = new Set();
  const results = [];
  for (const record of rows) {
    const data = record.data;
    const code = clean(data[definition.key]);
    const errors = [];
    if (!code) errors.push(`${definition.key} is required.`);
    for (const field of definition.required) if (!clean(data[field])) errors.push(`${field.replaceAll('_', ' ').toLowerCase()} is required.`);
    if (code && seen.has(code)) errors.push(`${code} appears more than once in this workbook.`);
    seen.add(code);
    if (/^Example\b/i.test(clean(data.CLIENT_NAME || data.NAME || data.PROJECT_NAME))) errors.push('Replace the template example row with a real record.');
    if (kind === 'clients' && !['Organisation', 'Individual'].includes(clean(data.CLIENT_TYPE))) errors.push('Client type must be Organisation or Individual.');
    if (kind === 'subcontractors' && !['Organisation', 'Individual'].includes(clean(data.CONTACT_TYPE))) errors.push('Contact type must be Organisation or Individual.');
    if (['clients','subcontractors'].includes(kind) && !['Yes','No'].includes(clean(data.ACTIVE))) errors.push('Active must be Yes or No.');
    for (const [field, type] of [['CLIENT_CODE','clients'], ['PROJECT_CODE','projects'], ['BOQ_CODE','boqs'], ['SUBCONTRACTOR_CODE','subcontractors']]) {
      if (field === definition.key || !clean(data[field])) continue;
      if (!link(type, clean(data[field]))) errors.push(`${field.replaceAll('_', ' ')} ${clean(data[field])} has not been imported yet.`);
    }
    if (kind === 'projects') {
      const employee = await getOne('SELECT id FROM employees WHERE code=? LIMIT 1', [clean(data.PROJECT_MANAGER_EMPLOYEE_CODE)]);
      if (!employee) errors.push(`Project manager ${clean(data.PROJECT_MANAGER_EMPLOYEE_CODE)} was not found. Add or correct the employee code first.`);
      if (!['GKUC Construction','GKUC Readymix'].includes(clean(data.COMPANY))) errors.push('Company must be GKUC Construction or GKUC Readymix.');
      if (!['On track','Watch','At risk'].includes(clean(data.HEALTH))) errors.push('Health must be On track, Watch or At risk.');
      if (!['Current','Completed','Archived'].includes(clean(data.STATUS))) errors.push('Status must be Current, Completed or Archived.');
      if (!Number.isFinite(Number(data.PROGRESS_PERCENT)) || Number(data.PROGRESS_PERCENT) < 0 || Number(data.PROGRESS_PERCENT) > 100) errors.push('Progress must be from 0 to 100.');
      if (!validDate(data.START_DATE)) errors.push('Start date is not a valid date.');
      if (clean(data.END_DATE) && !validDate(data.END_DATE)) errors.push('End date is not a valid date.');
      if (clean(data.CURRENT_BUDGET_LKR) && (!Number.isFinite(Number(data.CURRENT_BUDGET_LKR)) || Number(data.CURRENT_BUDGET_LKR) < 0)) errors.push('Current budget must be zero or a positive amount.');
    }
    let existing = link(kind, code);
    if (!existing && kind === 'clients' && clean(data.CLIENT_NAME)) existing = await getOne('SELECT id targetId FROM clients WHERE LOWER(name)=LOWER(?) AND type=?', [clean(data.CLIENT_NAME), clean(data.CLIENT_TYPE) === 'Individual' ? 'Private' : 'Organisation']);
    if (!existing && kind === 'subcontractors' && clean(data.NAME)) existing = await getOne('SELECT id targetId FROM subcontractors WHERE LOWER(name)=LOWER(?)', [clean(data.NAME)]);
    if (!existing && kind === 'projects' && clean(data.PROJECT_NAME)) existing = await getOne('SELECT id targetId FROM projects WHERE LOWER(name)=LOWER(?) AND company_id=?', [clean(data.PROJECT_NAME), clean(data.COMPANY) === 'GKUC Readymix' ? 2 : 1]);
    if (existing && !link(kind, code)) errors.push(`A matching ${kind.slice(0, -1)} already exists in SiteOps. Link it manually before importing to avoid a duplicate.`);
    const action = errors.length ? 'blocked' : link(kind, code) ? 'skip' : supported.has(kind) ? 'create' : 'blocked';
    if (!supported.has(kind)) errors.push('This record type is not yet connected to its live register. It cannot be confirmed safely.');
    results.push({ ...record, code, action, errors });
  }
  return results;
}

router.get('/types', auth, wrap(async (req, res) => res.json(Object.entries(definitions)
  .filter(([kind]) => canImport(req, kind))
  .map(([kind, definition]) => ({ kind, sheet: definition.sheet, importReady: supported.has(kind) })))));

router.get('/batches', auth, wrap(async (req, res) => {
  const allowed = Object.keys(definitions).filter(kind => canImport(req, kind));
  if (!allowed.length) return res.json([]);
  const records = await query(`SELECT id,kind,filename,status,created_at createdAt,confirmed_at confirmedAt,
    preview_json preview FROM historical_import_batches ORDER BY id DESC LIMIT 100`);
  res.json(records.filter(row => allowed.includes(row.kind)).map(({ preview, ...row }) => ({ ...row,
    counts: JSON.parse(preview).counts })));
}));

router.post('/dry-check', auth, wrap(async (req, res) => {
  const { file, fields, discard } = await readUpload(req);
  try {
    const kind = clean(fields.kind);
    if (!definitions[kind]) return res.status(400).json({ error: 'Choose one of the seven GKUC historical templates.' });
    if (!canImport(req, kind)) return res.status(403).json({ error: 'You do not have access to import this register.' });
    if (!/\.xlsx$/i.test(file.filename)) return res.status(422).json({ error: 'Use an Excel .xlsx template.' });
    const buffer = await readUploadedFile(file.path);
    if (buffer.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'This workbook is too large. Split it into smaller periods.' });
    const workbook = readWorkbook(buffer);
    const rows = readRows(workbook, definitions[kind]);
    const checked = await inspect(kind, rows);
    const related = populatedRelatedSheets(workbook, definitions[kind].sheet);
    if (related.length) for (const row of checked) {
      row.errors.push(`The ${related.join(', ')} sheet${related.length === 1 ? ' has' : 's have'} rows that this import cannot safely create yet.`);
      row.action = 'blocked';
    }
    const counts = Object.fromEntries(['create','skip','blocked'].map(action => [action, checked.filter(row => row.action === action).length]));
    const preview = { kind, sheets: workbook.names, rows: checked, counts, sourceTotal: checked.reduce((sum, row) => sum + Number(row.data.AMOUNT_LKR || row.data.TOTAL_LKR || row.data.DECLARED_TOTAL_LKR || row.data.CONTRACT_VALUE_LKR || 0), 0) };
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const result = await query('INSERT INTO historical_import_batches (kind,filename,checksum,preview_json,uploaded_by) VALUES (?,?,?,?,?)',
      [kind, file.filename.slice(0, 190), checksum, JSON.stringify(preview), req.user.id]);
    await audit(pool, req.user.id, 'IMPORT_DRY_CHECK', 'historical_import', result.insertId, null, { kind, counts, checksum }, req.ip);
    res.status(201).json({ id: result.insertId, ...preview });
  } finally { await discard(); }
}));

router.get('/batches/:id', auth, wrap(async (req, res) => {
  const batch = await getOne('SELECT id,kind,filename,status,preview_json preview,created_at createdAt,confirmed_at confirmedAt FROM historical_import_batches WHERE id=?', [req.params.id]);
  if (!batch) return res.status(404).json({ error: 'Import review not found.' });
  if (!canImport(req, batch.kind)) return res.status(403).json({ error: 'You cannot view this import.' });
  res.json({ ...batch, preview: JSON.parse(batch.preview) });
}));

router.post('/batches/:id/confirm', auth, wrap(async (req, res) => {
  const batch = await getOne('SELECT * FROM historical_import_batches WHERE id=?', [req.params.id]);
  if (!batch) return res.status(404).json({ error: 'Import review not found.' });
  if (!canImport(req, batch.kind)) return res.status(403).json({ error: 'You cannot confirm this import.' });
  if (!supported.has(batch.kind)) return res.status(409).json({ error: 'This template is available for checking, but importing it is not yet safe. No records were changed.' });
  if (batch.status !== 'Review') return res.status(409).json({ error: 'This workbook has already been imported.' });
  const preview = JSON.parse(batch.preview_json);
  if (preview.rows.some(row => row.action === 'blocked')) return res.status(409).json({ error: 'Resolve every issue in the dry-check report and upload the corrected workbook first.' });
  const checked = await inspect(batch.kind, preview.rows.map(({ sheet, row, data }) => ({ sheet, row, data })));
  if (checked.some(row => row.action === 'blocked')) return res.status(409).json({ error: 'The data changed since the dry check. Run a new dry check before confirming.', rows: checked });
  const created = await transaction(async connection => {
    const locked = await connection.execute('SELECT status FROM historical_import_batches WHERE id=? FOR UPDATE', [batch.id]);
    if (locked[0][0]?.status !== 'Review') throw Object.assign(new Error('This workbook was already imported.'), { status: 409 });
    let count = 0;
    for (const record of checked.filter(row => row.action === 'create')) {
      const d = record.data;
      let id;
      if (batch.kind === 'clients') {
        const [result] = await connection.execute(`INSERT INTO clients
          (type,name,registration_number,tin,vat_number,billing_address,site_address,phone,email,contact_person,active,notes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [clean(d.CLIENT_TYPE) === 'Individual' ? 'Private' : 'Organisation', clean(d.CLIENT_NAME), clean(d.BUSINESS_REGISTRATION_NO) || null,
          clean(d.TIN) || null, clean(d.VAT_NUMBER) || null, clean(d.BILLING_ADDRESS), clean(d.SITE_ADDRESS) || null,
          clean(d.PHONE) || null, clean(d.EMAIL) || null, clean(d.CONTACT_PERSON) || null, /^yes$/i.test(clean(d.ACTIVE)) ? 1 : 0, clean(d.NOTES) || null]);
        id = result.insertId;
      } else if (batch.kind === 'subcontractors') {
        const [result] = await connection.execute(`INSERT INTO subcontractors
          (name,trade,contact_person,phone,email,notes,active,address,business_id,contact_type)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [clean(d.NAME), clean(d.TRADE), clean(d.CONTACT_PERSON) || null, clean(d.PHONE), clean(d.EMAIL) || null,
          clean(d.NOTES) || null, /^yes$/i.test(clean(d.ACTIVE)) ? 1 : 0, clean(d.ADDRESS) || null,
          clean(d.BUSINESS_REGISTRATION_NO) || null, clean(d.CONTACT_TYPE) === 'Individual' ? 'Individual' : 'Company']);
        id = result.insertId;
      } else {
        const [client] = await connection.execute('SELECT target_id FROM historical_import_links WHERE kind=? AND source_code=?', ['clients', clean(d.CLIENT_CODE)]);
        const [employee] = await connection.execute('SELECT id,name FROM employees WHERE code=? LIMIT 1', [clean(d.PROJECT_MANAGER_EMPLOYEE_CODE)]);
        if (!client[0] || !employee[0]) throw Object.assign(new Error(`Project ${record.code} has a missing client or manager. Run the dry check again.`), { status: 409 });
        const [result] = await connection.execute(`INSERT INTO projects
          (name,client,client_id,manager,manager_employee_id,progress,budget,health,stage,site,start_date,end_date,active,company_id)
          SELECT ?,c.name,c.id,?,?,?,?,?,?,?,?,?,?,? FROM clients c WHERE c.id=?`,
          [clean(d.PROJECT_NAME), employee[0].name, employee[0].id, Number(d.PROGRESS_PERCENT), Number(d.CURRENT_BUDGET_LKR || 0), clean(d.HEALTH),
            clean(d.STAGE), clean(d.SITE_ADDRESS), asDate(d.START_DATE), d.END_DATE ? asDate(d.END_DATE) : null,
            clean(d.STATUS) === 'Archived' ? 0 : 1, clean(d.COMPANY) === 'GKUC Readymix' ? 2 : 1, client[0].target_id]);
        id = result.insertId;
      }
      await connection.execute('INSERT INTO historical_import_links (kind,source_code,target_id,batch_id) VALUES (?,?,?,?)', [batch.kind, record.code, id, batch.id]);
      count += 1;
    }
    await connection.execute("UPDATE historical_import_batches SET status='Imported',confirmed_by=?,confirmed_at=NOW() WHERE id=?", [req.user.id, batch.id]);
    await audit(connection, req.user.id, 'IMPORT_CONFIRM', 'historical_import', batch.id, null, { kind: batch.kind, created: count, skipped: checked.length - count }, req.ip);
    return count;
  });
  res.json({ id: batch.id, status: 'Imported', created, skipped: checked.length - created });
}));

export default router;
