import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * PID section 3, step 1 — a customer contacts GKUC. Capturing the inquiry here means the
 * project record later carries where the work came from, and nothing sits in someone's
 * phone waiting to be typed up.
 */
const select = `SELECT i.id,i.reference,i.customer_name customer,i.contact_person contact,i.phone,i.email,i.location,
  i.description,i.expected_value expectedValue,i.expected_start expectedStart,i.source,i.status,i.lost_reason lostReason,
  i.project_id projectId,p.name project,u.name createdBy,i.created_at createdAt
  FROM inquiries i LEFT JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by`;

router.get('/', auth, wrap(async (req, res) => {
  const where = req.query.status ? 'WHERE i.status=?' : '';
  const params = req.query.status ? [req.query.status] : [];
  res.json(await query(`${select} ${where} ORDER BY i.id DESC`, params));
}));

router.post('/', auth, permit(roles.projects), validate(z.object({
  customer: z.string().min(2).max(180),
  contact: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
  location: z.string().min(2).max(180),
  description: z.string().min(3).max(4000),
  expectedValue: z.number().nonnegative().default(0),
  expectedStart: isoDate.optional(),
  source: z.string().max(80).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const reference = await nextReference('INQ', 'inquiries');
  const result = await query(`INSERT INTO inquiries
    (reference,customer_name,contact_person,phone,email,location,description,expected_value,expected_start,source,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [reference, body.customer, body.contact || null, body.phone || null, body.email || null, body.location,
    body.description, body.expectedValue, body.expectedStart || null, body.source || null, req.user.id]);
  const row = await getOne(`${select} WHERE i.id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'inquiry', row.id, null, row, req.ip);
  await notify({
    audience: 'Project Manager',
    severity: 'Info',
    title: `New customer inquiry — ${body.customer}`,
    message: `${reference}: ${body.location}. ${body.description.slice(0, 200)}`,
    referenceType: 'inquiry',
    referenceId: row.id
  });
  res.status(201).json(row);
}));

router.patch('/:id', auth, permit(roles.projects), validate(z.object({
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
router.post('/:id/convert', auth, permit(roles.projects), validate(z.object({
  name: z.string().min(3).max(180),
  manager: z.string().min(2).max(120),
  stage: z.string().min(2).max(150).default('Pre-construction'),
  budget: z.number().nonnegative().default(0),
  startDate: isoDate.optional(),
  endDate: isoDate.optional()
})), wrap(async (req, res) => {
  const inquiry = await getOne('SELECT * FROM inquiries WHERE id=?', [req.params.id]);
  if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });
  if (inquiry.project_id) return res.status(409).json({ error: 'This inquiry has already been converted' });

  const body = req.body;
  const projectId = await transaction(async connection => {
    const [result] = await connection.execute(`INSERT INTO projects (name,client,manager,site,stage,budget,start_date,end_date)
      VALUES (?,?,?,?,?,?,?,?)`, [body.name, inquiry.customer_name, body.manager, inquiry.location, body.stage,
      body.budget || inquiry.expected_value, body.startDate || null, body.endDate || null]);
    await connection.execute("UPDATE inquiries SET status='Won', project_id=? WHERE id=?", [result.insertId, inquiry.id]);
    await audit(connection, req.user.id, 'CONVERT', 'inquiry', inquiry.id, inquiry, { projectId: result.insertId }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne('SELECT * FROM projects WHERE id=?', [projectId]));
}));

export default router;
