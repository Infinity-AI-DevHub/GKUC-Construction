import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { documentContext, quotationDocument } from '../lib/documents.js';
import { notify } from '../alerts.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ------------------------------------------------------------------ Quotations */

const quoteSelect = `SELECT q.id,q.reference,q.title,q.client_name client,q.quote_date quoteDate,q.valid_until validUntil,
  q.subtotal,q.markup_percent markupPercent,q.vat_percent vatPercent,q.total,q.status,q.notes,q.terms,
  q.boq_id boqId,b.reference boqReference,q.project_id projectId,p.name project,q.inquiry_id inquiryId,u.name preparedBy
  FROM quotations_client q LEFT JOIN boqs b ON b.id=q.boq_id LEFT JOIN projects p ON p.id=q.project_id
  JOIN users u ON u.id=q.prepared_by`;

router.get('/quotations', auth, permit('qs.view'), wrap(async (_req, res) =>
  res.json(await query(`${quoteSelect} ORDER BY q.id DESC`))));

router.get('/quotations/:id', auth, permit('qs.view'), wrap(async (req, res) => {
  const quotation = await getOne(`${quoteSelect} WHERE q.id=?`, [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
  const items = await query('SELECT id,category,description,unit,quantity,rate,amount FROM quotation_items WHERE quotation_id=? ORDER BY id',
    [quotation.id]);
  res.json({ ...quotation, items });
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

  const [items, context] = await Promise.all([
    query(`SELECT category,description,unit,quantity,rate,amount
      FROM quotation_items WHERE quotation_id=? ORDER BY id`, [quotation.id]),
    documentContext(getOne)
  ]);

  const page = quotationDocument({
    ...context,
    /* The select names the client column `client`; the document speaks in client names. */
    quotation: { ...quotation, clientName: quotation.client },
    items: items.map((item, index) => ({ ...item, reference: index + 1 }))
  });

  res.type('html').send(page);
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

/**
 * A quotation built by choosing methods rather than from a bill of quantities.
 *
 * This is how GKUC quotes small works: the client wants a yard surfaced, and the quotation
 * offers tar, asphalt and concrete side by side at their own rates. The methods chosen also
 * name the quotation and form its reference — GKUC/2026/Aug./Tar,Asp./058 — so the filing
 * follows from the work instead of being typed by hand.
 */
router.post('/quotations/from-methods', auth, permit('qs.quotation'), validate(z.object({
  clientName: z.string().min(2).max(180),
  projectId: z.number().int().positive().optional(),
  inquiryId: z.number().int().positive().optional(),
  location: z.string().max(180).optional(),
  contact: z.string().max(120).optional(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  vatPercent: z.number().min(0).max(100).default(18),
  notes: z.string().max(1000).optional(),
  paymentTerms: z.string().max(1000).optional(),
  lines: z.array(z.object({
    methodId: z.number().int().positive(),
    description: z.string().max(300).optional(),
    quantity: z.number().positive(),
    rate: z.number().nonnegative().optional()
  })).min(1).max(60)
})), wrap(async (req, res) => {
  const body = req.body;
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
      description: line.description || [method.name, method.description].filter(Boolean).join(' — '),
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

  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO quotations_client
      (reference,project_id,inquiry_id,client_name,title,quote_date,valid_until,subtotal,
       markup_percent,vat_percent,total,notes,method_codes,location,contact,payment_terms,prepared_by)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
    [reference, body.projectId || null, body.inquiryId || null, body.clientName,
      names.join(' / '), body.quoteDate || today(), body.validUntil || null, subtotal,
      body.vatPercent, total, body.notes || null, codes.join(','),
      body.location || null, body.contact || null, terms, req.user.id]);

    for (const line of priced) {
      await connection.execute(`INSERT INTO quotation_items
        (quotation_id,method_id,category,description,unit,quantity,rate,amount) VALUES (?,?,?,?,?,?,?,?)`,
      [result.insertId, line.methodId, line.category, line.description, line.unit,
        line.quantity, line.rate, line.amount]);
    }
    await audit(connection, req.user.id, 'CREATE', 'quotation', result.insertId, null,
      { reference, total, methods: names }, req.ip);
    return result.insertId;
  });

  res.status(201).json(await getOne(`${quoteSelect} WHERE q.id=?`, [id]));
}));

router.post('/quotations', auth, permit('qs.quotation'), validate(z.object({
  boqId: z.number().int().positive(),
  clientName: z.string().min(2).max(180).optional(),
  title: z.string().min(3).max(200).optional(),
  quoteDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  markupPercent: z.number().min(0).max(100).default(0),
  vatPercent: z.number().min(0).max(100).default(0),
  inquiryId: z.number().int().positive().optional(),
  notes: z.string().max(1000).optional()
})), wrap(async (req, res) => {
  const boq = await getOne(`SELECT b.*,p.name project,p.client FROM boqs b JOIN projects p ON p.id=b.project_id WHERE b.id=?`,
    [req.body.boqId]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const items = await query('SELECT category,description,unit,quantity,rate,amount FROM boq_items WHERE boq_id=? ORDER BY id', [boq.id]);
  if (!items.length) return res.status(409).json({ error: 'That BOQ has no priced lines to quote from' });

  const subtotal = items.reduce((sum, item) => sum + Number(item.amount), 0);
  const withMarkup = subtotal * (1 + req.body.markupPercent / 100);
  const total = withMarkup * (1 + req.body.vatPercent / 100);
  const reference = await nextReference('QUO', 'quotations_client');

  const id = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO quotations_client
      (reference,boq_id,project_id,inquiry_id,client_name,title,quote_date,valid_until,subtotal,
       markup_percent,vat_percent,total,notes,prepared_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [reference, boq.id, boq.project_id, req.body.inquiryId || null,
      req.body.clientName || boq.client, req.body.title || describe(boq),
      req.body.quoteDate || today(), req.body.validUntil || null, subtotal,
      req.body.markupPercent, req.body.vatPercent, total, req.body.notes || null, req.user.id]);
    /* The lines are copied, not referenced: a later BOQ edit must not silently restate a
       quotation the client has already been given. */
    for (const item of items) {
      await connection.execute(`INSERT INTO quotation_items (quotation_id,category,description,unit,quantity,rate,amount)
        VALUES (?,?,?,?,?,?,?)`,
      [result.insertId, item.category, item.description, item.unit, item.quantity, item.rate, item.amount]);
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
  quoteDate: isoDate.optional(),
  validUntil: isoDate.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })),
wrap(async (req, res) => {
  const quotation = await getOne('SELECT * FROM quotations_client WHERE id=?', [req.params.id]);
  if (!quotation) return res.status(404).json({ error: 'Quotation not found' });

  /* An accepted quotation is what the client agreed to; its wording stops being ours to
     rewrite, though its status can still move on. */
  const rewording = ['title', 'clientName', 'quoteDate', 'validUntil', 'notes', 'terms']
    .some(field => req.body[field] !== undefined);
  if (rewording && quotation.status === 'Accepted') {
    return res.status(409).json({ error: 'An accepted quotation cannot be reworded. Raise a new one instead.' });
  }

  const columns = {
    title: 'title', clientName: 'client_name', quoteDate: 'quote_date',
    validUntil: 'valid_until', notes: 'notes', terms: 'terms'
  };
  const edits = Object.entries(columns).filter(([key]) => req.body[key] !== undefined);

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

const tenderSelect = `SELECT t.id,t.reference,t.title,t.client,t.source,t.closing_date closingDate,
  t.submitted_date submittedDate,t.estimated_value estimatedValue,t.bid_value bidValue,t.status,
  t.documents_note documentsNote,t.outcome_note outcomeNote,t.project_id projectId,p.name project,u.name owner
  FROM tenders t LEFT JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.owner_id`;

router.get('/tenders', auth, permit('qs.view'), wrap(async (req, res) => {
  const where = req.query.status ? 'WHERE t.status=?' : '';
  res.json(await query(`${tenderSelect} ${where} ORDER BY t.closing_date`, req.query.status ? [req.query.status] : []));
}));

router.post('/tenders', auth, permit('qs.tender'), validate(z.object({
  title: z.string().min(3).max(220),
  client: z.string().min(2).max(180),
  source: z.string().max(120).optional(),
  closingDate: isoDate,
  estimatedValue: z.number().nonnegative().default(0),
  documentsNote: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const reference = await nextReference('TEN', 'tenders');
  const result = await query(`INSERT INTO tenders (reference,title,client,source,closing_date,estimated_value,documents_note,owner_id)
    VALUES (?,?,?,?,?,?,?,?)`,
  [reference, body.title, body.client, body.source || null, body.closingDate, body.estimatedValue,
    body.documentsNote || null, req.user.id]);
  await audit(pool, req.user.id, 'CREATE', 'tender', result.insertId, null, { reference }, req.ip);
  res.status(201).json(await getOne(`${tenderSelect} WHERE t.id=?`, [result.insertId]));
}));

router.patch('/tenders/:id', auth, permit('qs.tender'), validate(z.object({
  status: z.enum(['Identified', 'Preparing', 'Submitted', 'Won', 'Lost', 'Withdrawn']).optional(),
  bidValue: z.number().nonnegative().optional(),
  submittedDate: isoDate.optional(),
  outcomeNote: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const tender = await getOne('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  const columns = { bidValue: 'bid_value', submittedDate: 'submitted_date', outcomeNote: 'outcome_note' };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE tenders SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), tender.id]);
  }
  /* Submitting without recording the date leaves the trail incomplete, so fill it in. */
  if (req.body.status === 'Submitted' && !tender.submitted_date && !req.body.submittedDate) {
    await query('UPDATE tenders SET submitted_date=? WHERE id=?', [today(), tender.id]);
  }
  await audit(pool, req.user.id, 'UPDATE', 'tender', tender.id, tender, req.body, req.ip);
  res.json(await getOne(`${tenderSelect} WHERE t.id=?`, [tender.id]));
}));

/* ------------------------------------------------------------------ Retention */

const retentionSelect = `SELECT r.id,r.description,r.amount,r.percent,r.held_from heldFrom,r.release_date releaseDate,
  r.defect_liability_ends defectLiabilityEnds,r.released_amount releasedAmount,r.status,r.notes,
  r.project_id projectId,p.name project,p.client,u.name createdBy
  FROM retentions r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.created_by`;

router.get('/retentions', auth, permit('qs.view', 'finance.view'), wrap(async (_req, res) =>
  res.json(await query(`${retentionSelect} ORDER BY r.release_date`))));

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

router.get('/subcontractors', auth, permit('qs.view', 'projects.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT s.id,s.name,s.trade,s.contact_person contact,s.phone,s.email,s.notes,
    (SELECT COUNT(*) FROM subcontractor_bills b WHERE b.subcontractor_id=s.id) bills,
    (SELECT COALESCE(SUM(b.amount-b.paid_amount),0) FROM subcontractor_bills b
      WHERE b.subcontractor_id=s.id AND b.status<>'Paid') outstanding
    FROM subcontractors s WHERE s.active=1 ORDER BY s.name`))));

router.post('/subcontractors', auth, permit('subcontractors.manage'), validate(z.object({
  name: z.string().min(2).max(180),
  trade: z.string().min(2).max(120),
  contact: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  notes: z.string().max(600).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query('INSERT INTO subcontractors (name,trade,contact_person,phone,email,notes) VALUES (?,?,?,?,?,?)',
      [body.name, body.trade, body.contact || null, body.phone || null, body.email || null, body.notes || null]);
    await audit(pool, req.user.id, 'CREATE', 'subcontractor', result.insertId, null, body, req.ip);
    res.status(201).json(await getOne('SELECT * FROM subcontractors WHERE id=?', [result.insertId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That subcontractor is already on file' });
    throw error;
  }
}));

router.get('/subcontractor-bills', auth, permit('qs.view', 'finance.view'), wrap(async (_req, res) =>
  res.json(await query(`SELECT b.id,b.reference,b.description,b.amount,b.paid_amount paidAmount,b.bill_date billDate,
    b.due_date dueDate,b.status,s.name subcontractor,p.name project,b.project_id projectId
    FROM subcontractor_bills b JOIN subcontractors s ON s.id=b.subcontractor_id
    JOIN projects p ON p.id=b.project_id ORDER BY b.id DESC`))));

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
