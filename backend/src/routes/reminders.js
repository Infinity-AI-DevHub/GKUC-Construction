import {Router} from 'express';
import {z} from 'zod';
import {audit, query, transaction} from '../db.js';
import {auth, fail, validate, wrap} from '../lib/http.js';
import {publishTo} from '../lib/realtime.js';

const router = Router();
router.use(auth);

router.get('/recipients', wrap(async (_req,res) => {
  res.json(await query('SELECT id,name FROM users WHERE active=1 ORDER BY name,id'));
}));

router.get('/', wrap(async (req,res) => {
  const mine = req.query.scope === 'mine';
  const rows = await query(`SELECT r.id,r.title,r.message,r.created_by createdBy,u.name creator,
      DATE_FORMAT(r.due_at,'%Y-%m-%dT%H:%i:%sZ') dueAt, mine.user_id IS NOT NULL addressedToMe,
      mine.notified_at IS NOT NULL notified
    FROM personal_reminders r JOIN users u ON u.id=r.created_by
    LEFT JOIN personal_reminder_recipients mine ON mine.reminder_id=r.id AND mine.user_id=?
    WHERE ${mine ? 'mine.user_id IS NOT NULL' : '(mine.user_id IS NOT NULL OR r.created_by=?)'}
    ORDER BY (r.due_at>=UTC_TIMESTAMP()) DESC,
      CASE WHEN r.due_at>=UTC_TIMESTAMP() THEN r.due_at END,
      r.due_at DESC,r.id DESC LIMIT ${mine ? 5 : 300}`,
    mine ? [req.user.id] : [req.user.id,req.user.id]);
  const sent = rows.filter(row => Number(row.createdBy)===Number(req.user.id)).map(row=>row.id);
  const recipients = sent.length ? await query(`SELECT rr.reminder_id reminderId,u.id,u.name
    FROM personal_reminder_recipients rr JOIN users u ON u.id=rr.user_id
    WHERE rr.reminder_id IN (${sent.map(()=>'?').join(',')}) ORDER BY u.name,u.id`, sent) : [];
  res.json(rows.map(row=>({...row,recipients:recipients.filter(recipient=>recipient.reminderId===row.id)})));
}));

router.post('/', validate(z.object({
  title:z.string().trim().min(2).max(180),
  message:z.string().trim().max(1000).default(''),
  dueAt:z.string().datetime(),
  recipientIds:z.array(z.number().int().positive()).min(1).max(50)
})), wrap(async (req,res) => {
  const {title,message,dueAt} = req.body;
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw fail(400,'Choose a future reminder time.');
  const ids = [...new Set(req.body.recipientIds)].sort((a,b)=>a-b);
  const id = await transaction(async connection => {
    const [users] = await connection.execute(`SELECT id FROM users WHERE active=1
      AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY id FOR UPDATE`, ids);
    if (users.length!==ids.length) throw fail(400,'One of the selected recipients is unavailable.');
    const [created] = await connection.execute(
      'INSERT INTO personal_reminders(created_by,title,message,due_at) VALUES (?,?,?,?)',
      [req.user.id,title,message,date.toISOString().slice(0,19).replace('T',' ')]
    );
    await connection.execute(`INSERT INTO personal_reminder_recipients(reminder_id,user_id)
      VALUES ${ids.map(()=>'(?,?)').join(',')}`,ids.flatMap(userId=>[created.insertId,userId]));
    await audit(connection,req.user.id,'CREATE','personal_reminder',created.insertId,null,{title,dueAt,recipientIds:ids},req.ip);
    return created.insertId;
  });
  publishTo([req.user.id,...ids],'data',{entity:'personal-reminders'});
  res.status(201).json({id});
}));
export default router;
