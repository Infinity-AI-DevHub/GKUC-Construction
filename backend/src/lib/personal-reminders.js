import {transaction} from '../db.js';
import {publish} from './realtime.js';

export async function deliverDueReminders() {
  const deliveries = await transaction(async connection => {
    const [due] = await connection.execute(`SELECT rr.reminder_id,rr.user_id,r.title,r.message
      FROM personal_reminder_recipients rr JOIN personal_reminders r ON r.id=rr.reminder_id
      JOIN users u ON u.id=rr.user_id AND u.active=1
      WHERE rr.notified_at IS NULL AND r.due_at<=UTC_TIMESTAMP()
      ORDER BY r.due_at,rr.reminder_id,rr.user_id LIMIT 200 FOR UPDATE`);
    const saved = [];
    for (const row of due) {
      const [result] = await connection.execute(`INSERT IGNORE INTO notifications
        (user_id,channel,severity,title,message,status,reference_type,reference_id,dedupe_key)
        VALUES (?,'In-app','Info',?,?,'Delivered','personal_reminder',?,?)`,
        [row.user_id,row.title,row.message,String(row.reminder_id),`personal-reminder:${row.reminder_id}:${row.user_id}`]);
      await connection.execute(`UPDATE personal_reminder_recipients SET notified_at=UTC_TIMESTAMP()
        WHERE reminder_id=? AND user_id=?`, [row.reminder_id,row.user_id]);
      if (result.insertId) saved.push({...row,id:result.insertId});
    }
    return saved;
  });
  for (const row of deliveries) publish('notification', {
    id:row.id,title:row.title,message:row.message,severity:'Info',
    referenceType:'personal_reminder',referenceId:row.reminder_id,createdAt:new Date().toISOString()
  }, {userId:row.user_id});
  return deliveries.length;
}
