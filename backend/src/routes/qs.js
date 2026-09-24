import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, spendSql, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { checksumFile, contentMatchesType, isLocalStore, localPathFor, readUpload, remove, signedDownloadUrl, store } from '../lib/storage.js';
import { parseSubcontractQuotePdf, suggestSubcontractors } from '../lib/subcontract-quote-pdf.js';
import { parseTenderPdf } from '../lib/tender-pdf.js';
import { commitmentsDocument, documentContext, quotationDocument } from '../lib/documents.js';
import { sendDocument } from '../lib/document-pdf.js';
import { notify } from '../alerts.js';
import { resolveProjectManager } from '../lib/project-manager.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const quotationVisibility = z.object({
  company: z.object({
    logo: z.boolean(), name: z.boolean(), address: z.boolean(), telephone: z.boolean(),
    email: z.boolean(), tin: z.boolean(), vatNumber: z.boolean(), svatNumber: z.boolean(),
    bankDetails: z.boolean()
  }).strict(),
  client: z.object({
    name: z.boolean(), billingAddress: z.boolean(), siteAddress: z.boolean(),
    contactPerson: z.boolean(), phone: z.boolean(), alternatePhone: z.boolean(), email: z.boolean(),
    city: z.boolean(), district: z.boolean(), province: z.boolean(), country: z.boolean(),
    registrationNumber: z.boolean(), tin: z.boolean(), vatNumber: z.boolean(), project: z.boolean()
  }).strict()
}).strict();

const parsePresentation = value => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

async function quotationIdentity(companyId, clientId, fallbackName = '') {
  const [{ company }, client] = await Promise.all([
    documentContext(getOne, companyId),
    clientId ? getOne(`SELECT name,billing_address billingAddress,site_address siteAddress,
      contact_person contactPerson,phone,alternate_phone alternatePhone,email,city,district,province,country,
      registration_number registrationNumber,
      COALESCE(NULLIF(tin,''),tax_number) tin,vat_number vatNumber
      FROM clients WHERE id=? AND active=1`, [clientId]) : null
  ]);
  if (!company) return null;
  return {
    company: { name: company.name, address: company.address, telephone: company.telephone,
      email: company.email, tin: company.tin, vatNumber: company.vatNumber, svatNumber: company.svatNumber,
      bankDetails: company.bankDetails },
    client: client || { name: fallbackName }
  };
}

async function quotationPresentation(companyId, clientId, projectName, bankAccountId, visibility, fallbackName = '') {
  const identity = await quotationIdentity(companyId, clientId, fallbackName);
  if (!identity) return null;
  const bank = bankAccountId ? await getOne(`SELECT label,bank_name bankName,branch,
    account_name accountName,account_number accountNumber,swift_code swiftCode
    FROM company_bank_accounts WHERE id=? AND company_id=? AND active=1`, [bankAccountId, companyId]) : null;
  return JSON.stringify({ show: visibility, company: identity.company,
    client: { ...identity.client, project: projectName || null }, bank });
}

/* ------------------------------------------------------------------ Quotations */

const quoteSelect = `SELECT q.id,q.reference,q.title,q.client_name client,q.client_id clientId,q.location,q.contact,q.engagement,q.main_contractor mainContractor,q.quote_date quoteDate,q.valid_until validUntil,
  q.subtotal,q.markup_percent markupPercent,q.vat_percent vatPercent,q.total,q.status,q.notes,q.terms,
  q.payment_terms paymentTerms,q.additional_notes additionalNotes,q.bank_account_id bankAccountId,q.presentation,
  q.company_id companyId,c.name company,q.boq_id boqId,b.reference boqReference,q.project_id projectId,p.name project,q.inquiry_id inquiryId,u.name preparedBy
  FROM quotations_client q LEFT JOIN boqs b ON b.id=q.boq_id LEFT JOIN projects p ON p.id=q.project_id
  JOIN companies c ON c.id=q.company_id JOIN users u ON u.id=q.prepared_by`;

router.get('/quotations', auth, permit('qs.view'), wrap(async (req, res) => {
  const companyId=Number(req.query.companyId);
  res.json(await query(`${quoteSelect} ${companyId>0?'WHERE q.company_id=?':''} ORDER BY q.id DESC`,companyId>0?[companyId]:[]));
}));

router.get('/quotation-identity', auth, permit('qs.view', 'qs.quotation'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  const clientId = Number(req.query.clientId);
  if (!Number.isInteger(companyId) || companyId < 1 || !Number.isInteger(clientId) || clientId < 1)
    return res.status(400).json({ error: 'Choose an operating company and a saved client first.' });
  const identity = await quotationIdentity(companyId, clientId);
  if (!identity?.client?.name) return res.status(404).json({ error: 'The selected company or client is unavailable.' });
  res.json(identity);
}));

router.get('/quotations/:id', auth, permit('qs.view'), wrap(async (req, res) => {
  const quotation = await getOne(`${quoteSelect} WHERE q.id=?`, [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  const items = await query('SELECT id,method_id methodId,category,area,description,unit,quantity,rate,amount,method_statement methodStatement,material_id materialId,source_subquote_id sourceSubquoteId FROM quotation_items WHERE quotation_id=? ORDER BY id',
    [quotation.id]);
  res.json({ ...quotation, presentation: parsePresentation(quotation.presentation), items });
}));

/**
 * PID v3 §3.3 — "QS builds the quotation directly from the BOQ already in the system —
 * materials, labour and equipment costs carry across automatically, rather than being
 * retyped." Because the figures come from the BOQ rather than a separate document, the
 * quoted price and the working budget cannot quietly drift apart.
 */
/**
 * The quotation as a client-ready document. PID v3 §3.3 — "generated in a clean, consistent
 * GKUC format, ready to send to the client". It is produced from the record itself, so the
 * figure quoted and the figure the project is measured against cannot drift apart.
 */
router.get('/quotations/:id/document', auth, permit('qs.view'), wrap(async (req, res) => {
  const quotation = await getOne(`${quoteSelect} WHERE q.id=?`, [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });

  const [items, context, client, bankAccount] = await Promise.all([
    query(`SELECT category,area,description,unit,quantity,rate,amount,method_statement methodStatement
      FROM quotation_items WHERE quotation_id=? ORDER BY id`, [quotation.id]),
    documentContext(getOne, quotation.companyId),
    quotation.clientId ? getOne(`SELECT COALESCE(NULLIF(tin,''),tax_number) clientTin,vat_number clientVatNumber,
      billing_address clientAddress,phone clientPhone FROM clients WHERE id=?`, [quotation.clientId]) : null,
    quotation.bankAccountId ? getOne(`SELECT label,bank_name bankName,branch,account_name accountName,
      account_number accountNumber,swift_code swiftCode FROM company_bank_accounts
      WHERE id=? AND company_id=?`, [quotation.bankAccountId, quotation.companyId]) : null
  ]);

  const page = quotationDocument({
    ...context,
    /* The select names the client column `client`; the document speaks in client names. */
    quotation: { ...quotation, presentation: parsePresentation(quotation.presentation),
      clientName: quotation.client, ...client }, bankAccount,
    items: items.map((item, index) => ({ ...item, reference: index + 1 }))
  });

  await sendDocument(req, res, page, `${quotation.reference}.pdf`);
}));

/*
 * A BOQ is usually titled with the site already in it — "Riverside Residences — structural
 * package". Prefixing the project name again produced "Riverside Residences — Riverside
 * Residences — structural package" on the client's quotation.
 */
const describe = boq => (boq.title?.toLowerCase().includes(String(boq.project || '').toLowerCase())
  ? boq.title
  : `${boq.project} — ${boq.title}`);

/**
 * The catalogue of work methods — the list a quotation is built from.
 *
 * Grouped by category so the QS picks "the surfacing options" rather than scrolling one
 * long list, which is how these quotations are actually put together: two or three ways to
 * do the same job, offered side by side.
 */
router.get('/methods', auth, permit('qs.view', 'qs.quotation'), wrap(async (_req, res) =>
  res.json(await query(`SELECT id,code,name,category,description,unit,default_rate defaultRate,
    method_statement methodStatement,payment_terms paymentTerms
    FROM work_methods WHERE active=1 ORDER BY category,name`))));

router.post('/methods', auth, permit('qs.quotation'), validate(z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(180),
  category: z.string().min(2).max(60).default('Surfacing'),
  description: z.string().max(600).default(''),
  unit: z.string().min(1).max(20),
  defaultRate: z.number().nonnegative().default(0),
  methodStatement: z.string().max(2000).optional(),
  paymentTerms: z.string().max(1000).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query(`INSERT INTO work_methods
      (code,name,category,description,unit,default_rate,method_statement,payment_terms)
      VALUES (?,?,?,?,?,?,?,?)`,
    [body.code, body.name, body.category, body.description, body.unit, body.defaultRate,
      body.methodStatement || null, body.paymentTerms || null]);
    const row = await getOne('SELECT * FROM work_methods WHERE id=?', [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'work_method', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That method is already in the list' });
    throw error;
  }
}));

router.patch('/methods/:id', auth, permit('qs.quotation'), validate(z.object({
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(2).max(180).optional(),
  category: z.string().min(2).max(60).optional(),
  unit: z.string().min(1).max(20).optional(),
  defaultRate: z.number().nonnegative().optional(),
  description: z.string().max(600).optional(),
  methodStatement: z.string().max(2000).optional(),
  paymentTerms: z.string().max(1000).optional(),
  active: z.boolean().optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM work_methods WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Method not found' });
  const columns = { defaultRate: 'default_rate', methodStatement: 'method_statement', paymentTerms: 'payment_terms' };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE work_methods SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), req.params.id]);
  }
  const after = await getOne('SELECT * FROM work_methods WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'work_method', after.id, before, after, req.ip);
  res.json(after);
}));

router.get('/quotation-note-templates', auth, permit('qs.view', 'qs.quotation'), wrap(async (_req, res) => {
  res.json(await query(`SELECT id,name,body FROM quotation_note_templates WHERE active=1 ORDER BY name`));
}));

router.post('/quotation-note-templates', auth, permit('qs.quotation'), validate(z.object({
  name: z.string().trim().min(2).max(120),
  body: z.string().trim().min(2).max(1000)
})), wrap(async (req, res) => {
  try {
    const result = await query('INSERT INTO quotation_note_templates (name,body) VALUES (?,?)',
      [req.body.name, req.body.body]);
    const row = await getOne('SELECT id,name,body FROM quotation_note_templates WHERE id=?', [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'quotation_note_template', row.id, null, row, req.ip);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A note template with that name already exists.' });
    throw error;
  }
}));

router.patch('/quotation-note-templates/:id', auth, permit('qs.quotation'), validate(z.object({
  name: z.string().trim().min(2).max(120),
  body: z.string().trim().min(2).max(1000)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT id,name,body FROM quotation_note_templates WHERE id=? AND active=1', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Note template not found.' });
  try {
    await query('UPDATE quotation_note_templates SET name=?,body=? WHERE id=?',
      [req.body.name, req.body.body, before.id]);
    const after = await getOne('SELECT id,name,body FROM quotation_note_templates WHERE id=?', [before.id]);
    await audit(pool, req.user.id, 'UPDATE', 'quotation_note_template', before.id, before, after, req.ip);
    res.json(after);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A note template with that name already exists.' });
    throw error;
  }
}));

/**
 * A quotation built by choosing methods rather than from a bill of quantities.
 *
 * This is how GKUC quotes small works: the client wants a yard surfaced, and the quotation
 * offers tar, asphalt and concrete side by side at their own rates. The methods chosen also
 * name the quotation and form its reference — GKUC/2026/Aug./Tar,Asp./058 — so the filing
 * follows from the work instead of being typed by hand.
 */
router.post('/quotations/from-methods', auth, permit('qs.quotation'), validate(z.object({
  companyId: z.number().int().positive().default(1),
  clientName: z.string().min(2).max(180).optional(),
  clientId: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
  inquiryId: z.number().int().positive().optional(),
  location: z.string().max(180).optional(),
  contact: z.string().max(120).optional(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  vatPercent: z.number().min(0).max(100).default(18),
  notes: z.string().max(1000).optional(),
  paymentTerms: z.string().max(1000).optional(),
  visibility: quotationVisibility.optional(),
  lines: z.array(z.object({
    methodId: z.number().int().positive(),
    description: z.string().max(300).optional(),
    quantity: z.number().positive(),
    rate: z.number().nonnegative().optional()
  })).min(1).max(60)
}).refine(value => value.clientId || value.clientName, { message: 'Choose a client', path: ['clientId'] })), wrap(async (req, res) => {
  const body = req.body;
  let client = body.clientId
    ? await getOne('SELECT id,name,contact_person contactPerson,site_address siteAddress,billing_address billingAddress FROM clients WHERE id=? AND active=1', [body.clientId])
    : await getOne('SELECT id,name,contact_person contactPerson,site_address siteAddress,billing_address billingAddress FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [body.clientName]);
  if (!client && body.clientName && !body.clientId) {
    const created = await query("INSERT INTO clients (type,name) VALUES ('Organisation',?)", [body.clientName]);
    client = { id: created.insertId, name: body.clientName };
  }
  if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });
  if (body.projectId) {
    const project = await getOne('SELECT id,client_id clientId FROM projects WHERE id=? AND company_id=?', [body.projectId, body.companyId]);
    if (!project) return res.status(400).json({ error: 'That project belongs to the other company' });
    if (project.clientId && Number(project.clientId) !== Number(client.id)) return res.status(400).json({ error: 'The quotation client must match the selected project client.' });
  }
  if (body.inquiryId) {
    const inquiry = await getOne('SELECT id FROM inquiries WHERE id=? AND company_id=?', [body.inquiryId, body.companyId]);
    if (!inquiry) return res.status(400).json({ error: 'That inquiry belongs to the other company' });
  }
  const ids = [...new Set(body.lines.map(line => line.methodId))];
  const methods = await query(
    `SELECT * FROM work_methods WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (methods.length !== ids.length) return res.status(404).json({ error: 'One of those methods no longer exists' });

  const byId = new Map(methods.map(method => [method.id, method]));
  const priced = body.lines.map(line => {
    const method = byId.get(line.methodId);
    /* The catalogue rate is a starting point; the quoted rate wins when one is given. */
    const rate = line.rate ?? Number(method.default_rate);
    return {
      methodId: method.id,
      category: method.category,
      area: method.category,
      description: line.description || [method.name, method.description].filter(Boolean).join(' — '),
      methodStatement: method.method_statement,
      unit: method.unit,
      quantity: line.quantity,
      rate,
      amount: Number((line.quantity * rate).toFixed(2))
    };
  });

  const subtotal = priced.reduce((sum, line) => sum + line.amount, 0);
  const total = subtotal * (1 + body.vatPercent / 100);

  /* The methods offered, in the order they appear, name the quotation. */
  const codes = [...new Set(priced.map(line => byId.get(line.methodId).code))];
  const names = [...new Set(priced.map(line => byId.get(line.methodId).name))];
  const reference = await nextReference('QUO', 'quotations_client');

  /* Where a method has no terms of its own, the first one that does speaks for the job. */
  const terms = body.paymentTerms
    || methods.map(method => method.payment_terms).find(Boolean)
    || null;
  const project = body.projectId ? await getOne('SELECT name FROM projects WHERE id=?', [body.projectId]) : null;
  const presentation = body.visibility ? await quotationPresentation(
    body.companyId, client.id, project?.name, null, body.visibility) : null;

  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO quotations_client
      (company_id,reference,project_id,inquiry_id,client_id,client_name,title,quote_date,valid_until,subtotal,
       markup_percent,vat_percent,total,notes,method_codes,location,contact,payment_terms,presentation,prepared_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?)`,
    [body.companyId, reference, body.projectId || null, body.inquiryId || null, client.id, client.name,
      names.join(' / '), body.quoteDate || today(), body.validUntil || null, subtotal,
      body.vatPercent, total, body.notes || null, codes.join(','),
      body.location || client.siteAddress || client.billingAddress || null, body.contact || client.contactPerson || null,
      terms, presentation, req.user.id]);

    for (const line of priced) {
      await connection.execute(`INSERT INTO quotation_items
        (quotation_id,method_id,category,area,description,method_statement,unit,quantity,rate,amount) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [result.insertId, line.methodId, line.category, line.area, line.description, line.methodStatement, line.unit,
        line.quantity, line.rate, line.amount]);
    }
    await audit(connection, req.user.id, 'CREATE', 'quotation', result.insertId, null,
      { reference, total, methods: names }, req.ip);
    return result.insertId;
  });

  res.status(201).json(await getOne(`${quoteSelect} WHERE q.id=?`, [id]));
}));

/** A free-form client quotation for work that has no BOQ or catalogue method yet. */
router.post('/quotations/manual', auth, permit('qs.quotation'), validate(z.object({
  companyId: z.number().int().positive(),
  clientId: z.number().int().positive(),
  projectId: z.number().int().positive().optional(),
  title: z.string().min(3).max(200),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  markupPercent: z.number().min(0).max(100).default(0),
  vatPercent: z.number().min(0).max(100).default(0),
  notes: z.string().max(1000).optional(),
  terms: z.string().max(2000).optional(),
  paymentTerms: z.string().max(2000).optional(),
  additionalNotes: z.string().max(2000).optional(),
  bankAccountId: z.number().int().positive().optional(),
  visibility: quotationVisibility.optional(),
  lines: z.array(z.object({
    methodId: z.number().int().positive().optional(),
    subQuotationId: z.number().int().positive().optional(),
    subcontractMarkupPercent: z.number().min(0).max(200).optional(),
    category: z.string().min(1).max(40),
    area: z.string().max(120).optional(),
    description: z.string().min(2).max(300),
    methodStatement: z.string().max(3000).optional(),
    unit: z.string().min(1).max(30),
    quantity: z.number().positive(),
    rate: z.number().nonnegative()
  }).refine(line => !(line.methodId && line.subQuotationId), {
    message: 'A quotation line cannot use both a saved template and a subcontractor quotation.'
  })).min(1).max(100)
})), wrap(async (req, res) => {
  const body = req.body;
  const client = await getOne(`SELECT id,name,contact_person contactPerson,
    COALESCE(site_address,billing_address) location FROM clients WHERE id=? AND active=1`, [body.clientId]);
  if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });

  let project = null;
  if (body.projectId) {
    project = await getOne('SELECT id,name,client_id clientId FROM projects WHERE id=? AND company_id=? AND active=1',
      [body.projectId, body.companyId]);
    if (!project) return res.status(400).json({ error: 'That project does not belong to the selected company.' });
    if (project.clientId && Number(project.clientId) !== Number(client.id))
      return res.status(400).json({ error: 'The quotation client must match the selected project client.' });
  }

  const methodIds = [...new Set(body.lines.map(line => line.methodId).filter(Boolean))];
  const subQuotationIds = [...new Set(body.lines.map(line => line.subQuotationId).filter(Boolean))];
  const methods = methodIds.length ? await query(
    `SELECT id FROM work_methods WHERE active=1 AND id IN (${methodIds.map(() => '?').join(',')})`, methodIds) : [];
  if (methods.length !== methodIds.length) return res.status(400).json({ error: 'One of the selected quotation templates is no longer available.' });
  const subQuotations = subQuotationIds.length ? await query(
    `SELECT id,company_id companyId,project_id projectId,total,status FROM subcontractor_quotations
     WHERE id IN (${subQuotationIds.map(() => '?').join(',')})`, subQuotationIds) : [];
  if (subQuotations.length !== subQuotationIds.length) return res.status(400).json({ error: 'One of the selected subcontractor quotations no longer exists.' });
  const subById = new Map(subQuotations.map(row => [Number(row.id), row]));
  for (const line of body.lines.filter(item => item.subQuotationId)) {
    const source = subById.get(Number(line.subQuotationId));
    if (!project) return res.status(400).json({ error: 'Choose a project before adding a subcontractor quotation.' });
    if (Number(source.companyId) !== Number(body.companyId) || Number(source.projectId) !== Number(project.id))
      return res.status(400).json({ error: 'That subcontractor quotation is not linked to the selected project.' });
    if (['Rejected', 'Superseded'].includes(source.status))
      return res.status(409).json({ error: `That subcontractor quotation was ${source.status.toLowerCase()}.` });
  }

  const lines = body.lines.map(line => {
    const source = line.subQuotationId ? subById.get(Number(line.subQuotationId)) : null;
    const quantity = source ? 1 : line.quantity;
    const rate = source
      ? Math.round(Number(source.total) * (1 + Number(line.subcontractMarkupPercent || 0) / 100) * 100) / 100
      : line.rate;
    return { ...line, quantity, rate, amount: Math.round(quantity * rate * 100) / 100 };
  });
  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const markedUp = subtotal * (1 + body.markupPercent / 100);
  const total = Math.round(markedUp * (1 + body.vatPercent / 100) * 100) / 100;
  const reference = await nextReference('QUO', 'quotations_client');
  if (body.bankAccountId && !await getOne('SELECT id FROM company_bank_accounts WHERE id=? AND company_id=? AND active=1', [body.bankAccountId, body.companyId]))
    return res.status(400).json({ error: 'Choose an active bank account for the selected company.' });
  const presentation = body.visibility ? await quotationPresentation(
    body.companyId, client.id, project?.name, body.bankAccountId, body.visibility) : null;

  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO quotations_client
      (company_id,reference,project_id,client_id,client_name,title,quote_date,valid_until,subtotal,
       markup_percent,vat_percent,total,notes,terms,payment_terms,additional_notes,bank_account_id,location,contact,presentation,prepared_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.companyId, reference, project?.id || null, client.id, client.name, body.title,
      body.quoteDate || today(), body.validUntil || null, subtotal, body.markupPercent,
      body.vatPercent, total, body.notes || null, body.terms || null, body.paymentTerms || null,
      body.additionalNotes || null, body.bankAccountId || null, client.location || null,
      client.contactPerson || null, presentation, req.user.id]);
    for (const line of lines) {
      await connection.execute(`INSERT INTO quotation_items
        (quotation_id,method_id,category,area,description,method_statement,unit,quantity,rate,amount,source_subquote_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [result.insertId, line.methodId || null, line.category, line.area || line.category, line.description,
        line.methodStatement || null, line.unit, line.quantity, line.rate, line.amount, line.subQuotationId || null]);
    }
    await audit(connection, req.user.id, 'CREATE', 'quotation', result.insertId, null,
      { reference, source: 'Manual', total, lines: lines.length }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${quoteSelect} WHERE q.id=?`, [id]));
}));

router.post('/quotations', auth, permit('qs.quotation'), validate(z.object({
  boqId: z.number().int().positive(),
  clientId: z.number().int().positive().optional(),
  clientName: z.string().min(2).max(180).optional(),
  title: z.string().min(3).max(200).optional(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  markupPercent: z.number().min(0).max(100).default(0),
  vatPercent: z.number().min(0).max(100).default(0),
  inquiryId: z.number().int().positive().optional(),
  /* GKUC are hired as a subcontractor as often as they hire one. Same document, different
     footing — recording which is which is what makes "how much of our work is subcontracted
     in" answerable. */
  engagement: z.enum(['Direct', 'As subcontractor']).default('Direct'),
  mainContractor: z.string().max(180).optional(),
  notes: z.string().max(1000).optional(),
  paymentTerms: z.string().max(2000).optional(), additionalNotes: z.string().max(2000).optional(),
  bankAccountId: z.number().int().positive().optional(),
  visibility: quotationVisibility.optional()
})), wrap(async (req, res) => {
  const boq = await getOne(`SELECT b.*,p.name project,COALESCE(c.name,p.client) client,p.client_id clientId,p.company_id,
    c.contact_person clientContact,COALESCE(c.site_address,c.billing_address) clientLocation
    FROM boqs b JOIN projects p ON p.id=b.project_id LEFT JOIN clients c ON c.id=p.client_id WHERE b.id=?`,
    [req.body.boqId]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  if (req.body.clientId && Number(req.body.clientId) !== Number(boq.clientId))
    return res.status(400).json({ error: 'The selected client does not match this BOQ’s project.' });
  const items = await query('SELECT category,description,unit,quantity,rate,amount,material_id materialId FROM boq_items WHERE boq_id=? ORDER BY id', [boq.id]);
  if (!items.length) return res.status(409).json({ error: 'That BOQ has no priced lines to quote from' });

  const subtotal = items.reduce((sum, item) => sum + Number(item.amount), 0);
  const withMarkup = subtotal * (1 + req.body.markupPercent / 100);
  const total = withMarkup * (1 + req.body.vatPercent / 100);
  const reference = await nextReference('QUO', 'quotations_client');
  if (req.body.bankAccountId && !await getOne('SELECT id FROM company_bank_accounts WHERE id=? AND company_id=? AND active=1', [req.body.bankAccountId, boq.company_id]))
    return res.status(400).json({ error: 'Choose an active bank account for this project company.' });
  const presentation = req.body.visibility ? await quotationPresentation(
    boq.company_id, boq.clientId, boq.project, req.body.bankAccountId, req.body.visibility, boq.client) : null;

  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO quotations_client
      (company_id,reference,boq_id,project_id,inquiry_id,client_id,client_name,title,quote_date,valid_until,subtotal,
       markup_percent,vat_percent,total,notes,payment_terms,additional_notes,bank_account_id,engagement,main_contractor,location,contact,presentation,prepared_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [boq.company_id, reference, boq.id, boq.project_id, req.body.inquiryId || null, boq.clientId,
      boq.client, req.body.title || describe(boq),
      req.body.quoteDate || today(), req.body.validUntil || null, subtotal,
      req.body.markupPercent, req.body.vatPercent, total, req.body.notes || null,
      req.body.paymentTerms || null, req.body.additionalNotes || null, req.body.bankAccountId || null,
      req.body.engagement, req.body.mainContractor || null, boq.clientLocation || null, boq.clientContact || null,
      presentation, req.user.id]);
    /* The lines are copied, not referenced: a later BOQ edit must not silently restate a
       quotation the client has already been given. */
    for (const item of items) {
      await connection.execute(`INSERT INTO quotation_items (quotation_id,category,description,unit,quantity,rate,amount,material_id)
        VALUES (?,?,?,?,?,?,?,?)`,
      [result.insertId, item.category, item.description, item.unit, item.quantity, item.rate, item.amount,item.materialId]);
    }
    await audit(connection, req.user.id, 'CREATE', 'quotation', result.insertId, null, { reference, total }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${quoteSelect} WHERE q.id=?`, [id]));
}));

/**
 * Accepting a quotation makes it the project's budget — "what the client agreed to is
 * exactly what the project is measured against".
 */
/**
 * Amends a quotation. Beyond its status, the wording that appears on the client's document
 * can be corrected here — a title, the client's name, the covering note and terms specific
 * to this one job — without touching the priced lines or the standing terms every other
 * document carries.
 */
router.patch('/quotations/:id', auth, permit('qs.quotation'), validate(z.object({
  status: z.enum(['Draft', 'Sent', 'Accepted', 'Declined', 'Expired']).optional(),
  title: z.string().min(3).max(200).optional(),
  clientName: z.string().min(2).max(180).optional(),
  clientId: z.number().int().positive().optional(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
  paymentTerms: z.string().max(2000).nullable().optional(),
  additionalNotes: z.string().max(2000).nullable().optional(),
  bankAccountId: z.number().int().positive().nullable().optional(),
  visibility: quotationVisibility.optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })),
wrap(async (req, res) => {
  const quotation = await getOne('SELECT * FROM quotations_client WHERE id=?', [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });

  /* An accepted quotation is what the client agreed to; its wording stops being ours to
     rewrite, though its status can still move on. */
  const rewording = ['title', 'clientName', 'clientId', 'quoteDate', 'validUntil', 'notes', 'terms',
    'paymentTerms', 'additionalNotes', 'bankAccountId', 'visibility']
    .some(field => req.body[field] !== undefined);
  if (rewording && quotation.status === 'Accepted') {
    return res.status(409).json({ error: 'An accepted quotation cannot be reworded. Raise a new one instead.' });
  }

  const columns = {
    title: 'title', quoteDate: 'quote_date',
    validUntil: 'valid_until', notes: 'notes', terms: 'terms', paymentTerms: 'payment_terms',
    additionalNotes: 'additional_notes', bankAccountId: 'bank_account_id'
  };
  const edits = Object.entries(columns).filter(([key]) => req.body[key] !== undefined);
  if (req.body.bankAccountId && !await getOne(
    'SELECT id FROM company_bank_accounts WHERE id=? AND company_id=? AND active=1',
    [req.body.bankAccountId, quotation.company_id]))
    return res.status(400).json({ error: 'Choose an active bank account for this quotation’s company.' });
  if (req.body.clientId || req.body.clientName) {
    const client = req.body.clientId
      ? await getOne('SELECT id,name FROM clients WHERE id=? AND active=1', [req.body.clientId])
      : await getOne('SELECT id,name FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [req.body.clientName]);
    if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });
    if (quotation.project_id) {
      const project = await getOne('SELECT client_id clientId FROM projects WHERE id=?', [quotation.project_id]);
      if (project?.clientId && Number(project.clientId) !== Number(client.id))
        return res.status(400).json({ error: 'The quotation client must match the project client.' });
    }
    edits.push(['clientId', 'client_id'], ['clientName', 'client_name']);
    req.body.clientId = client.id; req.body.clientName = client.name;
  }
  const previousPresentation = parsePresentation(quotation.presentation);
  const visibility = req.body.visibility || (previousPresentation &&
    (req.body.clientId !== undefined || req.body.bankAccountId !== undefined)
    ? previousPresentation.show : null);
  if (visibility) {
    const project = quotation.project_id ? await getOne('SELECT name FROM projects WHERE id=?', [quotation.project_id]) : null;
    const presentation = await quotationPresentation(quotation.company_id,
      req.body.clientId || quotation.client_id, project?.name,
      req.body.bankAccountId === undefined ? quotation.bank_account_id : req.body.bankAccountId,
      visibility, req.body.clientName || quotation.client_name);
    if (!presentation) return res.status(400).json({ error: 'The quotation company is unavailable.' });
    edits.push(['presentation', 'presentation']);
    req.body.presentation = presentation;
  }

  await transaction(async connection => {
    if (edits.length) {
      await connection.execute(
        `UPDATE quotations_client SET ${edits.map(([, column]) => `${column}=?`).join(',')} WHERE id=?`,
        [...edits.map(([key]) => req.body[key]), quotation.id]);
    }
    if (req.body.status) {
      await connection.execute('UPDATE quotations_client SET status=? WHERE id=?', [req.body.status, quotation.id]);
    }
    if (req.body.status === 'Accepted' && quotation.project_id) {
      await connection.execute('UPDATE projects SET budget=? WHERE id=?', [quotation.total, quotation.project_id]);
      if (quotation.inquiry_id) {
        await connection.execute("UPDATE inquiries SET status='Won' WHERE id=?", [quotation.inquiry_id]);
      }
    }
    /* A wording change carries no status, so the action reflects what actually happened. */
    await audit(connection, req.user.id, req.body.status ? req.body.status.toUpperCase() : 'UPDATE',
      'quotation', quotation.id, quotation, { ...quotation, ...req.body }, req.ip);
  });

  if (req.body.status === 'Accepted') {
    await notify({
      audience: 'finance.view',
      severity: 'Info',
      title: `Quotation ${quotation.reference} accepted`,
      message: `The accepted total is now the project budget. Costs are measured against it from here.`,
      referenceType: 'quotation',
      referenceId: quotation.id
    });
  }
  res.json(await getOne(`${quoteSelect} WHERE q.id=?`, [quotation.id]));
}));

/* ------------------------------------------------------------------ Tender filing */

/*
 * Public-works bidding in Sri Lanka, as GKUC actually meets it.
 *
 * A bid is lost on paperwork as easily as on price. The Department of Buildings states
 * that a bid without the PCA-03 certificate cannot be awarded at all; the affidavit of
 * outstanding contract commitments carries "shall be treated as non-responsive". And the
 * dates are unforgiving — the document is on sale only between two dates, bids close at an
 * hour of the morning rather than on a day, the bid security has an expiry of its own, and
 * the offer itself only stands for a stated number of days.
 *
 * So a tender here is not one date and a value. It is a set of deadlines that each need to
 * be seen coming, and a list of certificates that each need to be in the envelope.
 */

/* Nothing in this list is optional in the documents GKUC bid against, so a new tender
   starts with all of it outstanding rather than with an empty list to remember to fill. */
const STANDARD_CHECKLIST = [
  'Bid security in the required form, amount and validity',
  'CIDA / ICTAD registration certificate, valid at closing and at award',
  'PCA-03 certificate — Registrar of Public Contracts (original)',
  'Form of Bid, signed and witnessed',
  'Priced Bill of Quantities',
  'Affidavit of outstanding contract commitments, attested by a Justice of the Peace',
  'Financial data form and latest audited financial statements',
  'Line of credit from the bank, in the Section 9 form',
  'Similar work experience — letters of acceptance and completion certificates',
  'List of major construction equipment proposed',
  'Qualifications and CVs of key technical and managerial staff',
  'VAT and business registration certificates'
];

const tenderSelect = `SELECT t.id,t.reference,t.contract_no contractNo,t.title,t.client,t.client_id clientId,t.source,
  t.company_id companyId,c.name company,
  t.bidding_entity biddingEntity,t.procurement_method procurementMethod,t.specialty,t.cida_grade cidaGrade,
  t.employer_office employerOffice,t.employer_contact employerContact,t.max_contract_value maxContractValue,
  t.document_fee documentFee,t.docs_from docsFrom,t.docs_until docsUntil,t.receipt_no receiptNo,
  t.purchased_date purchasedDate,t.closing_date closingDate,t.closing_time closingTime,
  t.opening_date openingDate,t.validity_days validityDays,
  t.security_amount securityAmount,t.security_in_favour_of securityInFavourOf,t.security_form securityForm,
  t.security_valid_until securityValidUntil,t.security_released_on securityReleasedOn,
  t.submitted_date submittedDate,t.estimated_value estimatedValue,t.bid_value bidValue,t.vat_amount vatAmount,
  t.award_value awardValue,t.awarded_to awardedTo,t.our_rank ourRank,t.bidders_count biddersCount,
  t.opened_date openedDate,t.status,t.documents_note documentsNote,t.outcome_note outcomeNote,
  t.project_id projectId,p.name project,u.name owner,t.source_filename sourceFilename,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id) checklistTotal,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id AND c.done=1) checklistDone,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id AND c.done=0 AND c.mandatory=1) checklistOutstanding
  FROM tenders t JOIN companies c ON c.id=t.company_id LEFT JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.owner_id`;

/** The live bids, soonest deadline first — which is the order the QS works in. */
router.get('/tenders', auth, permit('qs.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  const companyId = Number(req.query.companyId);
  if (companyId > 0) { filters.push('t.company_id=?'); params.push(companyId); }
  if (req.query.status) { filters.push('t.status=?'); params.push(req.query.status); }
  if (req.query.open === 'true') filters.push("t.status IN ('Identified','Document purchased','Preparing')");
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`${tenderSelect} ${where} ORDER BY
    FIELD(t.status,'Preparing','Document purchased','Identified','Submitted','Opened','Won','Lost','Withdrawn','Cancelled'),
    t.closing_date`, params));
}));

/* Declared before /tenders/:id, which would otherwise match this as a tender whose id
   is the word "commitments". */
router.get('/tenders/commitments', auth, permit('qs.view'), wrap(async (req, res) => {
  const companyId=Number(req.query.companyId);
  const rows = await query(`SELECT p.id,p.name,p.client,p.stage,p.budget,${spendSql('p')} spent
    FROM projects p WHERE p.active=1 AND p.site_status <> 'Completed' ${companyId>0?'AND p.company_id=?':''} ORDER BY p.name`,companyId>0?[companyId]:[]);
  const commitments = rows.map(row => ({
    project: row.name,
    client: row.client,
    initialAmount: Number(row.budget),
    /* "Outstanding work" is what is left to earn on the contract, so it cannot go below
       zero when a job has overrun its budget. */
    outstanding: Math.max(0, Number(row.budget) - Number(row.spent))
  }));
  res.json({
    asAt: today(),
    commitments,
    totals: {
      initialAmount: commitments.reduce((sum, row) => sum + row.initialAmount, 0),
      outstanding: commitments.reduce((sum, row) => sum + row.outstanding, 0)
    }
  });
}));

router.get('/tenders/:id', auth, permit('qs.view'), wrap(async (req, res) => {
  const tender = await getOne(`${tenderSelect} WHERE t.id=?`, [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  tender.checklist = await query(
    `SELECT c.id,c.item,c.mandatory,c.done,c.note,c.done_at doneAt,u.name doneBy
     FROM tender_checklist c LEFT JOIN users u ON u.id=c.done_by
     WHERE c.tender_id=? ORDER BY c.position,c.id`, [tender.id]);
  res.json(tender);
}));

const tenderShape = z.object({
  companyId: z.number().int().positive().default(1),
  contractNo: z.string().max(120).optional(),
  title: z.string().min(3).max(220),
  client: z.string().min(2).max(180).optional(),
  clientId: z.number().int().positive().optional(),
  source: z.string().max(120).optional(),
  biddingEntity: z.string().max(120).optional(),
  procurementMethod: z.enum(['National Competitive Bidding', 'International Competitive Bidding', 'Shopping', 'Direct']).default('National Competitive Bidding'),
  specialty: z.enum(['Highways', 'Bridges', 'Buildings', 'Irrigation', 'Water Supply', 'Other']).default('Highways'),
  cidaGrade: z.string().max(40).optional(),
  employerOffice: z.string().max(220).optional(),
  employerContact: z.string().max(220).optional(),
  maxContractValue: z.number().nonnegative().default(0),
  documentFee: z.number().nonnegative().default(0),
  docsFrom: isoDate.optional(),
  docsUntil: isoDate.optional(),
  closingDate: isoDate,
  closingTime: z.string().regex(/^\d{2}:\d{2}$/).default('10:00'),
  openingDate: isoDate.optional(),
  validityDays: z.number().int().min(1).max(365).default(91),
  securityAmount: z.number().nonnegative().default(0),
  securityInFavourOf: z.string().max(180).optional(),
  securityForm: z.enum(['Bank guarantee', 'Insurance bond', 'Cash deposit', 'Not required']).default('Bank guarantee'),
  securityValidUntil: isoDate.optional(),
  estimatedValue: z.number().nonnegative().default(0),
  documentsNote: z.string().max(600).optional()
});

/* A window that shuts before it opens, or a bid that closes before the document is on
   sale, is a typo — and one that would quietly mis-order the whole deadline board. */
const datesRunForwards = value =>
  (!value.docsFrom || !value.docsUntil || value.docsUntil >= value.docsFrom)
  && (!value.docsFrom || !value.closingDate || value.closingDate >= value.docsFrom);
const dateOrder = { message: 'The dates run backwards: documents go on sale, then bids close', path: ['closingDate'] };

const columns = {
  companyId: 'company_id',
  clientId: 'client_id',
  contractNo: 'contract_no', biddingEntity: 'bidding_entity', procurementMethod: 'procurement_method',
  cidaGrade: 'cida_grade', employerOffice: 'employer_office', employerContact: 'employer_contact',
  maxContractValue: 'max_contract_value', documentFee: 'document_fee', docsFrom: 'docs_from',
  docsUntil: 'docs_until', receiptNo: 'receipt_no', purchasedDate: 'purchased_date',
  closingDate: 'closing_date', closingTime: 'closing_time', openingDate: 'opening_date',
  validityDays: 'validity_days', securityAmount: 'security_amount',
  securityInFavourOf: 'security_in_favour_of', securityForm: 'security_form',
  securityValidUntil: 'security_valid_until', securityReleasedOn: 'security_released_on',
  estimatedValue: 'estimated_value', bidValue: 'bid_value', vatAmount: 'vat_amount',
  awardValue: 'award_value', awardedTo: 'awarded_to', ourRank: 'our_rank',
  biddersCount: 'bidders_count', openedDate: 'opened_date',
  submittedDate: 'submitted_date', documentsNote: 'documents_note', outcomeNote: 'outcome_note'
};

router.post('/tenders/pdf/preview', auth, permit('qs.tender'), wrap(async (req, res) => {
  const upload = await pdfUpload(req);
  try {
    const parsed = await parseTenderPdf(upload.file.path);
    const clients = await query('SELECT id,name,type FROM clients WHERE active=1');
    const name = parsed.clientName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matches = name ? clients.filter(client => {
      const candidate = client.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return candidate === name || (candidate.length > 5 && name.includes(candidate)) || (name.length > 5 && candidate.includes(name));
    }).slice(0, 5) : [];
    res.json({ ...parsed, matches, filename: upload.file.filename });
  } finally { await upload.discard(); }
}));

router.post('/tenders/pdf/commit', auth, permit('qs.tender'), wrap(async (req, res) => {
  const upload = await pdfUpload(req);
  let stored;
  let committed = false;
  try {
    let review;
    try { review = JSON.parse(upload.fields.review || ''); }
    catch { return res.status(400).json({ error: 'The reviewed tender details were missing. Read the PDF again and retry.' }); }
    for (const field of ['docsFrom', 'docsUntil', 'openingDate', 'securityValidUntil']) {
      if (review[field] === '') delete review[field];
    }
    const parsed = tenderShape.extend({
      clientSelection: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('existing'), id: z.number().int().positive() }),
        z.object({ mode: z.literal('new'), name: z.string().trim().min(2).max(180), type: z.enum(['Private', 'Organisation']) })
      ])
    }).refine(datesRunForwards, dateOrder).safeParse(review);
    if (!parsed.success) return res.status(400).json({ error: 'Check the tender details, client and closing date.', issues: parsed.error.flatten() });
    const { clientSelection, ...body } = parsed.data;
    if (clientSelection.mode === 'existing' && !await getOne('SELECT id FROM clients WHERE id=? AND active=1', [clientSelection.id]))
      return res.status(400).json({ error: 'The selected client is no longer active. Choose another client.' });
    if (clientSelection.mode === 'new' && await getOne('SELECT id FROM clients WHERE LOWER(name)=LOWER(?) AND active=1', [clientSelection.name]))
      return res.status(409).json({ error: 'A client with this name already exists. Choose the saved client instead.' });
    if (body.contractNo && await getOne('SELECT id FROM tenders WHERE company_id=? AND contract_no=?', [body.companyId, body.contractNo]))
      return res.status(409).json({ error: 'This company already has a tender with that contract number. Open the existing tender instead.' });
    const company = await getOne('SELECT id FROM companies WHERE id=?', [body.companyId]);
    if (!company) return res.status(400).json({ error: 'Choose a valid operating company.' });
    const checksum = await checksumFile(upload.file.path);
    stored = await store({ folder: 'tender', filename: upload.file.filename,
      mime: upload.file.mime, path: upload.file.path, head: upload.file.head, size: upload.file.size });
    const reference = await nextReference('TEN', 'tenders');
    const id = await transaction(async connection => {
      let client;
      if (clientSelection.mode === 'existing') {
        const [rows] = await connection.execute('SELECT id,name FROM clients WHERE id=? AND active=1', [clientSelection.id]);
        client = rows[0];
        if (!client) throw Object.assign(new Error('The client was archived while you were reviewing. Choose another.'), { status: 409 });
      } else {
        const [created] = await connection.execute('INSERT INTO clients (type,name) VALUES (?,?)', [clientSelection.type, clientSelection.name]);
        client = { id: created.insertId, name: clientSelection.name };
        await audit(connection, req.user.id, 'CREATE', 'client', client.id, null, client, req.ip);
      }
      const fields = Object.entries(body).filter(([, value]) => value !== undefined);
      const names = ['reference', 'owner_id', 'client_id', 'client', 'source_file_key', 'source_filename', 'source_checksum',
        ...fields.map(([key]) => columns[key] || key)];
      const values = [reference, req.user.id, client.id, client.name, stored.key, stored.filename, checksum,
        ...fields.map(([, value]) => value)];
      const [created] = await connection.execute(`INSERT INTO tenders (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, values);
      for (const [position, item] of STANDARD_CHECKLIST.entries()) {
        await connection.execute('INSERT INTO tender_checklist (tender_id,item,position) VALUES (?,?,?)', [created.insertId, item, position]);
      }
      await audit(connection, req.user.id, 'CREATE', 'tender', created.insertId, null,
        { reference, clientId: client.id, sourceFilename: stored.filename }, req.ip);
      return created.insertId;
    });
    committed = true;
    res.status(201).json(await getOne(`${tenderSelect} WHERE t.id=?`, [id]));
  } catch (error) {
    if (stored && !committed) await remove(stored.key).catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This tender or client already exists. Refresh and check the saved records.' });
    throw error;
  } finally { await upload.discard(); }
}));

router.get('/tenders/:id/pdf', auth, permit('qs.view'), wrap(async (req, res) => {
  const file = await getOne('SELECT source_file_key storageKey,source_filename filename FROM tenders WHERE id=?', [req.params.id]);
  if (!file?.storageKey) return res.status(404).json({ error: 'No original PDF is attached to this tender.' });
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^\w.\- ]+/g, '')}"`);
  if (isLocalStore()) return res.sendFile(localPathFor(file.storageKey));
  return res.redirect(await signedDownloadUrl(file.storageKey));
}));

router.post('/tenders', auth, permit('qs.tender'), validate(tenderShape.refine(datesRunForwards, dateOrder)
  .refine(value => value.clientId || value.client, { message: 'Choose a client', path: ['clientId'] })),
  wrap(async (req, res) => {
    const body = { ...req.body };
    let client = body.clientId
      ? await getOne('SELECT id,name FROM clients WHERE id=? AND active=1', [body.clientId])
      : await getOne('SELECT id,name FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [body.client]);
    if (!client && body.client && !body.clientId) {
      const created = await query("INSERT INTO clients (type,name) VALUES ('Organisation',?)", [body.client]);
      client = { id: created.insertId, name: body.client };
    }
    if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });
    body.clientId = client.id; body.client = client.name;
    const reference = await nextReference('TEN', 'tenders');
    const id = await transaction(async connection => {
      const fields = Object.entries(body).filter(([, value]) => value !== undefined);
      const names = ['reference', 'owner_id', ...fields.map(([key]) => columns[key] || key)];
      const values = [reference, req.user.id, ...fields.map(([, value]) => value)];
      const [result] = await connection.execute(
        `INSERT INTO tenders (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, values);

      for (const [position, item] of STANDARD_CHECKLIST.entries()) {
        await connection.execute(
          'INSERT INTO tender_checklist (tender_id,item,position) VALUES (?,?,?)',
          [result.insertId, item, position]);
      }
      await audit(connection, req.user.id, 'CREATE', 'tender', result.insertId, null, { reference, ...body }, req.ip);
      return result.insertId;
    });
    res.status(201).json(await getOne(`${tenderSelect} WHERE t.id=?`, [id]));
  }));

router.patch('/tenders/:id', auth, permit('qs.tender'), validate(tenderShape.partial().extend({
  status: z.enum(['Identified', 'Document purchased', 'Preparing', 'Submitted', 'Opened', 'Won', 'Lost', 'Withdrawn', 'Cancelled']).optional(),
  bidValue: z.number().nonnegative().optional(),
  vatAmount: z.number().nonnegative().optional(),
  receiptNo: z.string().max(60).optional(),
  purchasedDate: isoDate.optional(),
  submittedDate: isoDate.optional(),
  outcomeNote: z.string().max(600).optional()
}).refine(datesRunForwards, dateOrder)), wrap(async (req, res) => {
  const tender = await getOne('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });

  /*
   * A bid cannot be marked submitted while a required certificate is still missing. This
   * is the whole point of the checklist: the documents say a bid short of the PCA-03 or
   * the commitments affidavit is not merely weaker, it is rejected unread.
   */
  if (req.body.status === 'Submitted' && tender.status !== 'Submitted') {
    const outstanding = await query(
      'SELECT item FROM tender_checklist WHERE tender_id=? AND mandatory=1 AND done=0 ORDER BY position', [tender.id]);
    if (outstanding.length) {
      return res.status(409).json({
        error: `${outstanding.length} required document(s) are still outstanding: ${outstanding.map(row => row.item).join('; ')}`
      });
    }
  }

  const body = { ...req.body };
  if (body.clientId || body.client) {
    const client = body.clientId
      ? await getOne('SELECT id,name FROM clients WHERE id=? AND active=1', [body.clientId])
      : await getOne('SELECT id,name FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [body.client]);
    if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });
    body.clientId = client.id; body.client = client.name;
  }
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  if (entries.length) {
    await query(`UPDATE tenders SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), tender.id]);
  }
  /* Recording a step without its date leaves the trail incomplete, so fill it in. */
  if (req.body.status === 'Submitted' && !tender.submitted_date && !req.body.submittedDate) {
    await query('UPDATE tenders SET submitted_date=? WHERE id=?', [today(), tender.id]);
  }
  if (req.body.status === 'Document purchased' && !tender.purchased_date && !req.body.purchasedDate) {
    await query('UPDATE tenders SET purchased_date=? WHERE id=?', [today(), tender.id]);
  }
  if (req.body.status === 'Opened' && !tender.opened_date && !req.body.openedDate) {
    await query('UPDATE tenders SET opened_date=? WHERE id=?', [today(), tender.id]);
  }
  await audit(pool, req.user.id, 'UPDATE', 'tender', tender.id, tender, req.body, req.ip);
  res.json(await getOne(`${tenderSelect} WHERE t.id=?`, [tender.id]));
}));

/* ---------------------------------------------------------- The document checklist */

router.post('/tenders/:id/checklist', auth, permit('qs.tender'), validate(z.object({
  item: z.string().min(2).max(220),
  mandatory: z.boolean().default(true)
})), wrap(async (req, res) => {
  const tender = await getOne('SELECT id FROM tenders WHERE id=?', [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  const last = await getOne('SELECT COALESCE(MAX(position),0) high FROM tender_checklist WHERE tender_id=?', [tender.id]);
  const result = await query('INSERT INTO tender_checklist (tender_id,item,mandatory,position) VALUES (?,?,?,?)',
    [tender.id, req.body.item, req.body.mandatory, Number(last.high) + 1]);
  res.status(201).json(await getOne('SELECT id,item,mandatory,done,note FROM tender_checklist WHERE id=?', [result.insertId]));
}));

router.patch('/tenders/checklist/:id', auth, permit('qs.tender'), validate(z.object({
  done: z.boolean().optional(),
  /* Not every employer asks for everything. Standing a requirement down is honest, where
     ticking a certificate nobody asked for as though it were in the envelope is not. */
  mandatory: z.boolean().optional(),
  note: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const row = await getOne('SELECT * FROM tender_checklist WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Checklist item not found' });
  const done = req.body.done ?? Boolean(row.done);
  const mandatory = req.body.mandatory ?? Boolean(row.mandatory);
  await query('UPDATE tender_checklist SET done=?, mandatory=?, note=?, done_by=?, done_at=? WHERE id=?',
    [done, mandatory, req.body.note ?? row.note, done ? req.user.id : null, done ? new Date() : null, row.id]);
  await audit(pool, req.user.id, 'UPDATE', 'tender_checklist', row.id, row, req.body, req.ip);
  res.json(await getOne(
    `SELECT c.id,c.item,c.mandatory,c.done,c.note,c.done_at doneAt,u.name doneBy
     FROM tender_checklist c LEFT JOIN users u ON u.id=c.done_by WHERE c.id=?`, [row.id]));
}));

/* ------------------------------------------------------------------ The outcome */

/**
 * What the opening produced. Winning a tender is the same event as winning an enquiry, so
 * it ends the same way: the work becomes a project, and the awarded sum becomes its budget.
 */
router.post('/tenders/:id/outcome', auth, permit('qs.tender'), validate(z.object({
  status: z.enum(['Won', 'Lost', 'Withdrawn', 'Cancelled']),
  awardValue: z.number().nonnegative().default(0),
  awardedTo: z.string().max(180).optional(),
  ourRank: z.number().int().min(1).max(99).optional(),
  biddersCount: z.number().int().min(1).max(99).optional(),
  openedDate: isoDate.optional(),
  outcomeNote: z.string().max(600).optional(),
  registerProject: z.boolean().default(false),
  manager: z.string().max(120).optional(),
  managerEmployeeId: z.number().int().positive().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional()
})), wrap(async (req, res) => {
  const tender = await getOne('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  if (tender.project_id) return res.status(409).json({ error: 'This tender has already been registered as a project' });
  const body = req.body;
  const manager = body.status === 'Won' && body.registerProject
    ? await resolveProjectManager(body, { optional: true }) : null;

  const outcome = await transaction(async connection => {
    let projectId = null;
    if (body.status === 'Won' && body.registerProject) {
      const budget = body.awardValue || Number(tender.bid_value) || Number(tender.estimated_value);
      const [project] = await connection.execute(
        `INSERT INTO projects (company_id,name,client_id,client,manager,manager_employee_id,site,stage,budget,progress,health,start_date,end_date)
         VALUES (?,?,?,?,?,?,?, 'Mobilisation', ?, 0, 'On track', ?, ?)`,
        [tender.company_id,tender.title.slice(0, 180), tender.client_id, tender.client, manager.manager, manager.managerEmployeeId,
          tender.employer_office || tender.client, budget, body.startDate || today(), body.endDate || null]);
      projectId = project.insertId;
      if (manager.managerEmployeeId) await connection.execute(
        'INSERT INTO project_manager_assignments (project_id,employee_id) VALUES (?,?)',
        [projectId, manager.managerEmployeeId]);
    }

    await connection.execute(
      `UPDATE tenders SET status=?, award_value=?, awarded_to=?, our_rank=?, bidders_count=?,
       opened_date=COALESCE(opened_date,?), outcome_note=?, project_id=? WHERE id=?`,
      [body.status, body.awardValue, body.awardedTo || null, body.ourRank || null, body.biddersCount || null,
        body.openedDate || today(), body.outcomeNote || null, projectId, tender.id]);
    await audit(connection, req.user.id, 'UPDATE', 'tender', tender.id, tender, { ...body, projectId }, req.ip);
    return projectId;
  });

  await notify({
    audience: 'qs.tender',
    severity: body.status === 'Won' ? 'Info' : 'Warning',
    title: `Tender ${body.status.toLowerCase()} — ${tender.reference}`,
    message: `${tender.title} (${tender.client}).${body.awardValue ? ` Award value ${body.awardValue}.` : ''}`,
    referenceType: 'tender',
    referenceId: tender.id,
    key: `tender-outcome:${tender.id}:${body.status}`
  });
  if (outcome) {
    await notify({
      audience: 'projects.manage',
      severity: 'Info',
      title: `New project from a won tender — ${tender.title.slice(0, 90)}`,
      message: `${tender.reference} was awarded and is now a live project. A manager and programme still need setting.`,
      referenceType: 'project',
      referenceId: outcome,
      key: `tender-project:${tender.id}`
    });
  }

  res.json({ ...(await getOne(`${tenderSelect} WHERE t.id=?`, [tender.id])), createdProjectId: outcome });
}));

/* ------------------------------------------------- Outstanding contract commitments */

/**
 * The affidavit every bid has to carry: what GKUC already has on its hands.
 *
 * Bidders declare their live contracts by specialty with the initial amount and the value
 * still outstanding, sworn before a Justice of the Peace — and a bid without it is
 * non-responsive. The system already knows every live project and what has been spent on
 * it, so the figures are read from the record rather than assembled by hand the night
 * before a closing.
 */
/** The same declaration as a page that can go in the envelope. */
router.get('/tenders/:id/commitments/document', auth, permit('qs.view'), wrap(async (req, res) => {
  const tender = req.params.id === 'blank'
    ? null
    : await getOne(`SELECT reference,contract_no contractNo,bidding_entity biddingEntity,specialty,company_id companyId FROM tenders WHERE id=?`, [req.params.id]);
  if (req.params.id !== 'blank' && !tender) return res.status(404).json({ error: 'Tender not found' });

  const companyId = tender?.companyId || Number(req.query.companyId) || 1;

  const rows = await query(`SELECT p.name,p.client,p.budget,${spendSql('p')} spent
    FROM projects p WHERE p.active=1 AND p.site_status <> 'Completed' AND p.company_id=? ORDER BY p.name`, [companyId]);
  const commitments = rows.map(row => ({
    project: row.name, client: row.client,
    initialAmount: Number(row.budget),
    outstanding: Math.max(0, Number(row.budget) - Number(row.spent))
  }));
  const totals = {
    initialAmount: commitments.reduce((sum, row) => sum + row.initialAmount, 0),
    outstanding: commitments.reduce((sum, row) => sum + row.outstanding, 0)
  };
  const context = await documentContext(getOne, companyId);
  await sendDocument(req, res, commitmentsDocument({ ...context, tender, commitments, totals, asAt: today() }),
    `${tender?.reference || 'Contract-commitments'}.pdf`);
}));

/* -------------------------------------------------- Subcontract quotations (inbound) */

/*
 * What a subcontractor quoted us.
 *
 * GKUC do not keep subcontractors on retainer: when a job needs one they ask for a price,
 * and the figure that comes back is carried into GKUC's own quotation and then its invoices.
 * Recording the quotation is therefore not filing — it is where a cost line in GKUC's own
 * pricing comes from, and being able to point at it afterwards is the whole value.
 */

const subQuoteSelect = `SELECT q.id,q.reference,q.their_reference theirReference,q.package,
  q.quote_date quoteDate,q.validity_days validityDays,q.valid_until validUntil,
  q.site_address siteAddress,q.contact_person contactPerson,q.contact_phone contactPhone,
  q.subtotal,q.discount_total discountTotal,q.total,q.notes,q.status,q.source_filename sourceFilename,
  q.decision_note decisionNote,q.decided_at decidedAt,
  q.company_id companyId,q.project_id projectId,p.name project,q.boq_id boqId,
  s.id subcontractorId,s.name subcontractor,s.trade,
  u.name recordedBy,d.name decidedBy,
  (SELECT COUNT(*) FROM quotation_items qi WHERE qi.source_subquote_id=q.id) usedInQuotations
  FROM subcontractor_quotations q
  JOIN subcontractors s ON s.id=q.subcontractor_id
  JOIN users u ON u.id=q.created_by
  LEFT JOIN users d ON d.id=q.decided_by
  LEFT JOIN projects p ON p.id=q.project_id`;

const lineTotal = item =>
  Math.max(0, Number(item.quantity) * Number(item.rate) - Number(item.discount || 0));

const importedSubquote = z.object({
  companyId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  subcontractor: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), id: z.number().int().positive() }),
    z.object({ mode: z.literal('new'), name: z.string().trim().min(2).max(180),
      trade: z.string().trim().min(2).max(120), contactType: z.enum(['Company', 'Individual']),
      contact: z.string().max(120).optional(), phone: z.string().max(40).optional(),
      email: z.string().email().or(z.literal('')).optional(), address: z.string().max(400).optional(),
      businessId: z.string().max(100).optional() })
  ]),
  quotation: z.object({
    theirReference: z.string().max(80).optional(), package: z.string().trim().min(2).max(200),
    quoteDate: isoDate, validityDays: z.number().int().min(1).max(365),
    siteAddress: z.string().max(300).optional(), contactPerson: z.string().max(120).optional(),
    contactPhone: z.string().max(40).optional(), notes: z.string().max(1000).optional()
  }),
  items: z.array(z.object({ description: z.string().trim().min(2).max(300), unit: z.string().max(30).optional(),
    quantity: z.number().positive(), rate: z.number().nonnegative(), discount: z.number().nonnegative() })).min(1)
});

const pdfUpload = async req => {
  const upload = await readUpload(req);
  if (upload.file.mime !== 'application/pdf' || !contentMatchesType(upload.file.head, 'application/pdf')) {
    await upload.discard();
    throw Object.assign(new Error('Choose a valid PDF quotation file.'), { status: 415 });
  }
  return upload;
};

router.post('/subcontract-quotations/pdf/preview', auth, permit('subcontractors.manage'), wrap(async (req, res) => {
  const upload = await pdfUpload(req);
  try {
    const parsed = await parseSubcontractQuotePdf(upload.file.path);
    const existing = await query(`SELECT id,name,trade,phone,business_id businessId FROM subcontractors WHERE active=1`);
    res.json({ ...parsed, filename: upload.file.filename, matches: suggestSubcontractors(parsed, existing) });
  } finally { await upload.discard(); }
}));

router.post('/subcontract-quotations/pdf/commit', auth, permit('subcontractors.manage'), wrap(async (req, res) => {
  const upload = await pdfUpload(req);
  let stored;
  let committed = false;
  try {
    let review;
    try { review = JSON.parse(upload.fields.review || ''); }
    catch { return res.status(400).json({ error: 'The reviewed quotation details were missing. Read the PDF again and retry.' }); }
    const validated = importedSubquote.safeParse(review);
    if (!validated.success) return res.status(400).json({ error: 'Check the highlighted quotation details and priced items.', issues: validated.error.flatten() });
    const body = validated.data;
    const project = await getOne('SELECT id FROM projects WHERE id=? AND active=1 AND company_id=?', [body.projectId, body.companyId]);
    if (!project) return res.status(400).json({ error: 'Choose an active project from the selected company.' });
    if (body.subcontractor.mode === 'existing') {
      const existing = await getOne('SELECT id FROM subcontractors WHERE id=? AND active=1', [body.subcontractor.id]);
      if (!existing) return res.status(400).json({ error: 'The selected subcontractor is no longer available. Choose another or create a new one.' });
    } else {
      const existing = await getOne('SELECT id FROM subcontractors WHERE LOWER(name)=LOWER(?) AND active=1', [body.subcontractor.name]);
      if (existing) return res.status(409).json({ error: 'A subcontractor with this name already exists. Choose their existing profile instead of creating a duplicate.' });
    }

    const checksum = await checksumFile(upload.file.path);
    stored = await store({ folder: 'subcontract-quotation', filename: upload.file.filename,
      mime: upload.file.mime, path: upload.file.path, head: upload.file.head, size: upload.file.size });
    const reference = await nextReference('SQ', 'subcontractor_quotations');
    const quote = body.quotation;
    const subtotal = body.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
    const discountTotal = body.items.reduce((sum, item) => sum + item.discount, 0);
    const total = body.items.reduce((sum, item) => sum + lineTotal(item), 0);
    const id = await transaction(async connection => {
      let subcontractorId = body.subcontractor.id;
      if (body.subcontractor.mode === 'new') {
        const sub = body.subcontractor;
        const [created] = await connection.execute(`INSERT INTO subcontractors
          (name,trade,contact_person,phone,email,address,business_id,contact_type) VALUES (?,?,?,?,?,?,?,?)`,
          [sub.name, sub.trade, sub.contact || null, sub.phone || null, sub.email || null,
            sub.address || null, sub.businessId || null, sub.contactType]);
        subcontractorId = created.insertId;
        await audit(connection, req.user.id, 'CREATE', 'subcontractor', subcontractorId, null, sub, req.ip);
      }
      const [created] = await connection.execute(`INSERT INTO subcontractor_quotations
        (company_id,reference,subcontractor_id,project_id,their_reference,package,quote_date,validity_days,
         valid_until,site_address,contact_person,contact_phone,subtotal,discount_total,total,notes,
         source_file_key,source_filename,source_checksum,created_by)
        VALUES (?,?,?,?,?,?,?,?,DATE_ADD(?, INTERVAL ? DAY),?,?,?,?,?,?,?,?,?,?,?)`,
        [body.companyId, reference, subcontractorId, body.projectId, quote.theirReference || null,
          quote.package, quote.quoteDate, quote.validityDays, quote.quoteDate, quote.validityDays,
          quote.siteAddress || null, quote.contactPerson || null, quote.contactPhone || null,
          subtotal, discountTotal, total, quote.notes || null, stored.key, stored.filename, checksum, req.user.id]);
      for (const [position, item] of body.items.entries()) {
        await connection.execute(`INSERT INTO subcontractor_quotation_items
          (quotation_id,description,unit,quantity,rate,discount,amount,position) VALUES (?,?,?,?,?,?,?,?)`,
          [created.insertId, item.description, item.unit || null, item.quantity, item.rate,
            item.discount, lineTotal(item), position]);
      }
      await audit(connection, req.user.id, 'CREATE', 'subcontract_quotation', created.insertId, null,
        { reference, subcontractorId, total, sourceFilename: stored.filename }, req.ip);
      return created.insertId;
    });
    committed = true;
    res.status(201).json(await getOne(`${subQuoteSelect} WHERE q.id=?`, [id]));
  } catch (error) {
    if (stored && !committed) await remove(stored.key).catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This subcontractor or quotation already exists. Refresh and check the existing records.' });
    throw error;
  } finally { await upload.discard(); }
}));

router.get('/subcontract-quotations/:id/pdf', auth, permit('qs.view', 'projects.view'), wrap(async (req, res) => {
  const file = await getOne('SELECT source_file_key storageKey,source_filename filename FROM subcontractor_quotations WHERE id=?', [req.params.id]);
  if (!file?.storageKey) return res.status(404).json({ error: 'No original PDF is attached to this quotation.' });
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^\w.\- ]+/g, '')}"`);
  if (isLocalStore()) return res.sendFile(localPathFor(file.storageKey));
  return res.redirect(await signedDownloadUrl(file.storageKey));
}));

router.get('/subcontract-quotations', auth, permit('qs.view', 'projects.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  const companyId = Number(req.query.companyId);
  if (companyId > 0) { filters.push('q.company_id=?'); params.push(companyId); }
  if (req.query.projectId) { filters.push('q.project_id=?'); params.push(req.query.projectId); }
  if (req.query.status) { filters.push('q.status=?'); params.push(req.query.status); }
  if (req.query.package) { filters.push('q.package=?'); params.push(req.query.package); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`${subQuoteSelect} ${where} ORDER BY q.quote_date DESC, q.id DESC`, params));
}));

router.get('/subcontract-quotations/:id', auth, permit('qs.view', 'projects.view'), wrap(async (req, res) => {
  const quote = await getOne(`${subQuoteSelect} WHERE q.id=?`, [req.params.id]);
  if (!quote) return res.status(404).json({ error: 'Subcontract quotation not found' });
  quote.items = await query(
    `SELECT id,description,unit,quantity,rate,discount,amount FROM subcontractor_quotation_items
     WHERE quotation_id=? ORDER BY position,id`, [quote.id]);
  return res.json(quote);
}));

router.post('/subcontract-quotations', auth, permit('subcontractors.manage'), validate(z.object({
  companyId: z.number().int().positive().default(1),
  subcontractorId: z.number().int().positive(),
  projectId: z.number().int().positive().optional(),
  boqId: z.number().int().positive().optional(),
  theirReference: z.string().max(80).optional(),
  package: z.string().min(2).max(200),
  quoteDate: isoDate,
  validityDays: z.number().int().min(1).max(365).default(7),
  siteAddress: z.string().max(300).optional(),
  contactPerson: z.string().max(120).optional(),
  contactPhone: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
  items: z.array(z.object({
    description: z.string().min(2).max(300),
    unit: z.string().max(30).optional(),
    quantity: z.number().positive().default(1),
    rate: z.number().nonnegative().default(0),
    discount: z.number().nonnegative().default(0)
  })).min(1)
})), wrap(async (req, res) => {
  const body = req.body;
  const sub = await getOne('SELECT id,name FROM subcontractors WHERE id=? AND active=1', [body.subcontractorId]);
  if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
  if (body.projectId && !await getOne('SELECT id FROM projects WHERE id=? AND company_id=?', [body.projectId, body.companyId])) {
    return res.status(400).json({ error: 'That project belongs to the other company' });
  }

  const subtotal = body.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate), 0);
  const discountTotal = body.items.reduce((sum, item) => sum + Number(item.discount || 0), 0);
  const total = body.items.reduce((sum, item) => sum + lineTotal(item), 0);
  const reference = await nextReference('SQ', 'subcontractor_quotations');

  const id = await transaction(async connection => {
    const [result] = await connection.execute(
      `INSERT INTO subcontractor_quotations
        (company_id,reference,subcontractor_id,project_id,boq_id,their_reference,package,quote_date,validity_days,
         valid_until,site_address,contact_person,contact_phone,subtotal,discount_total,total,notes,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,DATE_ADD(?, INTERVAL ? DAY),?,?,?,?,?,?,?,?)`,
      [body.companyId, reference, sub.id, body.projectId || null, body.boqId || null, body.theirReference || null,
        body.package, body.quoteDate, body.validityDays, body.quoteDate, body.validityDays,
        body.siteAddress || null, body.contactPerson || null, body.contactPhone || null,
        subtotal, discountTotal, total, body.notes || null, req.user.id]);

    for (const [position, item] of body.items.entries()) {
      await connection.execute(
        `INSERT INTO subcontractor_quotation_items
          (quotation_id,description,unit,quantity,rate,discount,amount,position) VALUES (?,?,?,?,?,?,?,?)`,
        [result.insertId, item.description, item.unit || null, item.quantity, item.rate,
          item.discount || 0, lineTotal(item), position]);
    }
    await audit(connection, req.user.id, 'CREATE', 'subcontract_quotation', result.insertId, null,
      { reference, subcontractor: sub.name, total }, req.ip);
    return result.insertId;
  });

  res.status(201).json(await getOne(`${subQuoteSelect} WHERE q.id=?`, [id]));
}));

/**
 * Taking a price, or turning one down.
 *
 * Accepting one marks the others quoted for the same package on the same project as
 * superseded, so the file shows which price was taken and against what — the comparison is
 * the record, not a side note.
 */
router.post('/subcontract-quotations/:id/decision', auth, permit('subcontractors.manage'), validate(z.object({
  status: z.enum(['Accepted', 'Rejected']),
  note: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const quote = await getOne('SELECT * FROM subcontractor_quotations WHERE id=?', [req.params.id]);
  if (!quote) return res.status(404).json({ error: 'Subcontract quotation not found' });
  if (quote.status === 'Accepted' && req.body.status === 'Accepted') {
    return res.status(409).json({ error: 'This quotation has already been accepted' });
  }

  await transaction(async connection => {
    await connection.execute(
      'UPDATE subcontractor_quotations SET status=?, decided_at=NOW(), decided_by=?, decision_note=? WHERE id=?',
      [req.body.status, req.user.id, req.body.note || null, quote.id]);

    if (req.body.status === 'Accepted') {
      await connection.execute(
        `UPDATE subcontractor_quotations SET status='Superseded'
         WHERE id<>? AND package=? AND status='Received'
           AND ((project_id IS NULL AND ? IS NULL) OR project_id=?)`,
        [quote.id, quote.package, quote.project_id, quote.project_id]);
    }
    await audit(connection, req.user.id, 'UPDATE', 'subcontract_quotation', quote.id, quote, req.body, req.ip);
  });

  res.json(await getOne(`${subQuoteSelect} WHERE q.id=?`, [quote.id]));
}));

/**
 * Carrying a subcontract price into one of GKUC's own quotations.
 *
 * This is the step the client described in one line — "they add that amount for their own
 * quotations" — and the one the system had no answer for. The subcontractor's total becomes
 * a priced line on GKUC's quotation with a markup on top, and the line remembers which
 * quotation it came from, so the origin of the figure survives the year between quoting and
 * arguing about it. The quotation's own totals are recomputed from its lines afterwards.
 */
router.post('/quotations/:id/subcontract-line', auth, permit('qs.quotation'), validate(z.object({
  subQuotationId: z.number().int().positive(),
  markupPercent: z.number().min(0).max(200).default(0),
  description: z.string().max(300).optional()
})), wrap(async (req, res) => {
  const quotation = await getOne('SELECT * FROM quotations_client WHERE id=?', [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  if (quotation.status !== 'Draft') {
    return res.status(409).json({ error: 'Only a draft quotation can be changed' });
  }
  const sub = await getOne(
    `SELECT q.*, s.name subcontractor FROM subcontractor_quotations q
     JOIN subcontractors s ON s.id=q.subcontractor_id WHERE q.id=?`, [req.body.subQuotationId]);
  if (!sub) return res.status(404).json({ error: 'Subcontract quotation not found' });
  if (Number(sub.company_id) !== Number(quotation.company_id)) {
    return res.status(400).json({ error: 'Those quotations belong to different companies' });
  }
  if (sub.status === 'Rejected' || sub.status === 'Superseded') {
    return res.status(409).json({ error: `That subcontract quotation was ${sub.status.toLowerCase()}` });
  }

  const cost = Number(sub.total);
  const amount = Math.round(cost * (1 + Number(req.body.markupPercent) / 100) * 100) / 100;

  await transaction(async connection => {
    await connection.execute(
      `INSERT INTO quotation_items (quotation_id,category,description,unit,quantity,rate,amount,source_subquote_id)
       VALUES (?,'Subcontract',?,?,1,?,?,?)`,
      [quotation.id, req.body.description || `${sub.package} — ${sub.subcontractor}`, 'sum', amount, amount, sub.id]);

    const [[totals]] = await connection.execute(
      'SELECT COALESCE(SUM(amount),0) subtotal FROM quotation_items WHERE quotation_id=?', [quotation.id]);
    const subtotal = Number(totals.subtotal);
    const withMarkup = subtotal * (1 + Number(quotation.markup_percent) / 100);
    const total = withMarkup * (1 + Number(quotation.vat_percent) / 100);
    await connection.execute('UPDATE quotations_client SET subtotal=?, total=? WHERE id=?',
      [subtotal, Math.round(total * 100) / 100, quotation.id]);

    await audit(connection, req.user.id, 'UPDATE', 'quotation', quotation.id, null,
      { addedSubcontract: sub.reference, cost, markupPercent: req.body.markupPercent, amount }, req.ip);
  });

  res.status(201).json(await getOne(`${quoteSelect} WHERE q.id=?`, [quotation.id]));
}));

/* ------------------------------------------------------------------ Retention */

const retentionSelect = `SELECT r.id,r.description,r.amount,r.percent,r.held_from heldFrom,r.release_date releaseDate,
  r.defect_liability_ends defectLiabilityEnds,r.released_amount releasedAmount,r.status,r.notes,
  r.project_id projectId,p.name project,p.client,u.name createdBy
  FROM retentions r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.created_by`;

router.get('/retentions', auth, permit('qs.view', 'finance.view'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  res.json(await query(`${retentionSelect} ${companyId > 0 ? 'WHERE p.company_id=?' : ''} ORDER BY r.release_date`, companyId > 0 ? [companyId] : []));
}));

router.post('/retentions', auth, permit('qs.retention'), validate(z.object({
  projectId: z.number().int().positive(),
  description: z.string().min(3).max(300),
  amount: z.number().positive(),
  percent: z.number().min(0).max(100).default(0),
  heldFrom: isoDate,
  releaseDate: isoDate,
  defectLiabilityEnds: isoDate.optional(),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query(`INSERT INTO retentions
    (project_id,description,amount,percent,held_from,release_date,defect_liability_ends,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  [body.projectId, body.description, body.amount, body.percent, body.heldFrom, body.releaseDate,
    body.defectLiabilityEnds || null, body.notes || null, req.user.id]);
  await audit(pool, req.user.id, 'CREATE', 'retention', result.insertId, null, body, req.ip);
  res.status(201).json(await getOne(`${retentionSelect} WHERE r.id=?`, [result.insertId]));
}));

router.post('/retentions/:id/release', auth, permit('qs.retention'), validate(z.object({
  amount: z.number().positive(),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const retention = await getOne('SELECT * FROM retentions WHERE id=?', [req.params.id]);
  if (!retention) return res.status(404).json({ error: 'Retention not found' });
  const released = Number(retention.released_amount) + req.body.amount;
  if (released > Number(retention.amount) + 0.001) {
    return res.status(409).json({ error: 'That exceeds the amount being held' });
  }
  const status = released >= Number(retention.amount) - 0.001 ? 'Released' : 'Partially released';
  await query('UPDATE retentions SET released_amount=?,status=?,notes=COALESCE(?,notes) WHERE id=?',
    [released, status, req.body.notes || null, retention.id]);
  await audit(pool, req.user.id, 'RELEASE', 'retention', retention.id, retention, { released, status }, req.ip);
  res.json(await getOne(`${retentionSelect} WHERE r.id=?`, [retention.id]));
}));

/* ------------------------------------------------------------------ Subcontractors */

router.get('/subcontractors', auth, permit('qs.view', 'projects.view'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  const params = companyId > 0 ? [companyId, companyId] : [];
  res.json(await query(`SELECT s.id,s.name,s.trade,s.contact_person contact,s.phone,s.email,s.notes,
    s.address,s.business_id businessId,s.contact_type contactType,
    (SELECT COUNT(*) FROM subcontractor_bills b JOIN projects bp ON bp.id=b.project_id
      WHERE b.subcontractor_id=s.id ${companyId > 0 ? 'AND bp.company_id=?' : ''}) bills,
    (SELECT COALESCE(SUM(b.amount-b.paid_amount),0) FROM subcontractor_bills b JOIN projects bp ON bp.id=b.project_id
      WHERE b.subcontractor_id=s.id AND b.status<>'Paid' ${companyId > 0 ? 'AND bp.company_id=?' : ''}) outstanding
    FROM subcontractors s WHERE s.active=1 ORDER BY s.name`, params));
}));

router.post('/subcontractors', auth, permit('subcontractors.manage'), validate(z.object({
  name: z.string().min(2).max(180),
  trade: z.string().min(2).max(120),
  contact: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  address:z.string().max(400).optional(),businessId:z.string().max(100).optional(),
  contactType:z.enum(['Company','Individual']).default('Company'),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query(`INSERT INTO subcontractors
      (name,trade,contact_person,phone,email,address,business_id,contact_type,notes) VALUES (?,?,?,?,?,?,?,?,?)`,
      [body.name, body.trade, body.contact || null, body.phone || null, body.email || null,
        body.address||null,body.businessId||null,body.contactType,body.notes || null]);
    await audit(pool, req.user.id, 'CREATE', 'subcontractor', result.insertId, null, body, req.ip);
    res.status(201).json(await getOne('SELECT * FROM subcontractors WHERE id=?', [result.insertId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That subcontractor is already on file' });
    throw error;
  }
}));

router.get('/subcontractor-rates',auth,permit('qs.view','projects.view'),wrap(async(req,res)=>{
  const projectId=Number(req.query.projectId),companyId=Number(req.query.companyId);
  const where=projectId>0?'WHERE r.project_id=?':companyId>0?'WHERE p.company_id=?':'';
  res.json(await query(`SELECT r.id,r.project_id projectId,p.name project,r.subcontractor_id subcontractorId,
    s.name subcontractor,s.trade,s.address,s.contact_person contact,s.phone,s.email,s.business_id businessId,
    r.work_item workItem,r.unit,r.rate,r.agreed_on agreedOn,r.valid_until validUntil,r.notes
    FROM subcontractor_project_rates r JOIN projects p ON p.id=r.project_id
    JOIN subcontractors s ON s.id=r.subcontractor_id ${where} ORDER BY p.name,s.name,r.work_item`,
    projectId>0?[projectId]:companyId>0?[companyId]:[]));
}));
router.post('/subcontractor-rates',auth,permit('subcontractors.manage'),validate(z.object({
  projectId:z.number().int().positive(),subcontractorId:z.number().int().positive(),
  workItem:z.string().trim().min(3).max(220),unit:z.string().trim().min(1).max(30),
  rate:z.number().nonnegative(),agreedOn:isoDate.optional(),validUntil:isoDate.optional(),
  notes:z.string().max(600).optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  const [project,sub]=await Promise.all([getOne('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]),
    getOne('SELECT id FROM subcontractors WHERE id=? AND active=1',[b.subcontractorId])]);
  if(!project||!sub)return res.status(404).json({error:'Project or subcontractor not found'});
  try{const result=await query(`INSERT INTO subcontractor_project_rates
    (project_id,subcontractor_id,work_item,unit,rate,agreed_on,valid_until,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.projectId,b.subcontractorId,b.workItem,b.unit,b.rate,b.agreedOn||null,b.validUntil||null,b.notes||null,req.user.id]);
    await audit(pool,req.user.id,'CREATE','subcontract_rate',result.insertId,null,b,req.ip);
    res.status(201).json({id:result.insertId});
  }catch(error){if(error.code==='ER_DUP_ENTRY')return res.status(409).json({error:'This work item already has a rate for that subcontractor on this project'});throw error;}
}));

router.get('/subcontractor-bills', auth, permit('qs.view', 'finance.view'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  res.json(await query(`SELECT b.id,b.reference,b.description,b.amount,b.paid_amount paidAmount,b.bill_date billDate,
    b.due_date dueDate,b.status,s.name subcontractor,p.name project,b.project_id projectId
    FROM subcontractor_bills b JOIN subcontractors s ON s.id=b.subcontractor_id
    JOIN projects p ON p.id=b.project_id ${companyId > 0 ? 'WHERE p.company_id=?' : ''} ORDER BY b.id DESC`, companyId > 0 ? [companyId] : []));
}));

/** A subcontractor bill is a project cost, so it posts against the budget like any other. */
router.post('/subcontractor-bills', auth, permit('subcontractors.manage'), validate(z.object({
  subcontractorId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  reference: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  amount: z.number().positive(),
  billDate: isoDate,
  dueDate: isoDate.optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const id = await transaction(async connection => {
      const [result] = await connection.execute(`INSERT INTO subcontractor_bills
        (subcontractor_id,project_id,reference,description,amount,bill_date,due_date,created_by)
        VALUES (?,?,?,?,?,?,?,?)`,
      [body.subcontractorId, body.projectId, body.reference, body.description || null,
        body.amount, body.billDate, body.dueDate || null, req.user.id]);
      const [sub] = await connection.execute('SELECT name FROM subcontractors WHERE id=?', [body.subcontractorId]);
      await connection.execute(`INSERT INTO expenses
        (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
        VALUES (?,'Subcontractor',?,?,?,?, 'subcontractor_bill', ?, ?)`,
      [body.projectId, `${sub[0].name} — ${body.description || body.reference}`, body.amount,
        body.billDate, body.reference, String(result.insertId), req.user.id]);
      await audit(connection, req.user.id, 'CREATE', 'subcontractor_bill', result.insertId, null, body, req.ip);
      return result.insertId;
    });
    res.status(201).json(await getOne('SELECT * FROM subcontractor_bills WHERE id=?', [id]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That bill reference already exists for this subcontractor' });
    throw error;
  }
}));

export default router;
