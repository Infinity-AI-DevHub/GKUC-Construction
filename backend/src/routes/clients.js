import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, can, permit, validate, wrap } from '../lib/http.js';

const router = Router();
const optional = length => z.string().trim().max(length).nullable().optional();
const shape = z.object({
  type: z.enum(['Private', 'Organisation']),
  name: z.string().trim().min(2).max(180),
  contactPerson: optional(120), phone: optional(40), alternatePhone: optional(40), email: z.string().trim().email().max(190).nullable().optional().or(z.literal('')),
  billingAddress: optional(500), siteAddress: optional(500), city: optional(120), district: optional(120),
  province: optional(120), country: optional(100), registrationNumber: optional(100), taxNumber: optional(100), notes: optional(5000)
});
const columns = {
  type: 'type', name: 'name', contactPerson: 'contact_person', phone: 'phone', alternatePhone: 'alternate_phone',
  email: 'email', billingAddress: 'billing_address', siteAddress: 'site_address', city: 'city', district: 'district',
  province: 'province', country: 'country', registrationNumber: 'registration_number', taxNumber: 'tax_number', notes: 'notes'
};
const select = `SELECT id,type,name,contact_person contactPerson,phone,alternate_phone alternatePhone,email,
  billing_address billingAddress,site_address siteAddress,city,district,province,country,
  registration_number registrationNumber,tax_number taxNumber,notes,active,created_at createdAt,updated_at updatedAt FROM clients`;

router.get('/', auth, permit('projects.view'), wrap(async (req, res) => {
  const archived = req.query.archived === '1';
  res.json(await query(`${select} WHERE active=? ORDER BY name,id`, [archived ? 0 : 1]));
}));

router.get('/:id', auth, permit('projects.view'), wrap(async (req, res) => {
  const client = await getOne(`${select} WHERE id=?`, [req.params.id]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const companyId = req.query.companyId === undefined ? null : Number(req.query.companyId);
  if (companyId !== null && (!Number.isInteger(companyId) || companyId < 1))
    return res.status(400).json({ error: 'Choose a valid operating company to view this client’s history.' });
  const companyWhere = companyId ? ' AND company_id=?' : '';
  const scoped = companyId ? [client.id, companyId] : [client.id];
  const financialVisible = can(req, 'finance.view') || can(req, 'finance.invoice');
  const quotationsVisible = can(req, 'qs.view') || can(req, 'qs.quotation');
  const activityVisible = can(req, 'enquiries.manage') || can(req, 'projects.manage');
  const [projects, inquiries, quotations, tenders, invoices, payments, communications] = await Promise.all([
    query(`SELECT p.id,p.name,p.site,p.stage,p.budget,p.active,p.created_at createdAt,c.name company
      FROM projects p JOIN companies c ON c.id=p.company_id WHERE p.client_id=? ${companyId ? 'AND p.company_id=?' : ''} ORDER BY p.id DESC`, scoped),
    activityVisible ? query(`SELECT id,reference,description,status,expected_value expectedValue,created_at createdAt
      FROM inquiries WHERE client_id=? ${companyWhere} ORDER BY id DESC`, scoped) : [],
    quotationsVisible ? query(`SELECT q.id,q.reference,q.title,q.status,q.total,q.quote_date quoteDate,c.name company
      FROM quotations_client q JOIN companies c ON c.id=q.company_id WHERE q.client_id=? ${companyId ? 'AND q.company_id=?' : ''} ORDER BY q.id DESC`, scoped) : [],
    quotationsVisible ? query(`SELECT t.id,t.reference,t.title,t.status,t.estimated_value estimatedValue,
      t.closing_date closingDate,c.name company FROM tenders t JOIN companies c ON c.id=t.company_id
      WHERE t.client_id=? ${companyId ? 'AND t.company_id=?' : ''} ORDER BY t.id DESC`, scoped) : [],
    financialVisible ? query(`SELECT i.id,i.reference,i.title,i.kind,i.status,i.net_payable netPayable,i.paid_amount paidAmount,
      i.invoice_date invoiceDate,i.due_date dueDate,p.name project,c.name company
      FROM client_invoices i JOIN projects p ON p.id=i.project_id JOIN companies c ON c.id=p.company_id
      WHERE i.client_id=? ${companyId ? 'AND p.company_id=?' : ''} ORDER BY i.id DESC`, scoped) : [],
    financialVisible ? query(`SELECT r.id,r.amount,r.received_date receivedDate,r.method,r.reference,
      i.reference invoiceReference,i.id invoiceId,p.name project,c.name company
      FROM client_receipts r JOIN client_invoices i ON i.id=r.invoice_id
      JOIN projects p ON p.id=i.project_id JOIN companies c ON c.id=p.company_id
      WHERE i.client_id=? ${companyId ? 'AND p.company_id=?' : ''} ORDER BY r.received_date DESC,r.id DESC`, scoped) : [],
    activityVisible ? query(`SELECT cm.id,cm.direction,cm.channel,cm.contact_person contactPerson,cm.summary,
      cm.happened_at happenedAt,cm.follow_up_date followUpDate,u.name loggedBy
      FROM client_communications cm JOIN users u ON u.id=cm.logged_by
      LEFT JOIN inquiries i ON i.id=cm.inquiry_id LEFT JOIN projects p ON p.id=cm.project_id
      WHERE ${companyId ? '(i.client_id=? AND i.company_id=?) OR (p.client_id=? AND p.company_id=?)' : 'i.client_id=? OR p.client_id=?'}
      ORDER BY cm.happened_at DESC,cm.id DESC LIMIT 500`,
      companyId ? [client.id, companyId, client.id, companyId] : [client.id, client.id]) : []
  ]);
  res.json({ ...client, companyId, projects, inquiries, quotations, tenders, invoices, payments, communications, financialVisible, quotationsVisible, activityVisible,
    summary: { projects: projects.length, quotations: quotations.length, invoices: invoices.length,
      billed: invoices.reduce((sum, row) => sum + Number(row.netPayable), 0),
      received: payments.reduce((sum, row) => sum + Number(row.amount), 0) } });
}));

router.post('/', auth, permit('projects.manage'), validate(shape), wrap(async (req, res) => {
  const duplicate = await getOne('SELECT id FROM clients WHERE LOWER(name)=LOWER(?) AND type=? LIMIT 1', [req.body.name, req.body.type]);
  if (duplicate) return res.status(409).json({ error: 'A client with this name and type already exists. Open that profile instead of adding a duplicate.' });
  const values = Object.entries(req.body).filter(([key]) => key in columns);
  const result = await query(`INSERT INTO clients (${values.map(([key]) => columns[key]).join(',')}) VALUES (${values.map(() => '?').join(',')})`,
    values.map(([, value]) => value || null));
  const client = await getOne(`${select} WHERE id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'client', client.id, null, client, req.ip);
  res.status(201).json(client);
}));

router.patch('/:id', auth, permit('projects.manage'), validate(shape.partial().extend({ active: z.boolean().optional() })), wrap(async (req, res) => {
  const before = await getOne(`${select} WHERE id=?`, [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Client not found' });
  if ((req.body.name && req.body.name.toLowerCase() !== before.name.toLowerCase())
    || (req.body.type && req.body.type !== before.type)) {
    const duplicate = await getOne('SELECT id FROM clients WHERE LOWER(name)=LOWER(?) AND type=? AND id<>? LIMIT 1',
      [req.body.name || before.name, req.body.type || before.type, before.id]);
    if (duplicate) return res.status(409).json({ error: 'Another client with this name and type already exists.' });
  }
  const values = Object.entries(req.body).filter(([key]) => key in columns || key === 'active');
  if (!values.length) return res.json(before);
  await query(`UPDATE clients SET ${values.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
    [...values.map(([, value]) => value === '' ? null : value), before.id]);
  const after = await getOne(`${select} WHERE id=?`, [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'client', after.id, before, after, req.ip);
  res.json(after);
}));

router.delete('/:id', auth, permit('projects.manage'), wrap(async (req, res) => {
  const before = await getOne(`${select} WHERE id=?`, [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Client not found' });
  const linked = await getOne(`SELECT
    (SELECT COUNT(*) FROM projects WHERE client_id=?) +
    (SELECT COUNT(*) FROM inquiries WHERE client_id=?) +
    (SELECT COUNT(*) FROM quotations_client WHERE client_id=?) +
    (SELECT COUNT(*) FROM client_invoices WHERE client_id=?) +
    (SELECT COUNT(*) FROM tenders WHERE client_id=?) total`, [before.id,before.id,before.id,before.id,before.id]);
  if (Number(linked.total)) return res.status(409).json({ error: 'This client has linked history. Archive the profile instead; deleting it would break those records.' });
  await query('DELETE FROM clients WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'DELETE', 'client', before.id, before, null, req.ip);
  res.status(204).end();
}));

export default router;
