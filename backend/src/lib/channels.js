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

/**
 * Puts a phone number into the international form WhatsApp and Twilio require.
 *
 * Numbers are written down the way people say them here — "077 4412210", "0112 345678" —
 * and both providers expect the country code with no leading zero. Sending the local form
 * fails per message with a generic rejection, so the numbers already on file for every
 * employee would each have to be re-typed before anyone could be reached.
 *
 * The trunk prefix drops and the country code goes on. A number already carrying one, in
 * any of the ways people write it, is left as it is.
 */
export const toInternational = (value, countryCode = process.env.DEFAULT_COUNTRY_CODE || '94') => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  /* Already international: written with a + , or starting with the country code and long
     enough that the code cannot be the start of a local number. */
  if (String(value).trim().startsWith('+')) return digits;
  if (digits.startsWith(countryCode) && digits.length > 9) return digits;
  /* Local, with the trunk 0: swap it for the country code. */
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  return countryCode + digits;
};

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
        To: `+${toInternational(recipient)}`,
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
      /*
       * The endpoint is configurable rather than hardcoded. Meta's own Cloud API is the
       * default, but plenty of businesses here reach WhatsApp through a solution provider
       * that speaks the same shape on a different host — and a fixed URL would mean a code
       * change to point at one, or at a sandbox for testing.
       */
      const base = (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
      const response = await fetch(`${base}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: toInternational(recipient),
          type: 'text',
          text: { body: `*${notification.title}*\n\n${notification.message}` }
        })
      });
      if (!response.ok) {
        /* The status alone does not say whether the number was wrong, the template was
           rejected or the token expired — and that is exactly what the sender needs. */
        const detail = await response.text().catch(() => '');
        const reason = (() => {
          try { return JSON.parse(detail)?.error?.message; } catch { return null; }
        })();
        throw new Error(`WhatsApp API responded ${response.status}${reason ? `: ${reason}` : ''}`);
      }
    }
  }
};

/**
 * Sends one message to one address, chosen by a person rather than raised by the scanner.
 *
 * Deliberately not gated on NOTIFY_CHANNELS. That setting decides which channels automatic
 * alerts go out on; somebody who has opened the composer, picked recipients and pressed
 * send has already made that decision themselves, and silently doing nothing would be the
 * worst possible answer. Missing credentials still report as Skipped rather than Failed,
 * because nothing was attempted and nothing broke.
 */
export async function sendDirect(channel, recipient, notification) {
  const adapter = adapters[channel];
  if (!adapter) return { status: 'Failed', detail: `Unknown channel ${channel}` };
  if (!adapter.configured()) {
    return { status: 'Skipped', detail: `${channel} credentials are not configured on this server` };
  }
  try {
    await adapter.send({ recipient, notification });
    return { status: 'Sent', detail: null };
  } catch (error) {
    return { status: 'Failed', detail: String(error.message).slice(0, 500) };
  }
}

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
    const user = await getOne('SELECT name,email,whatsapp_phone FROM users WHERE id=? AND active=1', [notification.user_id]);
    return user ? [user] : [];
  }
  if (!notification.audience) return [];
  return query(`SELECT DISTINCT u.name,u.email,u.whatsapp_phone FROM users u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id AND rp.permission_key=?
    LEFT JOIN user_permissions up ON up.user_id=u.id AND up.permission_key=?
      AND up.effect='Grant' AND (up.expires_at IS NULL OR up.expires_at >= CURDATE())
    WHERE u.active=1 AND (rp.permission_key IS NOT NULL OR up.permission_key IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM user_permissions r WHERE r.user_id=u.id
        AND r.permission_key=? AND r.effect='Revoke'
        AND (r.expires_at IS NULL OR r.expires_at >= CURDATE()))`,
  [notification.audience, notification.audience, notification.audience]);
}

/*
 * Where to reach somebody on a given channel.
 *
 * The phone was only ever read from the employee record matched by email, so anyone with a
 * login and no payroll record — the MD, office staff — was unreachable on WhatsApp and
 * every message to them recorded as "No address on file". The account's own number is
 * used when there is one, and the employee record remains the fallback for site staff.
 */
const addressFor = (channel, user, employee) =>
  (channel === 'Email' ? user.email : user.whatsapp_phone || employee?.phone || null);

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
