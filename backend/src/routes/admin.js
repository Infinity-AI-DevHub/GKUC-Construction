import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, hashPassword, pool, query } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { runAlertScan } from '../alerts.js';
import { documentContext, quotationDocument } from '../lib/documents.js';
import { BLOCKS, DEFAULT_DESIGN, FONTS, HEADER_PIECES, normaliseDesign } from '../lib/document-design.js';


const router = Router();

/* Users and access (PID 2.14) */
router.get('/users', auth, permit('admin.users'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,email,role,role_id roleId,active,created_at createdAt FROM users ORDER BY name'))));

/**
 * The company's own details, as they appear on anything sent to a client. Readable by
 * anyone signed in, because documents render from it; changed only by an administrator.
 */
const COMPANY = `SELECT name,address,telephone,email,tin,vat_number vatNumber,
  bank_details bankDetails,vat_percent vatPercent
  FROM company_settings WHERE id=1`;

router.get('/company', auth, wrap(async (_req, res) => res.json(await getOne(COMPANY) || {})));

router.put('/company', auth, permit('admin.users'), validate(z.object({
  name: z.string().min(2).max(180),
  address: z.string().max(400).default(''),
  telephone: z.string().max(120).default(''),
  email: z.string().email().or(z.literal('')).default(''),
  tin: z.string().max(40).default(''),
  vatNumber: z.string().max(40).default(''),
  bankDetails: z.string().max(400).default(''),
  vatPercent: z.number().min(0).max(100).default(18)
})), wrap(async (req, res) => {
  const body = req.body;
  const before = await getOne(COMPANY);
  await query(`UPDATE company_settings SET name=?,address=?,telephone=?,email=?,tin=?,vat_number=?,
      bank_details=?,vat_percent=?,updated_by=? WHERE id=1`,
  [body.name, body.address, body.telephone, body.email, body.tin, body.vatNumber,
    body.bankDetails, body.vatPercent, req.user.id]);
  const after = await getOne(COMPANY);
  await audit(pool, req.user.id, 'UPDATE', 'company', 1, before, after, req.ip);
  res.json(after);
}));

/**
 * How documents look and what standing text they carry. Readable by anyone signed in,
 * because every document renders from it; changed only by an administrator.
 */
const DOCUMENT_SETTINGS = `SELECT accent_colour accentColour,paper_size paperSize,
  show_logo showLogo,show_signatures showSignatures,show_amount_in_words showAmountInWords,
  show_bank_details showBankDetails,footer_note footerNote,
  quotation_terms quotationTerms,boq_terms boqTerms,invoice_terms invoiceTerms
  FROM document_settings WHERE id=1`;

const asBooleans = row => (row && {
  ...row,
  showLogo: Boolean(row.showLogo),
  showSignatures: Boolean(row.showSignatures),
  showAmountInWords: Boolean(row.showAmountInWords),
  showBankDetails: Boolean(row.showBankDetails)
});

router.get('/document-settings', auth, wrap(async (_req, res) =>
  res.json(asBooleans(await getOne(DOCUMENT_SETTINGS)) || {})));

router.put('/document-settings', auth, permit('admin.users'), validate(z.object({
  accentColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #16305c').default('#16305c'),
  paperSize: z.enum(['A4', 'Letter']).default('A4'),
  showLogo: z.boolean().default(true),
  showSignatures: z.boolean().default(true),
  showAmountInWords: z.boolean().default(true),
  showBankDetails: z.boolean().default(true),
  footerNote: z.string().max(300).default(''),
  quotationTerms: z.string().max(2000).default(''),
  boqTerms: z.string().max(2000).default(''),
  invoiceTerms: z.string().max(2000).default('')
})), wrap(async (req, res) => {
  const body = req.body;
  const before = await getOne(DOCUMENT_SETTINGS);
  await query(`UPDATE document_settings SET accent_colour=?,paper_size=?,show_logo=?,show_signatures=?,
      show_amount_in_words=?,show_bank_details=?,footer_note=?,quotation_terms=?,boq_terms=?,invoice_terms=?,
      updated_by=? WHERE id=1`,
  [body.accentColour, body.paperSize, body.showLogo ? 1 : 0, body.showSignatures ? 1 : 0,
    body.showAmountInWords ? 1 : 0, body.showBankDetails ? 1 : 0, body.footerNote,
    body.quotationTerms, body.boqTerms, body.invoiceTerms, req.user.id]);
  const after = await getOne(DOCUMENT_SETTINGS);
  await audit(pool, req.user.id, 'UPDATE', 'document_settings', 1, before, after, req.ip);
  res.json(asBooleans(after));
}));

/**
 * The visual design of documents, and a live preview of it.
 *
 * The preview renders a made-up quotation rather than a real one: the designer is about
 * layout and colour, and a person arranging a page should not need a real client's figures
 * in front of them to do it — nor should a design change touch a real record.
 */
router.get('/document-design', auth, wrap(async (_req, res) => {
  const row = await getOne('SELECT design FROM document_settings WHERE id=1');
  const stored = typeof row?.design === 'string'
    ? (() => { try { return JSON.parse(row.design); } catch { return null; } })()
    : row?.design;
  res.json({ design: normaliseDesign(stored), blocks: BLOCKS, pieces: HEADER_PIECES, fonts: FONTS, defaults: DEFAULT_DESIGN });
}));

router.put('/document-design', auth, permit('admin.users'), wrap(async (req, res) => {
  const design = normaliseDesign(req.body?.design);
  const before = await getOne('SELECT design FROM document_settings WHERE id=1');
  await query('UPDATE document_settings SET design=?,updated_by=? WHERE id=1',
    [JSON.stringify(design), req.user.id]);
  await audit(pool, req.user.id, 'UPDATE', 'document_design', 1, before, design, req.ip);
  res.json({ design });
}));

router.post('/document-design/preview', auth, permit('admin.users'), wrap(async (req, res) => {
  const design = normaliseDesign(req.body?.design);
  const context = await documentContext(getOne);
  res.type('html').send(quotationDocument({
    ...context,
    design,
    quotation: {
      reference: 'QUO-2026-0001',
      clientName: 'Provincial Road Development Department',
      project: 'Improvement of Wasiwewa – Kiridigala Road',
      title: 'Improvement of Wasiwewa – Kiridigala Road (PRDD/SP/25/01/02)',
      quoteDate: new Date(), validUntil: null, boqReference: 'BOQ-2026-0001',
      preparedBy: req.user.name, subtotal: 2_612_400, markupPercent: 10, vatPercent: 18,
      total: 3_391_299.12, notes: 'Rates hold for the chainage stated above.', terms: null
    },
    items: [
      { reference: '1', description: 'Clearing site before and after using u/sk labour', unit: 'Days', quantity: 6, rate: 2800, amount: 16800 },
      { reference: '2', description: 'Reducing high side and levelling using motor grader', unit: 'Days', quantity: 4.5, rate: 67532.42, amount: 303895.89 },
      { reference: '3', description: 'Supplying, spreading, watering and compacting A.B.C', unit: 'm3', quantity: 350, rate: 6282, amount: 2198700 },
      { reference: '4', description: 'Casting guard stone in 1:2:4 concrete', unit: 'no', quantity: 24, rate: 3971, amount: 95304 }
    ]
  }));
}));

router.get('/users/roles', auth, permit('admin.users', 'admin.roles'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,description FROM roles ORDER BY is_system DESC, name'))));

router.post('/users', auth, permit('admin.users'), validate(z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(10),
  roleId: z.number().int().positive()
})), wrap(async (req, res) => {
  const body = req.body;
  const role = await getOne('SELECT id,name FROM roles WHERE id=?', [body.roleId]);
  if (!role) return res.status(400).json({ error: 'Unknown role' });
  const result = await query('INSERT INTO users (name,email,password_hash,role,role_id) VALUES (?,?,?,?,?)',
    [body.name, body.email.toLowerCase(), hashPassword(body.password), role.name, role.id]);
  const row = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'user', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/users/:id', auth, permit('admin.users'), validate(z.object({
  active: z.boolean().optional(),
  password: z.string().min(10).optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'User not found' });
  if (Number(req.params.id) === req.user.id && req.body.active === false) {
    return res.status(409).json({ error: 'You cannot deactivate your own account' });
  }
  if (req.body.active !== undefined) {
    await query('UPDATE users SET active=? WHERE id=?', [req.body.active, req.params.id]);
    if (!req.body.active) await query('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
  }
  if (req.body.password) {
    await query('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(req.body.password), req.params.id]);
    await query('DELETE FROM sessions WHERE user_id=?', [req.params.id]);
  }
  const after = await getOne('SELECT id,name,email,role,active FROM users WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'user', after.id, before, after, req.ip);
  res.json(after);
}));

/* Immutable audit trail */
router.get('/audit', auth, permit('admin.users'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.entity) { filters.push('a.entity=?'); params.push(req.query.entity); }
  if (req.query.action) { filters.push('a.action=?'); params.push(req.query.action); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT a.id,u.name user,a.action,a.entity,a.entity_id entityId,a.ip_address ip,a.created_at createdAt
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.id DESC LIMIT 500`, params));
}));

/*
 * Whose notification is it?
 *
 * One addressed to a person is theirs alone. One addressed to nobody in particular is for
 * whoever holds the permission it was sent to — or for everyone, if it names no audience.
 *
 * This used to read `user_id IS NULL OR ...`, which is true of every audience-addressed
 * alert and so let all of them through to everybody: a Store Keeper could read the budget
 * warnings meant for Finance. The audience is only a filter if it actually filters.
 */
const addressedToMe = user => {
  const held = user.permissions?.length ? user.permissions : [''];
  return {
    clause: `(n.user_id = ? OR (n.user_id IS NULL AND (n.audience IS NULL
      OR n.audience IN (${held.map(() => '?').join(',')}))))`,
    params: [user.id, ...held]
  };
};

/* Notification centre */
router.get('/notifications', auth, wrap(async (req, res) => {
  const mine = addressedToMe(req.user);
  res.json(await query(`SELECT n.id,n.title,n.message,n.severity,n.status,n.channel,
    n.reference_type referenceType,n.reference_id referenceId,n.created_at createdAt
    FROM notifications n WHERE ${mine.clause} ORDER BY n.id DESC LIMIT 100`, mine.params));
}));

router.post('/notifications/:id/read', auth, wrap(async (req, res) => {
  const mine = addressedToMe(req.user);
  await query(`UPDATE notifications n SET n.status='Read' WHERE n.id=? AND ${mine.clause}`,
    [req.params.id, ...mine.params]);
  res.status(204).end();
}));

router.post('/notifications/read-all', auth, wrap(async (req, res) => {
  const mine = addressedToMe(req.user);
  await query(`UPDATE notifications n SET n.status='Read' WHERE n.status<>'Read' AND ${mine.clause}`, mine.params);
  res.status(204).end();
}));

/** Manual trigger for the deadline/threshold scan; it also runs on a schedule. */
router.post('/notifications/scan', auth, permit('admin.users'), wrap(async (_req, res) => {
  res.json({ raised: await runAlertScan() });
}));

export default router;
