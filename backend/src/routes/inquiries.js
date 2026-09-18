import { Router } from 'express';
import { z } from 'zod';
import { audit, clock, getOne, nextReference, pool, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { notify } from '../alerts.js';
import { resolveProjectManager } from '../lib/project-manager.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * PID section 3, step 1 — a customer contacts GKUC. Capturing the inquiry here means the
 * project record later carries where the work came from, and nothing sits in someone's
 * phone waiting to be typed up.
 */
const select = `SELECT i.id,i.company_id companyId,c.name company,i.reference,i.customer_name customer,i.contact_person contact,i.phone,i.email,i.location,
  i.description,i.expected_value expectedValue,i.expected_start expectedStart,i.source,i.status,i.lost_reason lostReason,
  i.project_id projectId,p.name project,u.name createdBy,i.created_at createdAt
  FROM inquiries i JOIN companies c ON c.id=i.company_id LEFT JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by`;

/**
 * The history of dealings with a client — PID v3 §3.5.
 *
 * Held against the enquiry and, once it is won, against the project as well, so the
 * conversations that won the work stay with the work rather than ending at conversion.
 */
const communicationSelect = `SELECT c.id,c.inquiry_id inquiryId,c.project_id projectId,c.direction,c.channel,
  c.contact_person contactPerson,c.summary,c.happened_at happenedAt,c.follow_up_date followUpDate,
  u.name loggedBy,i.reference inquiryReference,i.customer_name customer,p.name project
  FROM client_communications c JOIN users u ON u.id=c.logged_by
  LEFT JOIN inquiries i ON i.id=c.inquiry_id LEFT JOIN projects p ON p.id=c.project_id`;

/** Everything logged lately, newest first — the coordinator's own record of who said what. */
router.get('/communications/all', auth, permit('enquiries.manage', 'projects.view'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.projectId) { filters.push('c.project_id=?'); params.push(req.query.projectId); }
  if (req.query.followUp === 'due') { filters.push('c.follow_up_date IS NOT NULL AND c.follow_up_date <= CURDATE()'); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`${communicationSelect} ${where} ORDER BY c.happened_at DESC, c.id DESC LIMIT 200`, params));
}));

/**
 * One client's history. Where an enquiry has become a project, anything logged against
 * that project is shown alongside — it is the same relationship either way.
 */
router.get('/:id/communications', auth, permit('enquiries.manage', 'projects.view'), wrap(async (req, res) => {
  const inquiry = await getOne('SELECT id,project_id FROM inquiries WHERE id=?', [req.params.id]);
  if (!inquiry) return res.status(404).json({ error: 'Enquiry not found' });
  const rows = inquiry.project_id
    ? await query(`${communicationSelect} WHERE c.inquiry_id=? OR c.project_id=? ORDER BY c.happened_at DESC, c.id DESC`,
      [inquiry.id, inquiry.project_id])
    : await query(`${communicationSelect} WHERE c.inquiry_id=? ORDER BY c.happened_at DESC, c.id DESC`, [inquiry.id]);
  res.json(rows);
}));

router.post('/:id/communications', auth, permit('enquiries.manage'), validate(z.object({
  direction: z.enum(['Incoming', 'Outgoing']).default('Outgoing'),
  channel: z.string().trim().min(1).max(60).default('Call'),
  contactPerson: z.string().max(120).optional(),
  summary: z.string().min(3).max(1000),
  happenedAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/)).optional(),
  followUpDate: isoDate.optional()
})), fromOptions({ channel: 'client.channel' }), wrap(async (req, res) => {
  const inquiry = await getOne('SELECT id,project_id FROM inquiries WHERE id=?', [req.params.id]);
  if (!inquiry) return res.status(404).json({ error: 'Enquiry not found' });

  const body = req.body;
  const happened = (body.happenedAt || `${today()} ${clock()}`).replace('T', ' ').slice(0, 19);
  const result = await query(`INSERT INTO client_communications
    (inquiry_id,project_id,direction,channel,contact_person,summary,happened_at,follow_up_date,logged_by)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  [inquiry.id, inquiry.project_id || null, body.direction, body.channel,
    body.contactPerson || null, body.summary, happened, body.followUpDate || null, req.user.id]);

  const row = await getOne(`${communicationSelect} WHERE c.id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'client_communication', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.get('/', auth, permit('enquiries.manage','projects.view'), wrap(async (req, res) => {
  const where = req.query.status ? 'WHERE i.status=?' : '';
  const params = req.query.status ? [req.query.status] : [];
  res.json(await query(`${select} ${where} ORDER BY i.id DESC`, params));
}));

router.post('/', auth, permit('enquiries.manage'), validate(z.object({
  companyId: z.number().int().positive().default(1),
  customer: z.string().min(2).max(180).optional(),
  clientId: z.number().int().positive().optional(),
  contact: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  location: z.string().min(2).max(180),
  description: z.string().min(3).max(4000),
  expectedValue: z.number().nonnegative().default(0),
  expectedStart: isoDate.optional(),
  source: z.string().max(80).optional()
}).refine(value => value.clientId || value.customer, { message: 'Choose a client', path: ['clientId'] })), wrap(async (req, res) => {
  const body = req.body;
  let client = body.clientId
    ? await getOne('SELECT * FROM clients WHERE id=? AND active=1', [body.clientId])
    : await getOne('SELECT * FROM clients WHERE LOWER(name)=LOWER(?) ORDER BY id LIMIT 1', [body.customer]);
  if (!client && body.customer && !body.clientId) {
    const created = await query("INSERT INTO clients (type,name) VALUES ('Organisation',?)", [body.customer]);
    client = { id: created.insertId, name: body.customer };
  }
  if (!client) return res.status(400).json({ error: 'Choose an active client from the client directory.' });
  const reference = await nextReference('INQ', 'inquiries');
  const result = await query(`INSERT INTO inquiries
    (reference,company_id,client_id,customer_name,contact_person,phone,email,location,description,expected_value,expected_start,source,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [reference, body.companyId, client.id, client.name, body.contact || client.contact_person || null, body.phone || client.phone || null, body.email || client.email || null, body.location || client.site_address || client.billing_address || 'Location to confirm',
    body.description, body.expectedValue, body.expectedStart || null, body.source || null, req.user.id]);
  const row = await getOne(`${select} WHERE i.id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'inquiry', row.id, null, row, req.ip);
  await notify({
    audience: 'enquiries.manage',
    severity: 'Info',
    title: `New customer inquiry — ${body.customer}`,
    message: `${reference}: ${body.location}. ${body.description.slice(0, 200)}`,
    referenceType: 'inquiry',
    referenceId: row.id
  });
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit('enquiries.manage'), validate(z.object({
  status: z.enum(['New', 'In discussion', 'Quoted', 'Won', 'Lost']),
  lostReason: z.string().max(400).optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM inquiries WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Inquiry not found' });
  await query('UPDATE inquiries SET status=?,lost_reason=? WHERE id=?',
    [req.body.status, req.body.status === 'Lost' ? req.body.lostReason || null : null, before.id]);
  const after = await getOne(`${select} WHERE i.id=?`, [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'inquiry', after.id, before, after, req.ip);
  res.json(after);
}));

/**
 * Winning an inquiry registers the project (step 2) and links the two, so the trail from
 * first contact through to site work stays intact.
 */
router.post('/:id/convert', auth, permit('enquiries.manage'), validate(z.object({
  name: z.string().min(3).max(180),
  manager: z.string().min(2).max(120).optional(),
  managerEmployeeId: z.number().int().positive().optional(),
  stage: z.string().min(2).max(150).default('Pre-construction'),
  budget: z.number().nonnegative().default(0),
  startDate: isoDate.optional(),
  endDate: isoDate.optional()
})), wrap(async (req, res) => {
  const inquiry = await getOne('SELECT * FROM inquiries WHERE id=?', [req.params.id]);
  if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });
  if (inquiry.project_id) return res.status(409).json({ error: 'This inquiry has already been converted' });

  const body = req.body;
  const manager = await resolveProjectManager(body);
  const projectId = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO projects (company_id,name,client_id,client,manager,manager_employee_id,site,stage,budget,start_date,end_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [inquiry.company_id, body.name, inquiry.client_id, inquiry.customer_name, manager.manager, manager.managerEmployeeId, inquiry.location, body.stage,
      body.budget || inquiry.expected_value, body.startDate || null, body.endDate || null]);
    if (manager.managerEmployeeId) await connection.execute(
      'INSERT INTO project_manager_assignments (project_id,employee_id) VALUES (?,?)',
      [result.insertId, manager.managerEmployeeId]);
    await connection.execute("UPDATE inquiries SET status='Won', project_id=? WHERE id=?", [result.insertId, inquiry.id]);
    /* The conversations that won the work belong to the project from here on. */
    await connection.execute(
      'UPDATE client_communications SET project_id=? WHERE inquiry_id=? AND project_id IS NULL',
      [result.insertId, inquiry.id]);
    await audit(connection, req.user.id, 'CONVERT', 'inquiry', inquiry.id, inquiry, { projectId: result.insertId }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne('SELECT * FROM projects WHERE id=?', [projectId]));
}));

export default router;
