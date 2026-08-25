import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, transaction } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { publishTo, isOnline, onlineUserIds } from '../lib/realtime.js';
import { presenceMap } from '../lib/presence.js';

const router = Router();

/* Who is in a conversation, and still in it. */
const memberIds = async conversationId => (await query(
  'SELECT user_id id FROM conversation_members WHERE conversation_id=? AND left_at IS NULL',
  [conversationId])).map(row => row.id);

/**
 * Confirms the caller belongs to this conversation.
 *
 * Membership is the only thing that grants access to a conversation — not a role, not a
 * permission. Somebody who can see every project in the company still has no business
 * reading a chat they were not part of.
 */
async function mustBeMember(conversationId, userId) {
  const member = await getOne(
    'SELECT * FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL',
    [conversationId, userId]);
  if (!member) throw fail(404, 'That conversation was not found');
  return member;
}

/* ---- who you can talk to ------------------------------------------------ */

router.get('/chat/people', auth, permit('chat.use'), async (req, res, next) => {
  try {
    const [people, presence] = await Promise.all([
      query(`SELECT id,name,email,role FROM users WHERE active=1 AND id<>? ORDER BY name`, [req.user.id]),
      presenceMap()
    ]);
    const byId = new Map(presence.map(row => [row.id, row]));
    res.json(people.map(person => ({
      ...person,
      online: Boolean(byId.get(person.id)?.online),
      lastActiveAt: byId.get(person.id)?.lastActiveAt || null
    })));
  } catch (error) { next(error); }
});

/* ---- the conversation list ---------------------------------------------- */

/**
 * Everything the caller is part of, most recently active first, with the unread count and
 * enough of the last message to show a preview.
 */
router.get('/chat/conversations', auth, permit('chat.use'), async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT c.id, c.kind, c.name, c.topic, c.project_id projectId, p.name project,
             c.last_message_at lastMessageAt,
             m.body lastBody, m.sender_id lastSenderId, m.deleted_at lastDeletedAt,
             sender.name lastSenderName,
             (SELECT COUNT(*) FROM chat_messages x
               WHERE x.conversation_id=c.id AND x.sender_id<>?
                 AND x.id > COALESCE(me.last_read_message_id, 0)) unread
        FROM conversation_members me
        JOIN conversations c ON c.id=me.conversation_id
        LEFT JOIN chat_messages m ON m.id=c.last_message_id
        LEFT JOIN users sender ON sender.id=m.sender_id
        LEFT JOIN projects p ON p.id=c.project_id
       WHERE me.user_id=? AND me.left_at IS NULL
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT 100`, [req.user.id, req.user.id]);

    const online = new Set(onlineUserIds());
    for (const row of rows) {
      const members = await query(`
        SELECT u.id,u.name,u.role,u.last_active_at lastActiveAt
          FROM conversation_members cm JOIN users u ON u.id=cm.user_id
         WHERE cm.conversation_id=? AND cm.left_at IS NULL ORDER BY u.name`, [row.id]);
      row.members = members.map(member => ({ ...member, online: online.has(member.id) }));
      /* A direct chat is named by the other person, so the list reads as who you spoke to. */
      if (row.kind === 'Direct') {
        const other = row.members.find(member => member.id !== req.user.id);
        row.name = other?.name || 'Unknown';
        row.otherId = other?.id || null;
        row.online = Boolean(other && online.has(other.id));
        row.lastActiveAt = other?.lastActiveAt || null;
      }
    }
    res.json(rows);
  } catch (error) { next(error); }
});

/* ---- starting one -------------------------------------------------------- */

/**
 * Opens the direct conversation with somebody, creating it only if there is not one.
 *
 * Two people have one conversation, not one per time somebody pressed the button — anything
 * else scatters the history across duplicates nobody can find again.
 */
router.post('/chat/direct', auth, permit('chat.use'),
  validate(z.object({ userId: z.coerce.number().int().positive() })),
  async (req, res, next) => {
    try {
      if (req.body.userId === req.user.id) throw fail(400, 'You cannot open a conversation with yourself');
      const other = await getOne('SELECT id,name FROM users WHERE id=? AND active=1', [req.body.userId]);
      if (!other) throw fail(404, 'That person was not found');

      const existing = await getOne(`
        SELECT c.id FROM conversations c
          JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=? AND a.left_at IS NULL
          JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=? AND b.left_at IS NULL
         WHERE c.kind='Direct' LIMIT 1`, [req.user.id, other.id]);
      if (existing) return res.json({ id: existing.id, created: false });

      const id = await transaction(async connection => {
        const [created] = await connection.execute(
          "INSERT INTO conversations (kind,created_by) VALUES ('Direct',?)", [req.user.id]);
        for (const userId of [req.user.id, other.id]) {
          await connection.execute(
            'INSERT INTO conversation_members (conversation_id,user_id,role) VALUES (?,?,?)',
            [created.insertId, userId, 'Member']);
        }
        return created.insertId;
      });

      publishTo([other.id], 'chat:conversation', { id, kind: 'Direct', with: req.user.name });
      res.status(201).json({ id, created: true });
    } catch (error) { next(error); }
  });

router.post('/chat/groups', auth, permit('chat.use'),
  validate(z.object({
    name: z.string().trim().min(1).max(120),
    topic: z.string().trim().max(300).optional(),
    projectId: z.coerce.number().int().positive().optional(),
    memberIds: z.array(z.coerce.number().int().positive()).min(1).max(200)
  })),
  async (req, res, next) => {
    try {
      const wanted = [...new Set([...req.body.memberIds, req.user.id])];
      const people = await query(
        `SELECT id FROM users WHERE active=1 AND id IN (${wanted.map(() => '?').join(',')})`, wanted);
      if (people.length < 2) throw fail(400, 'A group needs at least one other person in it');

      const id = await transaction(async connection => {
        const [created] = await connection.execute(
          'INSERT INTO conversations (kind,name,topic,project_id,created_by) VALUES (?,?,?,?,?)',
          ['Group', req.body.name, req.body.topic || null, req.body.projectId || null, req.user.id]);
        for (const person of people) {
          await connection.execute(
            'INSERT INTO conversation_members (conversation_id,user_id,role) VALUES (?,?,?)',
            [created.insertId, person.id, person.id === req.user.id ? 'Admin' : 'Member']);
        }
        return created.insertId;
      });

      publishTo(people.map(p => p.id).filter(id2 => id2 !== req.user.id),
        'chat:conversation', { id, kind: 'Group', name: req.body.name, by: req.user.name });
      res.status(201).json({ id });
    } catch (error) { next(error); }
  });

/* ---- reading a conversation --------------------------------------------- */

/**
 * The messages, oldest last, with what became of each one.
 *
 * For a message the caller sent, the marks say how far it got: stored, reached everybody,
 * read by everybody. For a message they received, those marks are nobody's business but
 * the sender's, so they are not computed.
 */
router.get('/chat/conversations/:id/messages', auth, permit('chat.use'), async (req, res, next) => {
  try {
    await mustBeMember(req.params.id, req.user.id);
    const before = req.query.before ? Number(req.query.before) : null;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const rows = await query(`
      SELECT m.id, m.body, m.sender_id senderId, u.name senderName, m.created_at createdAt,
             m.deleted_at deletedAt, m.edited_at editedAt, m.reply_to_id replyToId,
             m.reference_type referenceType, m.reference_id referenceId
        FROM chat_messages m JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=? ${before ? 'AND m.id < ?' : ''}
       ORDER BY m.id DESC LIMIT ?`,
    before ? [req.params.id, before, String(limit)] : [req.params.id, String(limit)]);

    const mine = rows.filter(row => row.senderId === req.user.id).map(row => row.id);
    if (mine.length) {
      const receipts = await query(`
        SELECT message_id messageId,
               COUNT(*) total,
               SUM(delivered_at IS NOT NULL) delivered,
               SUM(read_at IS NOT NULL) readCount
          FROM chat_receipts WHERE message_id IN (${mine.map(() => '?').join(',')})
         GROUP BY message_id`, mine);
      const byMessage = new Map(receipts.map(row => [row.messageId, row]));
      for (const row of rows) {
        if (row.senderId !== req.user.id) continue;
        const receipt = byMessage.get(row.id);
        row.status = !receipt ? 'Sent'
          : Number(receipt.readCount) >= Number(receipt.total) ? 'Read'
            : Number(receipt.delivered) >= Number(receipt.total) ? 'Delivered' : 'Sent';
        row.readBy = Number(receipt?.readCount || 0);
        row.recipients = Number(receipt?.total || 0);
      }
    }

    res.json(rows.reverse());
  } catch (error) { next(error); }
});

/* ---- sending ------------------------------------------------------------- */

router.post('/chat/conversations/:id/messages', auth, permit('chat.use'),
  validate(z.object({
    body: z.string().trim().min(1, 'Type something to send').max(4000),
    replyToId: z.coerce.number().int().positive().optional(),
    referenceType: z.string().trim().max(60).optional(),
    referenceId: z.string().trim().max(60).optional()
  })),
  async (req, res, next) => {
    try {
      await mustBeMember(req.params.id, req.user.id);
      const members = await memberIds(req.params.id);
      const others = members.filter(id => id !== req.user.id);

      const messageId = await transaction(async connection => {
        const [created] = await connection.execute(
          `INSERT INTO chat_messages (conversation_id,sender_id,body,reply_to_id,reference_type,reference_id)
           VALUES (?,?,?,?,?,?)`,
          [req.params.id, req.user.id, req.body.body, req.body.replyToId || null,
            req.body.referenceType || null, req.body.referenceId || null]);

        /*
         * A receipt per recipient, marked delivered straight away for anybody with the
         * system open. That is what the second tick means — it reached their machine, not
         * that they have looked at it.
         */
        for (const userId of others) {
          await connection.execute(
            'INSERT INTO chat_receipts (message_id,user_id,delivered_at) VALUES (?,?,?)',
            [created.insertId, userId, isOnline(userId) ? new Date() : null]);
        }
        await connection.execute(
          'UPDATE conversations SET last_message_id=?, last_message_at=NOW() WHERE id=?',
          [created.insertId, req.params.id]);
        /* The sender has read what they just wrote. */
        await connection.execute(
          'UPDATE conversation_members SET last_read_message_id=? WHERE conversation_id=? AND user_id=?',
          [created.insertId, req.params.id, req.user.id]);
        return created.insertId;
      });

      const message = await getOne(`
        SELECT m.id,m.body,m.sender_id senderId,u.name senderName,m.created_at createdAt,
               m.reply_to_id replyToId,m.reference_type referenceType,m.reference_id referenceId
          FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`, [messageId]);

      publishTo(members, 'chat:message', { conversationId: Number(req.params.id), message });
      res.status(201).json({ ...message, status: others.every(isOnline) && others.length ? 'Delivered' : 'Sent' });
    } catch (error) { next(error); }
  });

/* ---- receipts ------------------------------------------------------------ */

/**
 * Marks everything up to a point as read, and tells the senders.
 *
 * Sent back to the whole conversation rather than only to the senders: in a group, the
 * marks on your own message are about everybody, so everybody's view of it changes.
 */
router.post('/chat/conversations/:id/read', auth, permit('chat.use'),
  validate(z.object({ upToId: z.coerce.number().int().positive() })),
  async (req, res, next) => {
    try {
      await mustBeMember(req.params.id, req.user.id);
      await query(`
        UPDATE chat_receipts r JOIN chat_messages m ON m.id=r.message_id
           SET r.read_at=COALESCE(r.read_at, NOW()), r.delivered_at=COALESCE(r.delivered_at, NOW())
         WHERE r.user_id=? AND m.conversation_id=? AND m.id<=?`,
      [req.user.id, req.params.id, req.body.upToId]);
      await query(
        'UPDATE conversation_members SET last_read_message_id=GREATEST(COALESCE(last_read_message_id,0),?) WHERE conversation_id=? AND user_id=?',
        [req.body.upToId, req.params.id, req.user.id]);

      publishTo(await memberIds(req.params.id), 'chat:read',
        { conversationId: Number(req.params.id), userId: req.user.id, upToId: Number(req.body.upToId) });
      res.status(204).end();
    } catch (error) { next(error); }
  });

/**
 * Marks anything outstanding as delivered.
 *
 * Called when a browser connects, so messages that arrived while somebody was away pick up
 * their second tick the moment they come back rather than when they next open the chat.
 */
router.post('/chat/delivered', auth, permit('chat.use'), async (req, res, next) => {
  try {
    const pending = await query(`
      SELECT r.message_id messageId, m.conversation_id conversationId
        FROM chat_receipts r JOIN chat_messages m ON m.id=r.message_id
       WHERE r.user_id=? AND r.delivered_at IS NULL LIMIT 500`, [req.user.id]);
    if (!pending.length) return res.json({ delivered: 0 });

    await query('UPDATE chat_receipts SET delivered_at=NOW() WHERE user_id=? AND delivered_at IS NULL',
      [req.user.id]);

    /* Each affected conversation is told once, not once per message. */
    for (const conversationId of new Set(pending.map(row => row.conversationId))) {
      publishTo(await memberIds(conversationId), 'chat:delivered',
        { conversationId, userId: req.user.id });
    }
    res.json({ delivered: pending.length });
  } catch (error) { next(error); }
});

/* ---- typing -------------------------------------------------------------- */

/** Not stored — it is only true for the next couple of seconds. */
router.post('/chat/conversations/:id/typing', auth, permit('chat.use'), async (req, res, next) => {
  try {
    await mustBeMember(req.params.id, req.user.id);
    const others = (await memberIds(req.params.id)).filter(id => id !== req.user.id);
    publishTo(others, 'chat:typing',
      { conversationId: Number(req.params.id), userId: req.user.id, name: req.user.name });
    res.status(204).end();
  } catch (error) { next(error); }
});

/* ---- managing a group ---------------------------------------------------- */

router.post('/chat/conversations/:id/members', auth, permit('chat.use'),
  validate(z.object({ userIds: z.array(z.coerce.number().int().positive()).min(1).max(100) })),
  async (req, res, next) => {
    try {
      const me = await mustBeMember(req.params.id, req.user.id);
      const conversation = await getOne('SELECT kind FROM conversations WHERE id=?', [req.params.id]);
      if (conversation.kind !== 'Group') throw fail(400, 'People can only be added to a group');
      if (me.role !== 'Admin') throw fail(403, 'Only a group admin can add people');

      for (const userId of req.body.userIds) {
        await query(`INSERT INTO conversation_members (conversation_id,user_id,role) VALUES (?,?,'Member')
                     ON DUPLICATE KEY UPDATE left_at=NULL`, [req.params.id, userId]);
      }
      publishTo(await memberIds(req.params.id), 'chat:conversation', { id: Number(req.params.id) });
      res.status(204).end();
    } catch (error) { next(error); }
  });

router.post('/chat/conversations/:id/leave', auth, permit('chat.use'), async (req, res, next) => {
  try {
    await mustBeMember(req.params.id, req.user.id);
    await query('UPDATE conversation_members SET left_at=NOW() WHERE conversation_id=? AND user_id=?',
      [req.params.id, req.user.id]);
    res.status(204).end();
  } catch (error) { next(error); }
});

/** Withdrawing something said. The message stays, marked as withdrawn. */
router.delete('/chat/messages/:id', auth, permit('chat.use'), async (req, res, next) => {
  try {
    const message = await getOne('SELECT * FROM chat_messages WHERE id=?', [req.params.id]);
    if (!message) throw fail(404, 'That message was not found');
    if (message.sender_id !== req.user.id) throw fail(403, 'You can only withdraw your own messages');
    await query('UPDATE chat_messages SET deleted_at=NOW() WHERE id=?', [req.params.id]);
    publishTo(await memberIds(message.conversation_id), 'chat:withdrawn',
      { conversationId: message.conversation_id, messageId: Number(req.params.id) });
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
