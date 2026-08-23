import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { sendDirect, channelStatus } from '../lib/channels.js';

const router = Router();

/**
 * Who can be written to.
 *
 * Three kinds, because the people who need telling are not one list: employees carry the
 * site phone numbers, users are the office accounts that may have no employee record, and
 * a plain number covers the subcontractor or supplier who is neither.
 */
router.get('/messaging/recipients', auth, permit('messages.send'), async (_req, res, next) => {
  try {
    const [employees, users, projects] = await Promise.all([
      query(`SELECT e.id,e.name,e.designation,e.phone,e.current_project_id projectId,p.name project
        FROM employees e LEFT JOIN projects p ON p.id=e.current_project_id
        WHERE e.status <> 'Left' ORDER BY e.name`),
      query(`SELECT id,name,email,role,whatsapp_phone phone FROM users WHERE active=1 ORDER BY name`),
      query("SELECT id,name FROM projects WHERE active=1 AND site_status <> 'Completed' ORDER BY name")
    ]);
    res.json({
      employees: employees.map(row => ({ ...row, reachable: Boolean(row.phone) })),
      users: users.map(row => ({ ...row, reachable: Boolean(row.phone) })),
      projects,
      channels: channelStatus()
    });
  } catch (error) { next(error); }
});

const recipientSchema = z.object({
  kind: z.enum(['Employee', 'User', 'Number']),
  id: z.coerce.number().int().positive().optional(),
  /* Free-typed numbers arrive here; picked people are resolved server-side. */
  address: z.string().trim().min(5).max(40).optional(),
  name: z.string().trim().min(1).max(160).optional()
});

const messageSchema = z.object({
  channel: z.enum(['WhatsApp']).default('WhatsApp'),
  subject: z.string().trim().max(180).optional(),
  body: z.string().trim().min(1, 'Write the message before sending').max(2000),
  recipients: z.array(recipientSchema).min(1, 'Choose at least one person to send to').max(200)
});

/**
 * Resolves each chosen recipient to a name and a number.
 *
 * Numbers are read from the database rather than trusted from the request: a client that
 * could name both the person and the number they are reached on could send the company's
 * message anywhere while the log recorded a colleague's name against it.
 */
async function resolve(recipients) {
  const resolved = [];
  for (const entry of recipients) {
    if (entry.kind === 'Employee') {
      const row = await getOne('SELECT id,name,phone FROM employees WHERE id=? AND status <> ?', [entry.id, 'Left']);
      if (!row) continue;
      resolved.push({ kind: 'Employee', id: row.id, name: row.name, address: row.phone || null });
    } else if (entry.kind === 'User') {
      const row = await getOne('SELECT id,name,whatsapp_phone phone FROM users WHERE id=? AND active=1', [entry.id]);
      if (!row) continue;
      resolved.push({ kind: 'User', id: row.id, name: row.name, address: row.phone || null });
    } else {
      if (!entry.address) continue;
      resolved.push({ kind: 'Number', id: null, name: entry.name || entry.address, address: entry.address });
    }
  }
  /* One person reachable on one number should receive one message, however they were picked. */
  const seen = new Set();
  return resolved.filter(row => {
    const key = row.address ? row.address.replace(/\D/g, '') : `no-address:${row.kind}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sends a written message to the chosen people and records what happened to each one.
 *
 * The reply reports per recipient rather than a single success: with a provider involved,
 * "sent" for eleven people and "no number on file" for the twelfth is the truth, and
 * rounding that to either outcome would be a lie the sender acts on.
 */
router.post('/messaging/send', auth, permit('messages.send'), validate(messageSchema), async (req, res, next) => {
  try {
    const recipients = await resolve(req.body.recipients);
    if (!recipients.length) throw fail(400, 'None of the chosen recipients could be found');

    const message = await query(
      'INSERT INTO outbound_messages (channel,subject,body,sent_by,recipient_count) VALUES (?,?,?,?,?)',
      [req.body.channel, req.body.subject || null, req.body.body, req.user.id, recipients.length]);
    const messageId = message.insertId;

    const results = [];
    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      let status = 'Sent';
      let detail = null;
      if (!recipient.address) {
        status = 'Skipped';
        detail = 'No WhatsApp number on file';
      } else {
        const outcome = await sendDirect(req.body.channel, recipient.address, {
          title: req.body.subject || 'GKUC SiteOps',
          message: req.body.body
        });
        status = outcome.status;
        detail = outcome.detail;
      }
      if (status === 'Sent') sent += 1;
      else if (status === 'Failed') failed += 1;

      await query(
        `INSERT INTO outbound_message_recipients (message_id,recipient_kind,recipient_id,name,address,status,provider,detail)
         VALUES (?,?,?,?,?,?,?,?)`,
        [messageId, recipient.kind, recipient.id, recipient.name,
          recipient.address || '—', status, 'meta-cloud', detail]);
      results.push({ name: recipient.name, address: recipient.address, status, detail });
    }

    await query('UPDATE outbound_messages SET sent_count=?, failed_count=? WHERE id=?', [sent, failed, messageId]);
    await audit(pool, req.user.id, 'SEND', 'outbound_message', messageId, null,
      { channel: req.body.channel, recipients: recipients.length, sent, failed }, req.ip);

    res.status(201).json({ id: messageId, total: recipients.length, sent, failed, results });
  } catch (error) { next(error); }
});

/** What has been sent, so a message can be shown to have gone out — and to whom. */
router.get('/messaging/history', auth, permit('messages.send'), async (_req, res, next) => {
  try {
    const messages = await query(`SELECT m.id,m.channel,m.subject,m.body,m.recipient_count recipientCount,
      m.sent_count sentCount,m.failed_count failedCount,m.created_at createdAt,u.name sentBy
      FROM outbound_messages m JOIN users u ON u.id=m.sent_by ORDER BY m.id DESC LIMIT 50`);
    res.json(messages);
  } catch (error) { next(error); }
});

router.get('/messaging/history/:id', auth, permit('messages.send'), async (req, res, next) => {
  try {
    res.json(await query(`SELECT recipient_kind kind,name,address,status,detail
      FROM outbound_message_recipients WHERE message_id=? ORDER BY name`, [req.params.id]));
  } catch (error) { next(error); }
});

export default router;
