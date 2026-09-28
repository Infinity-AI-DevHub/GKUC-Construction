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
  c.contact_person contactPerson,c.summary,c.happened_at happenedAt,c.follow_up_date followUpDate,c.follow_up_done_at followUpDoneAt,
  u.name loggedBy,i.reference inquiryReference,i.customer_name customer,p.name project
  FROM client_communications c JOIN users u ON u.id=c.logged_by
  LEFT JOIN inquiries i ON i.id=c.inquiry_id LEFT JOIN projects p ON p.id=c.project_id`;

const letterSelect = `SELECT l.id,l.received_date receivedDate,l.sender,l.sender_address senderAddress,
  l.letter_reference letterReference,l.subject,l.description,l.document_type documentType,
  l.client_id clientId,c.name client,l.project_id projectId,p.name project,
  l.assigned_employee_id assignedEmployeeId,e.name assignedEmployee,l.assigned_department assignedDepartment,
  l.status,l.logged_by loggedById,u.name loggedBy,l.created_at createdAt,l.updated_at updatedAt
  FROM incoming_letters l LEFT JOIN clients c ON c.id=l.client_id
  LEFT JOIN projects p ON p.id=l.project_id LEFT JOIN employees e ON e.id=l.assigned_employee_id
  JOIN users u ON u.id=l.logged_by`;
const letterInput = z.object({
  receivedDate: isoDate, sender: z.string().trim().min(2).max(180),
  senderAddress: z.string().max(500).optional().nullable(), letterReference: z.string().max(120).optional().nullable(),
  subject: z.string().trim().min(3).max(240), description: z.string().max(5000).optional().nullable(),
  documentType: z.enum(['Letter','Bank statement','Other']).default('Letter'),
  clientId: z.number().int().positive().optional().nullable(), projectId: z.number().int().positive().optional().nullable(),
  assignedEmployeeId: z.number().int().positive().optional().nullable(), assignedDepartment: z.string().max(120).optional().nullable(),
  status: z.enum(['Received','Assigned','In progress','Responded','Closed']).default('Received')
});

router.get('/letters/options', auth, permit('enquiries.manage'), wrap(async (_req,res) => {
  const [clients,projects,employees]=await Promise.all([
    query('SELECT id,name FROM clients WHERE active=1 ORDER BY name'),
    query('SELECT id,name,client_id clientId FROM projects WHERE active=1 ORDER BY name'),
    query("SELECT id,name FROM employees WHERE status<>'Left' ORDER BY name")
  ]);
  res.json({clients,projects,employees});
}));

router.get('/letters', auth, permit('enquiries.manage'), wrap(async (req,res) => {
  const filters=[]; const params=[];
  if (req.query.status) { filters.push('l.status=?'); params.push(req.query.status); }
  if (req.query.projectId) { filters.push('l.project_id=?'); params.push(req.query.projectId); }
  if (req.query.clientId) { filters.push('l.client_id=?'); params.push(req.query.clientId); }
  res.json(await query(`${letterSelect} ${filters.length?`WHERE ${filters.join(' AND ')}`:''} ORDER BY l.received_date DESC,l.id DESC LIMIT 500`,params));
}));

router.post('/letters', auth, permit('enquiries.manage'), validate(letterInput), wrap(async (req,res) => {
  const b=req.body;
  for (const [table,id,label] of [['clients',b.clientId,'client'],['projects',b.projectId,'project'],['employees',b.assignedEmployeeId,'employee']]) {
    if (id && !await getOne(`SELECT id FROM ${table} WHERE id=?`,[id])) return res.status(400).json({error:`Choose an existing ${label}.`});
  }
  if (b.clientId && b.projectId) {
    const project=await getOne('SELECT client_id FROM projects WHERE id=?',[b.projectId]);
    if (project.client_id && Number(project.client_id)!==b.clientId) return res.status(400).json({error:'The selected project belongs to another client. Choose the matching client or leave the project blank.'});
  }
  const result=await query(`INSERT INTO incoming_letters
    (received_date,sender,sender_address,letter_reference,subject,description,document_type,client_id,project_id,assigned_employee_id,assigned_department,status,logged_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[b.receivedDate,b.sender,b.senderAddress||null,b.letterReference||null,b.subject,b.description||null,b.documentType,b.clientId||null,b.projectId||null,b.assignedEmployeeId||null,b.assignedDepartment||null,b.status,req.user.id]);
  const row=await getOne(`${letterSelect} WHERE l.id=?`,[result.insertId]);
  await audit(pool,req.user.id,'CREATE','incoming_letter',row.id,null,row,req.ip);
  res.status(201).json(row);
}));

router.patch('/letters/:id', auth, permit('enquiries.manage'), validate(letterInput.partial()), wrap(async (req,res) => {
  const before=await getOne('SELECT * FROM incoming_letters WHERE id=?',[req.params.id]);
  if (!before) return res.status(404).json({error:'Incoming letter not found.'});
  const b=req.body;
  if (!Object.keys(b).length) return res.status(400).json({error:'Enter a change before saving.'});
  const fields={receivedDate:'received_date',sender:'sender',senderAddress:'sender_address',letterReference:'letter_reference',subject:'subject',description:'description',documentType:'document_type',clientId:'client_id',projectId:'project_id',assignedEmployeeId:'assigned_employee_id',assignedDepartment:'assigned_department',status:'status'};
  const changes=Object.entries(b).map(([key,value])=>[fields[key],value]);
  await query(`UPDATE incoming_letters SET ${changes.map(([column])=>`${column}=?`).join(',')} WHERE id=?`,[...changes.map(([,value])=>value??null),before.id]);
  const row=await getOne(`${letterSelect} WHERE l.id=?`,[before.id]);
  await audit(pool,req.user.id,'UPDATE','incoming_letter',row.id,before,row,req.ip);
  res.json(row);
}));

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

router.patch('/:id/communications/:communicationId/follow-up', auth, permit('enquiries.manage'), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM client_communications WHERE id=? AND inquiry_id=?',
    [req.params.communicationId, req.params.id]);
  if (!before) return res.status(404).json({ error: 'Client follow-up not found' });
  if (!before.follow_up_date) return res.status(409).json({ error: 'This contact has no follow-up to complete' });
  await query('UPDATE client_communications SET follow_up_done_at=NOW() WHERE id=?', [before.id]);
  const after = await getOne(`${communicationSelect} WHERE c.id=?`, [before.id]);
  await audit(pool, req.user.id, 'COMPLETE', 'client_follow_up', before.id, before, after, req.ip);
  res.json(after);
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
