import { Router } from 'express';
import crypto from 'node:crypto';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, wrap, fail } from '../lib/http.js';
import { readUpload, readUploadedFile } from '../lib/storage.js';
import { readWorkbook, serialToDate } from '../lib/xlsx.js';
import { parseBoqWorkbook } from '../lib/boq-template.js';
import { parseBoqPdf } from '../lib/boq-pdf.js';
import { optionsFor } from '../lib/options.js';

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

const boqProblems = row => {
  const errors = [];
  if (!clean(row.description)) errors.push('Enter the work description.');
  if (!clean(row.unit)) errors.push('Enter the unit.');
  if (!Number.isFinite(Number(row.quantity)) || Number(row.quantity) <= 0) errors.push('Quantity must be more than zero.');
  if (!Number.isFinite(Number(row.rate)) || Number(row.rate) < 0) errors.push('Rate must be zero or more.');
  return errors;
};

async function flexibleBoqPreview(file) {
  const isPdf = file.mime === 'application/pdf' || /\.pdf$/i.test(file.filename || '');
  if (!isPdf && !/\.xlsx$/i.test(file.filename || '')) throw fail(422, 'Upload an Excel .xlsx file or a PDF.');
  const parsed = isPdf
    ? await parseBoqPdf(file.path)
    : parseBoqWorkbook(await readUploadedFile(file.path), { categories: await optionsFor('boq.category') });
  if (!parsed.ok) throw fail(422, parsed.error);
  const clientName = clean(parsed.client);
  const matchingClient = clientName
    ? await getOne('SELECT id,name FROM clients WHERE active=1 AND LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [clientName])
    : null;
  const projectName = clean(parsed.title);
  const matchingProject = projectName
    ? await getOne('SELECT id,name,client_id clientId FROM projects WHERE active=1 AND LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [projectName])
    : null;
  const rows = parsed.items.map((item, index) => {
    const data = { category: item.category || '', description: item.description || '', unit: item.unit || '',
      quantity: item.quantity ?? '', rate: item.rate ?? '', method: item.method || '', notes: item.notes || '' };
    const errors = [...new Set([...(item.problems || []), ...boqProblems(data)])];
    return { sheet: item.sourceSheet || parsed.sheet || (isPdf ? 'PDF' : 'Workbook'),
      row: item.sheetRow || item.sourceRow || index + 1, code: String(index + 1),
      action: errors.length ? 'blocked' : 'create', errors, data };
  });
  const document = { title: clean(parsed.title) || file.filename.replace(/\.(xlsx|pdf)$/i, ''),
    reference: clean(parsed.layout?.reference), documentDate: clean(parsed.layout?.documentDate),
    location: clean(parsed.layout?.location), notes: '', companyId: 1,
    clientId: matchingClient?.id || null, clientType: 'Organisation', clientName,
    clientRegistrationNumber: '', clientTin: '', clientVatNumber: '', clientAddress: '',
    clientPhone: '', clientEmail: '', clientContactPerson: '',
    projectId: matchingProject?.id || null, projectName, projectSite: clean(parsed.layout?.location),
    projectManager: '', projectStartDate: clean(parsed.layout?.documentDate) };
  const counts = { create: rows.filter(row => row.action === 'create').length, skip: 0,
    blocked: rows.filter(row => row.action === 'blocked').length };
  return { mode: 'document-review', kind: 'boqs',
    sheets: parsed.layout?.sheets || [parsed.sheet || (isPdf ? 'PDF' : 'Workbook')], document, rows, counts,
    sourceTotal: rows.reduce((sum, row) => sum + Number(row.data.quantity || 0) * Number(row.data.rate || 0), 0) };
}

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
  .map(([kind, definition]) => ({ kind, sheet: definition.sheet, importReady: supported.has(kind) || kind === 'boqs' })))));

router.get('/review-context', auth, permit('qs.boq'), wrap(async (req, res) => {
  const [clients, projects, companies] = await Promise.all([
    query('SELECT id,name FROM clients WHERE active=1 ORDER BY name'),
    query(`SELECT p.id,p.name,p.client_id clientId,COALESCE(c.name,p.client) client,p.company_id companyId
      FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.active=1 ORDER BY p.name`),
    query('SELECT id,name FROM companies WHERE active=1 ORDER BY id')
  ]);
  res.json({ clients, projects, companies,
    canCreateClient: req.user.permissions.includes('clients.manage'),
    canCreateProject: req.user.permissions.includes('projects.manage') });
}));

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
    if (kind === 'boqs') {
      const preview = await flexibleBoqPreview(file);
      const source = await readUploadedFile(file.path);
      const checksum = crypto.createHash('sha256').update(source).digest('hex');
      const result = await query('INSERT INTO historical_import_batches (kind,filename,checksum,preview_json,uploaded_by) VALUES (?,?,?,?,?)',
        [kind, file.filename.slice(0, 190), checksum, JSON.stringify(preview), req.user.id]);
      await audit(pool, req.user.id, 'IMPORT_DRY_CHECK', 'historical_import', result.insertId, null,
        { kind, counts: preview.counts, checksum, mode: preview.mode }, req.ip);
      return res.status(201).json({ id: result.insertId, ...preview });
    }
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
  } finally { await discard().catch(error => console.error('Could not clean up historical import upload', error)); }
}));

router.patch('/batches/:id/review', auth, permit('qs.boq'), wrap(async (req, res) => {
  const batch = await getOne('SELECT * FROM historical_import_batches WHERE id=?', [req.params.id]);
  if (!batch || batch.kind !== 'boqs') return res.status(404).json({ error: 'BOQ import review not found.' });
  if (batch.status !== 'Review') return res.status(409).json({ error: 'This import has already been completed.' });
  const current = JSON.parse(batch.preview_json);
  if (current.mode !== 'document-review') return res.status(409).json({ error: 'Upload this older source document again to use the editable review.' });
  const document = { ...current.document, ...(req.body.document || {}) };
  if (!clean(document.title)) throw fail(400, 'Enter the BOQ title.');
  const rows = Array.isArray(req.body.rows) ? req.body.rows.map((row, index) => {
    const data = { category: clean(row.data?.category), description: clean(row.data?.description), unit: clean(row.data?.unit),
      quantity: row.data?.quantity, rate: row.data?.rate, method: clean(row.data?.method), notes: clean(row.data?.notes) };
    const errors = boqProblems(data);
    return { sheet: clean(row.sheet) || 'Document', row: Number(row.row) || index + 1,
      code: String(index + 1), action: errors.length ? 'blocked' : 'create', errors, data };
  }) : current.rows;
  const counts = { create: rows.filter(row => row.action === 'create').length, skip: 0,
    blocked: rows.filter(row => row.action === 'blocked').length };
  const preview = { ...current, document, rows, counts,
    sourceTotal: rows.reduce((sum, row) => sum + Number(row.data.quantity || 0) * Number(row.data.rate || 0), 0) };
  await query('UPDATE historical_import_batches SET preview_json=? WHERE id=?', [JSON.stringify(preview), batch.id]);
  await audit(pool, req.user.id, 'UPDATE_REVIEW', 'historical_import', batch.id, null, { kind: 'boqs', counts }, req.ip);
  res.json({ id: batch.id, status: batch.status, ...preview });
}));

router.get('/batches/:id', auth, wrap(async (req, res) => {
  const batch = await getOne('SELECT id,kind,filename,status,preview_json preview,created_at createdAt,confirmed_at confirmedAt FROM historical_import_batches WHERE id=?', [req.params.id]);
  if (!batch) return res.status(404).json({ error: 'Import review not found.' });
  if (!canImport(req, batch.kind)) return res.status(403).json({ error: 'You cannot view this import.' });
  res.json({ ...batch, preview: JSON.parse(batch.preview) });
}));

async function confirmFlexibleBoq(req, batch, preview) {
  if (preview.rows.some(row => boqProblems(row.data || {}).length))
    throw fail(409, 'Correct every highlighted BOQ line and save the review before importing.');
  if (!preview.rows.length) throw fail(400, 'Add at least one BOQ line.');
  const d = preview.document || {};
  if (!clean(d.title)) throw fail(400, 'Enter the BOQ title.');
  const mayCreateClient = req.user.permissions.includes('clients.manage');
  const mayCreateProject = req.user.permissions.includes('projects.manage');
  const reference = await nextReference('BOQ', 'boqs');
  return transaction(async connection => {
    const [[locked]] = await connection.execute('SELECT status FROM historical_import_batches WHERE id=? FOR UPDATE', [batch.id]);
    if (locked?.status !== 'Review') throw fail(409, 'This document was already imported.');
    let project;
    if (Number(d.projectId)) {
      const [[found]] = await connection.execute(`SELECT p.id,p.name,p.client_id clientId,COALESCE(c.name,p.client) client
        FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=? AND p.active=1`, [Number(d.projectId)]);
      if (!found) throw fail(400, 'Choose an active project.');
      project = found;
    } else {
      if (!mayCreateProject) throw fail(403, 'This BOQ needs a new project. Ask a project administrator to create it, then select it here.');
      let client;
      if (Number(d.clientId)) {
        const [[found]] = await connection.execute('SELECT id,name FROM clients WHERE id=? AND active=1', [Number(d.clientId)]);
        if (!found) throw fail(400, 'Choose an active client.');
        client = found;
      } else {
        if (!mayCreateClient) throw fail(403, 'This BOQ needs a new client. Ask a client administrator to create it, then select it here.');
        if (!clean(d.clientName)) throw fail(400, 'Enter the new client name or choose an existing client.');
        const [[existing]] = await connection.execute('SELECT id,name FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [clean(d.clientName)]);
        if (existing) client = existing;
        else {
          const [created] = await connection.execute(`INSERT INTO clients
            (type,name,registration_number,tin,vat_number,billing_address,phone,email,contact_person,active)
            VALUES (?,?,?,?,?,?,?,?,?,1)`, [clean(d.clientType) === 'Individual' ? 'Private' : 'Organisation', clean(d.clientName),
            clean(d.clientRegistrationNumber) || null, clean(d.clientTin) || null, clean(d.clientVatNumber) || null,
            clean(d.clientAddress) || '', clean(d.clientPhone) || null, clean(d.clientEmail) || null,
            clean(d.clientContactPerson) || null]);
          client = { id: created.insertId, name: clean(d.clientName) };
        }
      }
      if (!clean(d.projectName)) throw fail(400, 'Enter the new project name or choose an existing project.');
      const companyId = Number(d.companyId) || 1;
      const [[company]] = await connection.execute('SELECT id FROM companies WHERE id=? AND active=1', [companyId]);
      if (!company) throw fail(400, 'Choose the operating company for this project.');
      const [[existingProject]] = await connection.execute(
        'SELECT id,name,client_id clientId,client FROM projects WHERE active=1 AND company_id=? AND LOWER(name)=LOWER(?) ORDER BY id LIMIT 1',
        [companyId, clean(d.projectName)]);
      if (existingProject) project = existingProject;
      else {
        const [created] = await connection.execute(`INSERT INTO projects
          (name,client,client_id,manager,progress,budget,health,stage,site,start_date,active,company_id)
          VALUES (?,?,?,?,0,0,'On track','Historical import',?,?,1,?)`,
        [clean(d.projectName), client.name, client.id, clean(d.projectManager) || req.user.name,
          clean(d.projectSite) || clean(d.location) || 'Not specified', validDate(d.projectStartDate) ? asDate(d.projectStartDate) : null, companyId]);
        project = { id: created.insertId, name: clean(d.projectName), clientId: client.id, client: client.name };
      }
    }
    const total = preview.rows.reduce((sum, row) => sum + Number(row.data.quantity) * Number(row.data.rate), 0);
    const sourceNotes = [batch.filename ? `Imported from ${batch.filename}` : null,
      clean(d.reference) ? `Source reference: ${clean(d.reference)}` : null,
      clean(d.documentDate) ? `Source date: ${clean(d.documentDate)}` : null,
      clean(d.notes)].filter(Boolean).join('\n').slice(0, 1000) || null;
    const [createdBoq] = await connection.execute(`INSERT INTO boqs
      (project_id,reference,title,status,total,prepared_by,notes) VALUES (?,?,?,'Draft',?,?,?)`,
    [project.id, reference, clean(d.title), total, req.user.id, sourceNotes]);
    for (const row of preview.rows) {
      const item = row.data;
      await connection.execute(`INSERT INTO boq_items
        (boq_id,category,description,unit,quantity,rate,amount,method,notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [createdBoq.insertId, clean(item.category) || null, clean(item.description), clean(item.unit), Number(item.quantity),
        Number(item.rate), Number(item.quantity) * Number(item.rate), clean(item.method) || null, clean(item.notes) || null]);
    }
    await connection.execute("UPDATE historical_import_batches SET status='Imported',confirmed_by=?,confirmed_at=NOW() WHERE id=?",
      [req.user.id, batch.id]);
    await connection.execute('INSERT INTO historical_import_links (kind,source_code,target_id,batch_id) VALUES (?,?,?,?)',
      ['boqs', `DOCUMENT-${batch.id}`, createdBoq.insertId, batch.id]);
    await audit(connection, req.user.id, 'IMPORT_CONFIRM', 'historical_import', batch.id, null,
      { kind: 'boqs', boqId: createdBoq.insertId, projectId: project.id, reference, rows: preview.rows.length, total }, req.ip);
    return { id: batch.id, status: 'Imported', created: 1, skipped: 0, boqId: createdBoq.insertId,
      projectId: project.id, reference };
  });
}

router.post('/batches/:id/confirm', auth, wrap(async (req, res) => {
  const batch = await getOne('SELECT * FROM historical_import_batches WHERE id=?', [req.params.id]);
  if (!batch) return res.status(404).json({ error: 'Import review not found.' });
  if (!canImport(req, batch.kind)) return res.status(403).json({ error: 'You cannot confirm this import.' });
  if (batch.status !== 'Review') return res.status(409).json({ error: 'This workbook has already been imported.' });
  const preview = JSON.parse(batch.preview_json);
  if (batch.kind === 'boqs' && preview.mode === 'document-review')
    return res.json(await confirmFlexibleBoq(req, batch, preview));
  if (!supported.has(batch.kind)) return res.status(409).json({ error: 'This template is available for checking, but importing it is not yet safe. No records were changed.' });
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
