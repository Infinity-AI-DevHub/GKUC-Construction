import { getOne, query } from '../db.js';

/**
 * PID 2.13 — multi-channel delivery. GKUC must supply their own provider accounts, so
 * each channel is a thin adapter chosen by environment variable. With nothing configured
 * the dispatcher records the intended delivery as "Skipped" rather than silently dropping
 * it, which keeps the notification history honest about what actually left the building.
 */

const enabled = channel => (process.env.NOTIFY_CHANNELS || '')
  .split(',').map(value => value.trim().toLowerCase()).includes(channel.toLowerCase());

/** Alerts below this severity stay in-app only; nobody wants an SMS about an FYI. */
const SEVERITY_ORDER = { Info: 0, Warning: 1, Critical: 2 };
const threshold = () => SEVERITY_ORDER[process.env.NOTIFY_MIN_SEVERITY || 'Warning'] ?? 1;

const adapters = {
  Email: {
    /* Only Resend is wired. SMTP would need its own adapter, so it must not report as
       configured — otherwise every message records as Failed instead of Skipped. */
    configured: () => Boolean(process.env.RESEND_API_KEY),
    provider: () => 'resend',
    async send({ recipient, notification }) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: process.env.NOTIFY_EMAIL_FROM || 'siteops@gkuc.lk',
          to: recipient,
          subject: notification.title,
          text: notification.message
        })
      });
      if (!response.ok) throw new Error(`Resend responded ${response.status}`);
    }
  },

  SMS: {
    configured: () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    provider: () => 'twilio',
    async send({ recipient, notification }) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const body = new URLSearchParams({
        To: recipient,
        From: process.env.TWILIO_SMS_FROM || '',
        Body: `${notification.title}\n\n${notification.message}`
      });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body
      });
      if (!response.ok) throw new Error(`Twilio responded ${response.status}`);
    }
  },

  WhatsApp: {
    configured: () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    provider: () => 'meta-cloud',
    async send({ recipient, notification }) {
      const response = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient.replace(/[^\d]/g, ''),
          type: 'text',
          text: { body: `*${notification.title}*\n\n${notification.message}` }
        })
      });
      if (!response.ok) throw new Error(`WhatsApp Cloud API responded ${response.status}`);
    }
  }
};

export const channelStatus = () => Object.entries(adapters).map(([channel, adapter]) => ({
  channel,
  enabled: enabled(channel),
  configured: adapter.configured(),
  provider: adapter.provider()
}));

/**
 * Who should hear about this alert: the named user, or everyone who holds the permission it
 * is addressed to — whether from their role or from a delegation the MD has made.
 */
async function recipientsFor(notification) {
  if (notification.user_id) {
    const user = await getOne('SELECT name,email FROM users WHERE id=? AND active=1', [notification.user_id]);
    return user ? [user] : [];
  }
  if (!notification.audience) return [];
  return query(`SELECT DISTINCT u.name,u.email FROM users u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id AND rp.permission_key=?
    LEFT JOIN user_permissions up ON up.user_id=u.id AND up.permission_key=?
      AND up.effect='Grant' AND (up.expires_at IS NULL OR up.expires_at >= CURDATE())
    WHERE u.active=1 AND (rp.permission_key IS NOT NULL OR up.permission_key IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM user_permissions r WHERE r.user_id=u.id
        AND r.permission_key=? AND r.effect='Revoke'
        AND (r.expires_at IS NULL OR r.expires_at >= CURDATE()))`,
  [notification.audience, notification.audience, notification.audience]);
}

const addressFor = (channel, user, employee) =>
  (channel === 'Email' ? user.email : employee?.phone || null);

/**
 * Sends one queued notification out over every enabled channel and records the outcome
 * per recipient, so "we alerted them" is always provable after the fact.
 */
export async function dispatch(notification) {
  if ((SEVERITY_ORDER[notification.severity] ?? 0) < threshold()) return 0;

  const users = await recipientsFor(notification);
  let sent = 0;

  for (const [channel, adapter] of Object.entries(adapters)) {
    if (!enabled(channel)) continue;
    for (const user of users) {
      const employee = channel === 'Email' ? null : await getOne('SELECT phone FROM employees WHERE email=?', [user.email]);
      const recipient = addressFor(channel, user, employee);
      if (!recipient) {
        await record(notification.id, channel, user.name, 'Skipped', adapter.provider(), 'No address on file');
        continue;
      }
      if (!adapter.configured()) {
        await record(notification.id, channel, recipient, 'Skipped', adapter.provider(), 'Provider credentials not configured');
        continue;
      }
      try {
        await adapter.send({ recipient, notification });
        await record(notification.id, channel, recipient, 'Sent', adapter.provider(), null);
        sent += 1;
      } catch (error) {
        await record(notification.id, channel, recipient, 'Failed', adapter.provider(), error.message.slice(0, 500));
      }
    }
  }

  if (sent) await query("UPDATE notifications SET status='Sent' WHERE id=? AND status='Queued'", [notification.id]);
  return sent;
}

const record = (notificationId, channel, recipient, status, provider, detail) =>
  query('INSERT INTO notification_deliveries (notification_id,channel,recipient,status,provider,detail) VALUES (?,?,?,?,?,?)',
    [notificationId, channel, String(recipient).slice(0, 190), status, provider, detail]);

/** Drains anything queued since the last pass. Called by the alert scheduler. */
export async function dispatchQueued(limit = 50) {
  const pending = await query(`SELECT n.* FROM notifications n
    WHERE n.status='Queued' AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id=n.id)
    ORDER BY n.id DESC LIMIT ?`, [String(limit)]);
  let total = 0;
  for (const notification of pending) total += await dispatch(notification);
  return total;
}
