import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, hashPassword, pool, query, transaction } from '../db.js';
import { auth, can, permissionsFor, permit, validate, wrap } from '../lib/http.js';
import { PRIVILEGED_KEYS } from '../lib/permissions.js';
import { strongPassword } from '../lib/passwords.js';
import { runAlertScan } from '../alerts.js';


const router = Router();

/* Users and access (PID 2.14) */
router.get('/users', auth, permit('admin.users'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,email,role,role_id roleId,active,created_at createdAt FROM users ORDER BY name'))));

/**
 * The company's own details, as they appear on anything sent to a client. Readable by
 * anyone signed in, because documents render from it; changed only by an administrator.
 */
const COMPANY = `SELECT c.id,c.code,c.name,
  c.registration_number registrationNumber,
  COALESCE(NULLIF(c.address,''),CASE WHEN c.id=1 THEN s.address END,'') address,
  COALESCE(NULLIF(c.telephone,''),CASE WHEN c.id=1 THEN s.telephone END,'') telephone,
  COALESCE(NULLIF(c.email,''),CASE WHEN c.id=1 THEN s.email END,'') email,
  COALESCE(NULLIF(c.tin,''),CASE WHEN c.id=1 THEN s.tin END,'') tin,
  COALESCE(NULLIF(c.vat_number,''),CASE WHEN c.id=1 THEN s.vat_number END,'') vatNumber,
  COALESCE(NULLIF(c.bank_details,''),CASE WHEN c.id=1 THEN s.bank_details END,'') bankDetails,
  c.default_vat_rate vatPercent FROM companies c LEFT JOIN company_settings s ON s.id=1 WHERE c.id=?`;

/* Bank account, TIN and VAT registration live here, so this is not general reading — it is
   the Administration screen's own data and follows the same right as editing it. */
router.get('/company', auth, permit("admin.company"), wrap(async (req, res) => {
  const companyId=Number(req.query.companyId)||1;
  res.json(await getOne(COMPANY,[companyId]) || {});
}));

router.put('/company', auth, permit("admin.company"), validate(z.object({
  name: z.string().min(2).max(180),
  address: z.string().max(400).default(''),
  telephone: z.string().max(120).default(''),
  email: z.string().email().or(z.literal('')).default(''),
  registrationNumber: z.string().trim().max(80).default(''),
  tin: z.string().max(40).default(''),
  vatNumber: z.string().max(40).default(''),
  bankDetails: z.string().max(400).default(''),
  vatPercent: z.number().min(0).max(100).default(18)
})), wrap(async (req, res) => {
  const body = req.body;
  const companyId=Number(req.query.companyId)||1;
  const before = await getOne(COMPANY,[companyId]);
  if(!before) return res.status(404).json({error:'Company not found'});
  await query(`UPDATE companies SET name=?,address=?,telephone=?,email=?,registration_number=?,tin=?,vat_number=?,
      bank_details=?,default_vat_rate=? WHERE id=?`,
  [body.name, body.address, body.telephone, body.email, body.registrationNumber, body.tin, body.vatNumber,
    body.bankDetails, body.vatPercent,companyId]);
  if(companyId===1) await query(`UPDATE company_settings SET name=?,address=?,telephone=?,email=?,tin=?,vat_number=?,
      bank_details=?,vat_percent=?,updated_by=? WHERE id=1`,
  [body.name,body.address,body.telephone,body.email,body.tin,body.vatNumber,body.bankDetails,body.vatPercent,req.user.id]);
  const after = await getOne(COMPANY,[companyId]);
  await audit(pool, req.user.id, 'UPDATE', 'company', companyId, before, after, req.ip);
  res.json(after);
}));

const BANK_ACCOUNT = `SELECT id,company_id companyId,label,bank_name bankName,branch,
  account_name accountName,account_number accountNumber,swift_code swiftCode,active
  FROM company_bank_accounts`;

router.get('/company-bank-accounts', auth, permit("admin.company"), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId) || 1;
  res.json(await query(`${BANK_ACCOUNT} WHERE company_id=? AND active=1 ORDER BY label,bank_name`, [companyId]));
}));

router.post('/company-bank-accounts', auth, permit("admin.company"), validate(z.object({
  companyId: z.number().int().positive(), label: z.string().min(2).max(100),
  bankName: z.string().min(2).max(140), branch: z.string().max(140).optional(),
  accountName: z.string().min(2).max(180), accountNumber: z.string().min(3).max(80),
  swiftCode: z.string().max(40).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query(`INSERT INTO company_bank_accounts
    (company_id,label,bank_name,branch,account_name,account_number,swift_code) VALUES (?,?,?,?,?,?,?)`,
  [body.companyId, body.label, body.bankName, body.branch || null, body.accountName,
    body.accountNumber, body.swiftCode || null]);
  const row = await getOne(`${BANK_ACCOUNT} WHERE id=?`, [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'company_bank_account', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/company-bank-accounts/:id', auth, permit("admin.company"), validate(z.object({
  active: z.boolean()
})), wrap(async (req, res) => {
  const before = await getOne(`${BANK_ACCOUNT} WHERE id=?`, [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Bank account not found' });
  await query('UPDATE company_bank_accounts SET active=? WHERE id=?', [req.body.active ? 1 : 0, req.params.id]);
  const after = await getOne(`${BANK_ACCOUNT} WHERE id=?`, [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'company_bank_account', after.id, before, after, req.ip);
  res.json(after);
}));

/**
 * How documents look and what standing text they carry. Readable by anyone signed in,
 * because every document renders from it; changed only by an administrator.
 */
const DOCUMENT_SETTINGS = `SELECT accent_colour accentColour,paper_size paperSize,
  show_logo showLogo,show_signatures showSignatures,show_amount_in_words showAmountInWords,
  show_bank_details showBankDetails,footer_note footerNote,
  quotation_notes quotationNotes,quotation_terms quotationTerms,boq_terms boqTerms,invoice_terms invoiceTerms
  FROM document_settings WHERE id=1`;

const asBooleans = row => (row && {
  ...row,
  showLogo: Boolean(row.showLogo),
  showSignatures: Boolean(row.showSignatures),
  showAmountInWords: Boolean(row.showAmountInWords),
  showBankDetails: Boolean(row.showBankDetails)
});

router.get('/document-settings', auth, permit("admin.documents"), wrap(async (_req, res) =>
  res.json(asBooleans(await getOne(DOCUMENT_SETTINGS)) || {})));

router.put('/document-settings', auth, permit("admin.documents"), validate(z.object({
  accentColour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #16305c').default('#16305c'),
  paperSize: z.enum(['A4', 'Letter']).default('A4'),
  showLogo: z.boolean().default(true),
  showSignatures: z.boolean().default(true),
  showAmountInWords: z.boolean().default(true),
  showBankDetails: z.boolean().default(true),
  footerNote: z.string().max(300).default(''),
  quotationNotes: z.string().max(3000).default(''),
  quotationTerms: z.string().max(2000).default(''),
  boqTerms: z.string().max(2000).default(''),
  invoiceTerms: z.string().max(2000).default('')
})), wrap(async (req, res) => {
  const body = req.body;
  const before = await getOne(DOCUMENT_SETTINGS);
  await query(`UPDATE document_settings SET accent_colour=?,paper_size=?,show_logo=?,show_signatures=?,
      show_amount_in_words=?,show_bank_details=?,footer_note=?,quotation_notes=?,quotation_terms=?,boq_terms=?,invoice_terms=?,
      updated_by=? WHERE id=1`,
  [body.accentColour, body.paperSize, body.showLogo ? 1 : 0, body.showSignatures ? 1 : 0,
    body.showAmountInWords ? 1 : 0, body.showBankDetails ? 1 : 0, body.footerNote,
    body.quotationNotes, body.quotationTerms, body.boqTerms, body.invoiceTerms, req.user.id]);
  const after = await getOne(DOCUMENT_SETTINGS);
  await audit(pool, req.user.id, 'UPDATE', 'document_settings', 1, before, after, req.ip);
  res.json(asBooleans(after));
}));

router.get('/users/roles', auth, permit('admin.users', 'admin.roles'), wrap(async (_req, res) =>
  res.json(await query('SELECT id,name,description FROM roles ORDER BY is_system DESC, name'))));

router.get('/users/employee-options', auth, permit('admin.users'), wrap(async (_req, res) =>
  res.json(await query("SELECT id,code,name,email FROM employees WHERE user_id IS NULL AND status='Active' ORDER BY name"))));

router.post('/users', auth, permit('admin.users'), validate(z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: strongPassword,
  roleId: z.number().int().positive(),
  employeeId: z.number().int().positive().optional(),
  employmentStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const role = await getOne('SELECT id,name FROM roles WHERE id=?', [body.roleId]);
  if (!role) return res.status(400).json({ error: 'Unknown role' });
  const row = await transaction(async connection => {
    const [matches] = await connection.query(body.employeeId
      ? 'SELECT id,user_id FROM employees WHERE id=? FOR UPDATE'
      : 'SELECT id,user_id FROM employees WHERE LOWER(email)=? FOR UPDATE',
    [body.employeeId || body.email.toLowerCase()]);
    if ((body.employeeId && !matches.length) || matches.length > 1 || matches.some(employee => employee.user_id)) {
      throw Object.assign(new Error('This employee is missing, already has system access, or has duplicate profiles. Please check the employee record before creating the account.'), { status: 409 });
    }
    const [result] = await connection.query('INSERT INTO users (name,email,password_hash,role,role_id) VALUES (?,?,?,?,?)',
      [body.name, body.email.toLowerCase(), hashPassword(body.password), role.name, role.id]);
    let employeeId = matches[0]?.id;
    if (employeeId) {
      await connection.query('UPDATE employees SET user_id=? WHERE id=?', [result.insertId, employeeId]);
    } else {
      const [employee] = await connection.query(`INSERT INTO employees
        (code,name,email,user_id,designation,join_date,worker_type,payroll_category)
        VALUES (?,?,?,?,?,?,'Office','Office employee')`,
      [`USR-${result.insertId}`, body.name, body.email.toLowerCase(), result.insertId, role.name, body.employmentStartDate || null]);
      employeeId = employee.insertId;
      await audit(connection, req.user.id, 'CREATE', 'employee', employeeId, null, { name: body.name, userId: result.insertId }, req.ip);
    }
    const row = { id: result.insertId, name: body.name, email: body.email.toLowerCase(), role: role.name, active: 1, employeeId };
    await audit(connection, req.user.id, 'CREATE', 'user', row.id, null, row, req.ip);
    return row;
  });
  res.status(201).json(row);
}));

router.patch('/users/:id', auth, permit('admin.users'), validate(z.object({
  active: z.boolean().optional(),
  password: strongPassword.optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT id,name,email,role,role_id,active FROM users WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'User not found' });
  if (Number(req.params.id) === req.user.id && req.body.active === false) {
    return res.status(409).json({ error: 'You cannot deactivate your own account' });
  }

  /*
   * You cannot reach past your own authority.
   *
   * Holding admin.users meant being able to set anyone's password, the Managing Director's
   * included — and then sign in as them. A user-administrator is meant to manage accounts,
   * not to acquire every permission in the system by way of a password reset. Acting on an
   * account whose rights exceed your own is refused; the MD, holding everything, is
   * unaffected and can still act on anyone.
   */
  if (Number(req.params.id) !== req.user.id) {
    const theirs = new Set(await permissionsFor(before.id, before.role_id));
    const mine = new Set(req.user.permissions);
    /* Only the authorities that would amount to taking over the system are protected, so
       resetting an ordinary colleague's password remains help desk work. */
    const beyond = PRIVILEGED_KEYS.filter(key => theirs.has(key) && !mine.has(key));
    if (beyond.length) {
      return res.status(403).json({
        error: 'This account holds administrative authority you do not, so it cannot be changed '
          + `from here: ${beyond.join(', ')}`
      });
    }
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
/* admin.audit exists for exactly this and was going unused, so user-management authority
   silently carried the power to read everyone's activity trail. */
router.get('/audit', auth, permit('admin.audit'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.entity) { filters.push('a.entity=?'); params.push(req.query.entity); }
  if (req.query.action) { filters.push('a.action=?'); params.push(req.query.action); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await query(`SELECT a.id,u.name user,a.action,a.entity,a.entity_id entityId,a.ip_address ip,a.created_at createdAt
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.id DESC LIMIT 500`, params);
  /* Reading the trail is itself an event the trail should hold — otherwise the one record
     of who did what is the one place nobody's activity is recorded. */
  await audit(pool, req.user.id, 'READ', 'audit_logs', '', null, { filters: req.query, rows: rows.length }, req.ip);
  res.json(rows);
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

const caseAccess = user => {
  const held = user.permissions?.length ? user.permissions : [''];
  return {clause:`(c.user_id=? OR c.assigned_user_id=? OR (c.user_id IS NULL AND
    (c.audience IS NULL OR c.audience IN (${held.map(()=>'?').join(',')})))
    OR ?=1)`,params:[user.id,user.id,...held,Number(held.includes('admin.notifications'))]};
};
const CASE_SELECT = `SELECT c.id,c.title,c.message,c.severity,c.state,c.audience,
  c.reference_type referenceType,c.reference_id referenceId,c.assigned_user_id assignedUserId,
  u.name assignedTo,c.snoozed_until snoozedUntil,c.due_at dueAt,
  c.first_seen_at firstSeenAt,c.last_seen_at lastSeenAt,c.occurrence_count occurrenceCount,
  c.escalated_at escalatedAt,c.resolved_at resolvedAt,c.resolution_note resolutionNote,
  c.resolution_evidence resolutionEvidence FROM alert_cases c
  LEFT JOIN users u ON u.id=c.assigned_user_id`;

router.get('/notification-cases',auth,wrap(async(req,res)=>{
  const access=caseAccess(req.user);
  res.json(await query(`${CASE_SELECT} WHERE ${access.clause}
    ORDER BY (c.state='Resolved'),(c.snoozed_until>NOW()),FIELD(c.severity,'Critical','Warning','Info'),c.due_at LIMIT 200`,access.params));
}));
router.get('/notification-cases/assignees',auth,wrap(async(req,res)=>{
  const access=caseAccess(req.user);
  const visible=await query(`SELECT c.id,c.audience FROM alert_cases c WHERE c.id=? AND ${access.clause}`,
    [req.query.caseId,...access.params]);
  if(!visible.length)return res.status(404).json({error:'Case not found or not available to you'});
  const users=await query('SELECT id,name,role_id roleId FROM users WHERE active=1 ORDER BY name');
  const audience=visible[0].audience;
  const eligible=[];
  for(const user of users){
    const permissions=await permissionsFor(user.id,user.roleId);
    if(!audience||permissions.includes(audience)||permissions.includes('admin.notifications')) eligible.push({id:user.id,name:user.name});
  }
  res.json(eligible);
}));
router.get('/notification-cases/:id',auth,wrap(async(req,res)=>{
  const access=caseAccess(req.user);
  const rows=await query(`${CASE_SELECT} WHERE c.id=? AND ${access.clause}`,[req.params.id,...access.params]);
  if(!rows.length)return res.status(404).json({error:'Case not found or not available to you'});
  const events=await query(`SELECT e.id,e.action,e.note,e.evidence,e.created_at createdAt,u.name actor
    FROM alert_case_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.case_id=? ORDER BY e.id`,[req.params.id]);
  res.json({...rows[0],events});
}));
const caseAction=z.object({action:z.enum(['acknowledge','assign','start','snooze','note','resolve']),
  assigneeId:z.number().int().positive().optional(),until:z.string().datetime({offset:true}).optional(),
  note:z.string().trim().max(4000).optional(),evidence:z.string().trim().max(4000).optional()});
router.post('/notification-cases/:id/actions',auth,validate(caseAction),wrap(async(req,res)=>{
  const access=caseAccess(req.user);
  const rows=await query(`${CASE_SELECT} WHERE c.id=? AND ${access.clause}`,[req.params.id,...access.params]);
  const current=rows[0];
  if(!current)return res.status(404).json({error:'Case not found or not available to you'});
  const {action,assigneeId,until,note,evidence}=req.body;
  if(current.state==='Resolved')return res.status(409).json({error:'This case is resolved. A recurring condition will reopen it if it remains outstanding.'});
  if(action==='assign'){
    const target=assigneeId||req.user.id;
    const user=(await query('SELECT id,role_id roleId,active FROM users WHERE id=?',[target]))[0];
    if(!user?.active)return res.status(400).json({error:'Choose an active employee with system access.'});
    const permissions=await permissionsFor(user.id,user.roleId);
    if(current.audience&&!permissions.includes(current.audience)&&!permissions.includes('admin.notifications'))
      return res.status(403).json({error:'That employee cannot access this case. Choose someone with the relevant permission.'});
  }
  if(action==='snooze'&&(!until||new Date(until)<=new Date()))return res.status(400).json({error:'Choose a future date and time to snooze this case.'});
  if(action==='note'&&!note)return res.status(400).json({error:'Enter a note before saving.'});
  if(action==='resolve'&&(!note||!evidence))return res.status(400).json({error:'Explain the resolution and provide an evidence reference.'});
  if(action==='acknowledge'&&current.state!=='New')return res.status(409).json({error:'Only a new case can be acknowledged.'});
  if(action==='start'&&!['Acknowledged','Assigned'].includes(current.state))return res.status(409).json({error:'Acknowledge or assign this case before starting work.'});
  const target=assigneeId||req.user.id;
  const changes={acknowledge:["state='Acknowledged'",[]],assign:["state='Assigned',assigned_user_id=?",[target]],
    start:["state='In progress'",[]],snooze:["snoozed_until=?",[until?new Date(until):null]],
    note:["last_seen_at=last_seen_at",[]],resolve:["state='Resolved',resolved_at=NOW(),resolution_note=?,resolution_evidence=?",[note,evidence]]};
  await transaction(async connection=>{
    const [result]=await connection.execute(`UPDATE alert_cases SET ${changes[action][0]} WHERE id=? AND state<>'Resolved'`,
      [...changes[action][1],current.id]);
    if(!result.affectedRows)throw new Error('Case changed while you were editing it. Refresh and try again.');
    await connection.execute(`INSERT INTO alert_case_events(case_id,user_id,action,note,evidence) VALUES (?,?,?,?,?)`,
      [current.id,req.user.id,action,note||null,evidence||null]);
    await audit(connection,req.user.id,action.toUpperCase(),'alert_case',current.id,current,
      {assigneeId:action==='assign'?target:undefined,until,note,evidence},req.ip);
  });
  res.json((await query(`${CASE_SELECT} WHERE c.id=?`,[current.id]))[0]);
}));

/** Manual trigger for the deadline/threshold scan; it also runs on a schedule. */
router.post('/notifications/scan', auth, permit('admin.notifications'), wrap(async (_req, res) => {
  res.json({ raised: await runAlertScan() });
}));

export default router;
