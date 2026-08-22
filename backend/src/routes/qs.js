import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, spendSql, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { commitmentsDocument, documentContext, quotationDocument } from '../lib/documents.js';
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

const tenderSelect = `SELECT t.id,t.reference,t.contract_no contractNo,t.title,t.client,t.source,
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
  t.project_id projectId,p.name project,u.name owner,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id) checklistTotal,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id AND c.done=1) checklistDone,
  (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id AND c.done=0 AND c.mandatory=1) checklistOutstanding
  FROM tenders t LEFT JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.owner_id`;

/** The live bids, soonest deadline first — which is the order the QS works in. */
router.get('/tenders', auth, permit('qs.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.status) { filters.push('t.status=?'); params.push(req.query.status); }
  if (req.query.open === 'true') filters.push("t.status IN ('Identified','Document purchased','Preparing')");
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`${tenderSelect} ${where} ORDER BY
    FIELD(t.status,'Preparing','Document purchased','Identified','Submitted','Opened','Won','Lost','Withdrawn','Cancelled'),
    t.closing_date`, params));
}));

/* Declared before /tenders/:id, which would otherwise match this as a tender whose id
   is the word "commitments". */
router.get('/tenders/commitments', auth, permit('qs.view'), wrap(async (_req, res) => {
  const rows = await query(`SELECT p.id,p.name,p.client,p.stage,p.budget,${spendSql('p')} spent
    FROM projects p WHERE p.active=1 AND p.site_status <> 'Completed' ORDER BY p.name`);
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
  contractNo: z.string().max(120).optional(),
  title: z.string().min(3).max(220),
  client: z.string().min(2).max(180),
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

router.post('/tenders', auth, permit('qs.tender'), validate(tenderShape.refine(datesRunForwards, dateOrder)),
  wrap(async (req, res) => {
    const body = req.body;
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

  const entries = Object.entries(req.body).filter(([, value]) => value !== undefined);
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
  startDate: isoDate.optional(),
  endDate: isoDate.optional()
})), wrap(async (req, res) => {
  const tender = await getOne('SELECT * FROM tenders WHERE id=?', [req.params.id]);
  if (!tender) return res.status(404).json({ error: 'Tender not found' });
  if (tender.project_id) return res.status(409).json({ error: 'This tender has already been registered as a project' });
  const body = req.body;

  const outcome = await transaction(async connection => {
    let projectId = null;
    if (body.status === 'Won' && body.registerProject) {
      const budget = body.awardValue || Number(tender.bid_value) || Number(tender.estimated_value);
      const [project] = await connection.execute(
        `INSERT INTO projects (name,client,manager,site,stage,budget,progress,health,start_date,end_date)
         VALUES (?,?,?,?, 'Mobilisation', ?, 0, 'On track', ?, ?)`,
        [tender.title.slice(0, 180), tender.client, body.manager || 'To be assigned',
          tender.employer_office || tender.client, budget, body.startDate || today(), body.endDate || null]);
      projectId = project.insertId;
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
    : await getOne(`SELECT reference,contract_no contractNo,bidding_entity biddingEntity,specialty FROM tenders WHERE id=?`, [req.params.id]);
  if (req.params.id !== 'blank' && !tender) return res.status(404).json({ error: 'Tender not found' });

  const rows = await query(`SELECT p.name,p.client,p.budget,${spendSql('p')} spent
    FROM projects p WHERE p.active=1 AND p.site_status <> 'Completed' ORDER BY p.name`);
  const commitments = rows.map(row => ({
    project: row.name, client: row.client,
    initialAmount: Number(row.budget),
    outstanding: Math.max(0, Number(row.budget) - Number(row.spent))
  }));
  const totals = {
    initialAmount: commitments.reduce((sum, row) => sum + row.initialAmount, 0),
    outstanding: commitments.reduce((sum, row) => sum + row.outstanding, 0)
  };
  const context = await documentContext(getOne);
  res.type('html').send(commitmentsDocument({ ...context, tender, commitments, totals, asAt: today() }));
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
