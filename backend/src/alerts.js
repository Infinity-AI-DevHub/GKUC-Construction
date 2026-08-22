import { pool, query, spendSql, today } from './db.js';
import { dispatchQueued } from './lib/channels.js';

/**
 * Alerts are addressed to a *permission*, not a role name. With roles under the MD's
 * control (PID v3 §2.2), "whoever can manage transport" stays correct after a rename or a
 * reorganisation, where a hardcoded role name would quietly stop matching anybody.
 *
 * PID 2.13 — the Notification Center. Every deadline and threshold in the system is
 * converted into a proactive alert rather than something a person has to remember to check.
 *
 * Alerts are keyed by `dedupe_key` (which includes the day) so a condition raises exactly
 * one notification per day no matter how often the scan runs.
 */

export const ALERT_WINDOW_DAYS = Number(process.env.ALERT_WINDOW_DAYS || 30);

const raise = async alert => {
  await pool.execute(
    `INSERT IGNORE INTO notifications (user_id,audience,channel,severity,title,message,status,reference_type,reference_id,dedupe_key)
     VALUES (?,?,?,?,?,?,'Queued',?,?,?)`,
    [alert.userId || null, alert.audience || null, alert.channel || 'In-app', alert.severity || 'Info',
      alert.title, alert.message, alert.referenceType || null, String(alert.referenceId ?? ''), alert.key]
  );
};

const days = value => Math.ceil((new Date(value) - new Date(today())) / 86400000);
const money = value => `LKR ${Number(value).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;
/* Date columns arrive as Date objects, whose default string is "Thu Sep 10 2026 …" —
   readable enough for a machine, but not what belongs in a message to a person. */
const onDate = value => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

async function vehicleComplianceAlerts(stamp, alerts) {
  const rows = await query(`SELECT d.id,d.doc_type,d.expiry_date,f.vehicle,f.registration
    FROM vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id
    WHERE d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [ALERT_WINDOW_DAYS]);
  for (const row of rows) {
    const remaining = days(row.expiry_date);
    alerts.push({
      key: `vehicle-doc:${row.id}:${stamp}`,
      audience: 'transport.manage',
      severity: remaining < 0 ? 'Critical' : remaining <= 7 ? 'Critical' : 'Warning',
      title: `${row.doc_type} ${remaining < 0 ? 'expired' : 'expiring'} — ${row.registration}`,
      message: remaining < 0
        ? `${row.vehicle} (${row.registration}) ${row.doc_type.toLowerCase()} expired ${Math.abs(remaining)} day(s) ago. The vehicle should not be operated until renewed.`
        : `${row.vehicle} (${row.registration}) ${row.doc_type.toLowerCase()} expires in ${remaining} day(s). Renew before the due date.`,
      referenceType: 'vehicle_document',
      referenceId: row.id
    });
  }
}

async function lowStockAlerts(stamp, alerts) {
  const rows = await query('SELECT id,name,unit,stock,minimum,site FROM materials WHERE active=1 AND stock < minimum');
  for (const row of rows) {
    const critical = Number(row.stock) < Number(row.minimum) * 0.5;
    alerts.push({
      key: `material-low:${row.id}:${stamp}`,
      audience: 'store.manage',
      severity: critical ? 'Critical' : 'Warning',
      title: `${critical ? 'Critical' : 'Low'} stock — ${row.name}`,
      message: `${row.site} holds ${row.stock} ${row.unit} against a minimum of ${row.minimum} ${row.unit}. Raise a purchase request.`,
      referenceType: 'material',
      referenceId: row.id
    });
  }
}

async function budgetAlerts(stamp, alerts) {
  const rows = await query(`SELECT p.id,p.name,p.budget,${spendSql('p')} spent
    FROM projects p WHERE p.active=1 AND p.budget > 0`);
  for (const row of rows) {
    const used = (Number(row.spent) / Number(row.budget)) * 100;
    if (used < 85) continue;
    alerts.push({
      key: `budget:${row.id}:${stamp}`,
      audience: 'finance.view',
      severity: used >= 100 ? 'Critical' : 'Warning',
      title: `${used >= 100 ? 'Budget exceeded' : 'Budget warning'} — ${row.name}`,
      message: `Recorded cost is ${money(row.spent)} against an approved budget of ${money(row.budget)} (${used.toFixed(1)}% used).`,
      referenceType: 'project',
      referenceId: row.id
    });
  }
}

async function overdueTaskAlerts(stamp, alerts) {
  const rows = await query(`SELECT t.id,t.title,t.assignee,t.due_date,p.name project FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status NOT IN ('Completed','Approved') AND t.due_date IS NOT NULL AND t.due_date < CURDATE()`);
  for (const row of rows) {
    alerts.push({
      key: `task-overdue:${row.id}:${stamp}`,
      audience: 'projects.manage',
      severity: 'Warning',
      title: `Overdue task — ${row.title}`,
      message: `${row.assignee} was due to complete this on ${new Date(row.due_date).toISOString().slice(0, 10)} for ${row.project}. It is ${Math.abs(days(row.due_date))} day(s) overdue.`,
      referenceType: 'task',
      referenceId: row.id
    });
  }
}

async function milestoneAlerts(stamp, alerts) {
  const rows = await query(`SELECT m.id,m.title,m.due_date,p.name project FROM project_milestones m JOIN projects p ON p.id=m.project_id
    WHERE m.status NOT IN ('Completed') AND m.due_date <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)`);
  for (const row of rows) {
    const remaining = days(row.due_date);
    alerts.push({
      key: `milestone:${row.id}:${stamp}`,
      audience: 'projects.manage',
      severity: remaining < 0 ? 'Critical' : 'Info',
      title: `${remaining < 0 ? 'Milestone delayed' : 'Milestone approaching'} — ${row.title}`,
      message: `${row.project}: milestone due ${new Date(row.due_date).toISOString().slice(0, 10)} (${remaining < 0 ? `${Math.abs(remaining)} day(s) late` : `in ${remaining} day(s)`}).`,
      referenceType: 'milestone',
      referenceId: row.id
    });
  }
}

async function employeeDocumentAlerts(stamp, alerts) {
  const rows = await query(`SELECT a.id,a.title,a.expiry_date,e.name FROM attachments a JOIN employees e ON e.id=a.owner_id
    WHERE a.owner_type='employee' AND a.expiry_date IS NOT NULL
      AND a.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [ALERT_WINDOW_DAYS]);
  for (const row of rows) {
    const remaining = days(row.expiry_date);
    alerts.push({
      key: `employee-doc:${row.id}:${stamp}`,
      audience: 'hr.manage',
      severity: remaining < 0 ? 'Critical' : 'Warning',
      title: `${row.title} ${remaining < 0 ? 'expired' : 'expiring'} — ${row.name}`,
      message: `${row.name}: ${row.title} ${remaining < 0 ? `expired ${Math.abs(remaining)} day(s) ago` : `expires in ${remaining} day(s)`}.`,
      referenceType: 'employee_document',
      referenceId: row.id
    });
  }
}

async function invoiceAlerts(stamp, alerts) {
  const rows = await query(`SELECT i.id,i.invoice_no,i.amount,i.paid_amount,i.due_date,s.name supplier
    FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id
    WHERE i.status <> 'Paid' AND i.due_date IS NOT NULL AND i.due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
  for (const row of rows) {
    const remaining = days(row.due_date);
    alerts.push({
      key: `invoice:${row.id}:${stamp}`,
      audience: 'finance.view',
      severity: remaining < 0 ? 'Critical' : 'Warning',
      title: `${remaining < 0 ? 'Overdue' : 'Upcoming'} supplier payment — ${row.supplier}`,
      message: `Invoice ${row.invoice_no}: ${money(Number(row.amount) - Number(row.paid_amount))} outstanding, due ${new Date(row.due_date).toISOString().slice(0, 10)}.`,
      referenceType: 'supplier_invoice',
      referenceId: row.id
    });
  }
}

async function serviceScheduleAlerts(stamp, alerts) {
  const rows = await query(`SELECT id,vehicle,registration,odometer,service_interval_km,service_interval_months,
      last_service_date,last_service_odometer FROM fleet
    WHERE (service_interval_km > 0 OR service_interval_months > 0) AND status <> 'Inactive'`);
  for (const row of rows) {
    const kmRemaining = row.service_interval_km
      ? Number(row.last_service_odometer) + Number(row.service_interval_km) - Number(row.odometer) : null;
    let dateRemaining = null;
    if (row.service_interval_months && row.last_service_date) {
      const next = new Date(row.last_service_date);
      next.setMonth(next.getMonth() + Number(row.service_interval_months));
      dateRemaining = days(next.toISOString().slice(0, 10));
    }
    const dueByKm = kmRemaining !== null && kmRemaining <= 500;
    const dueByDate = dateRemaining !== null && dateRemaining <= 14;
    if (!dueByKm && !dueByDate) continue;
    const overdue = (kmRemaining !== null && kmRemaining <= 0) || (dateRemaining !== null && dateRemaining < 0);
    alerts.push({
      key: `service:${row.id}:${stamp}`,
      audience: 'transport.manage',
      severity: overdue ? 'Critical' : 'Warning',
      title: `Service ${overdue ? 'overdue' : 'due'} — ${row.registration}`,
      message: `${row.vehicle}: ${dueByKm ? `${Math.abs(kmRemaining)} km ${kmRemaining <= 0 ? 'past' : 'until'} the next service. ` : ''}` +
        `${dueByDate ? `Scheduled service ${dateRemaining < 0 ? `${Math.abs(dateRemaining)} day(s) overdue` : `in ${dateRemaining} day(s)`}.` : ''}`.trim(),
      referenceType: 'fleet',
      referenceId: row.id
    });
  }
}

/** PID v3 problem 6 — retention is easy to lose track of across a long project. */
async function retentionAlerts(stamp, alerts) {
  const rows = await query(`SELECT r.id,r.description,r.amount,r.released_amount,r.release_date,p.name project
    FROM retentions r JOIN projects p ON p.id=r.project_id
    WHERE r.status IN ('Held','Partially released')
      AND r.release_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)`);
  for (const row of rows) {
    const remaining = days(row.release_date);
    alerts.push({
      key: `retention:${row.id}:${stamp}`,
      audience: 'qs.retention',
      severity: remaining < 0 ? 'Critical' : 'Warning',
      title: `Retention ${remaining < 0 ? 'overdue for release' : 'release approaching'} — ${row.project}`,
      message: `${row.description}: ${money(Number(row.amount) - Number(row.released_amount))} still held, due ` +
        `${remaining < 0 ? `${Math.abs(remaining)} day(s) ago` : `in ${remaining} day(s)`}.`,
      referenceType: 'retention',
      referenceId: row.id
    });
  }
}

/** A tender closing date is worth nothing if it passes unnoticed. */
/*
 * A tender has four separate clocks, and missing any one of them costs the bid.
 *
 * The document is only on sale between two dates; bids close at an hour on a day; the bid
 * security has an expiry of its own, and an expired guarantee makes an otherwise sound bid
 * non-responsive; and our own offer only stands for the validity period, after which the
 * employer can no longer accept it without asking us to extend.
 */
async function tenderAlerts(stamp, alerts) {
  const live = "t.status IN ('Identified','Document purchased','Preparing')";

  /* The document is on sale for a fortnight or so, and cannot be bought late. */
  const buying = await query(`SELECT t.id,t.reference,t.title,t.client,t.docs_until,t.document_fee
    FROM tenders t WHERE ${live} AND t.purchased_date IS NULL AND t.docs_until IS NOT NULL
      AND t.docs_until <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)`);
  for (const row of buying) {
    const remaining = days(row.docs_until);
    alerts.push({
      key: `tender-docs:${row.id}:${stamp}`,
      audience: 'qs.tender',
      severity: remaining <= 2 ? 'Critical' : 'Warning',
      title: remaining < 0
        ? `Bidding document no longer on sale — ${row.reference}`
        : `Last day to buy the bidding document in ${remaining} day(s) — ${row.reference}`,
      message: `${row.title} (${row.client}). The document is on sale until ${onDate(row.docs_until)}`
        + `${Number(row.document_fee) > 0 ? ` for ${money(row.document_fee)}` : ''}. It cannot be bought after that.`,
      referenceType: 'tender',
      referenceId: row.id
    });
  }

  /* Closing day, with the hour, and with the paperwork that is still missing. */
  const closing = await query(`SELECT t.id,t.reference,t.title,t.client,t.closing_date,t.closing_time,
      (SELECT COUNT(*) FROM tender_checklist c WHERE c.tender_id=t.id AND c.mandatory=1 AND c.done=0) outstanding
    FROM tenders t WHERE ${live} AND t.closing_date <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)`);
  for (const row of closing) {
    const remaining = days(row.closing_date);
    const at = String(row.closing_time || '').slice(0, 5);
    alerts.push({
      key: `tender:${row.id}:${stamp}`,
      audience: 'qs.tender',
      severity: remaining <= 3 ? 'Critical' : 'Warning',
      title: `Tender ${remaining < 0 ? 'closed' : 'closing'} — ${row.client}`,
      message: `${row.reference} ${row.title}: ${remaining < 0
        ? `closed ${Math.abs(remaining)} day(s) ago`
        : `closes in ${remaining} day(s)${at ? ` at ${at}` : ''}`}.`
        + `${Number(row.outstanding) > 0 ? ` ${row.outstanding} required document(s) still outstanding.` : ' All required documents are ready.'}`,
      referenceType: 'tender',
      referenceId: row.id
    });
  }

  /* A bid security that lapses before the award is decided has to be extended. */
  const security = await query(`SELECT t.id,t.reference,t.title,t.security_valid_until,t.security_amount
    FROM tenders t WHERE t.status IN ('Submitted','Opened') AND t.security_released_on IS NULL
      AND t.security_valid_until IS NOT NULL
      AND t.security_valid_until <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [ALERT_WINDOW_DAYS]);
  for (const row of security) {
    const remaining = days(row.security_valid_until);
    alerts.push({
      key: `tender-security:${row.id}:${stamp}`,
      audience: 'qs.tender',
      severity: remaining <= 7 ? 'Critical' : 'Warning',
      title: `Bid security ${remaining < 0 ? 'has expired' : `expires in ${remaining} day(s)`} — ${row.reference}`,
      message: `${row.title}: the ${money(row.security_amount)} security is valid until `
        + `${onDate(row.security_valid_until)}. Extend it or ask for its release.`,
      referenceType: 'tender',
      referenceId: row.id
    });
  }

  /* Our own offer expires too, after which the employer cannot simply accept it. */
  const validity = await query(`SELECT t.id,t.reference,t.title,t.validity_days,
      DATE_ADD(t.closing_date, INTERVAL t.validity_days DAY) expires
    FROM tenders t WHERE t.status IN ('Submitted','Opened')
      AND DATE_ADD(t.closing_date, INTERVAL t.validity_days DAY) <= DATE_ADD(CURDATE(), INTERVAL 14 DAY)`);
  for (const row of validity) {
    const remaining = days(row.expires);
    alerts.push({
      key: `tender-validity:${row.id}:${stamp}`,
      audience: 'qs.tender',
      severity: remaining < 0 ? 'Warning' : 'Info',
      title: `Bid validity ${remaining < 0 ? 'has lapsed' : `ends in ${remaining} day(s)`} — ${row.reference}`,
      message: `${row.title}: the ${row.validity_days}-day validity runs to ${onDate(row.expires)}. `
        + 'Chase the outcome, or agree an extension with the employer.',
      referenceType: 'tender',
      referenceId: row.id
    });
  }
}

async function pendingApprovalAlerts(stamp, alerts) {
  const [requests] = await Promise.all([query("SELECT COUNT(*) count FROM purchase_requests WHERE status='Pending'")]);
  const pending = requests[0].count;
  if (!pending) return;
  alerts.push({
    key: `purchase-pending:${stamp}`,
    audience: 'projects.manage',
    severity: 'Info',
    title: `${pending} purchase request(s) awaiting approval`,
    message: 'Purchase requests are held until management approves them. Review them so site work is not delayed.',
    referenceType: 'purchase_request',
    referenceId: 0
  });
}

/** Scans every tracked deadline and threshold and queues notifications for anything at risk. */
export async function runAlertScan() {
  const stamp = today();
  const alerts = [];
  await Promise.all([
    vehicleComplianceAlerts(stamp, alerts),
    lowStockAlerts(stamp, alerts),
    budgetAlerts(stamp, alerts),
    overdueTaskAlerts(stamp, alerts),
    milestoneAlerts(stamp, alerts),
    employeeDocumentAlerts(stamp, alerts),
    invoiceAlerts(stamp, alerts),
    serviceScheduleAlerts(stamp, alerts),
    retentionAlerts(stamp, alerts),
    tenderAlerts(stamp, alerts),
    pendingApprovalAlerts(stamp, alerts)
  ]);
  for (const alert of alerts) await raise(alert);
  await dispatchQueued().catch(error => console.error('Channel dispatch failed', error));
  return alerts.length;
}

/** Queues a one-off notification raised by an operator action rather than by the scanner. */
export async function notify(alert) {
  await raise({ ...alert, key: alert.key || `event:${alert.referenceType}:${alert.referenceId}:${Date.now()}` });
}

/** Background scanning so alerts fire even when nobody is signed in. */
export function startAlertScheduler(intervalMinutes = Number(process.env.ALERT_INTERVAL_MINUTES || 60)) {
  const tick = () => runAlertScan().catch(error => console.error('Alert scan failed', error));
  tick();
  const timer = setInterval(tick, intervalMinutes * 60000);
  timer.unref();
  return timer;
}
