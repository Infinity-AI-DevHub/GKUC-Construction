import { pool, query, today } from './db.js';

/**
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

async function vehicleComplianceAlerts(stamp, alerts) {
  const rows = await query(`SELECT d.id,d.doc_type,d.expiry_date,f.vehicle,f.registration
    FROM vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id
    WHERE d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [ALERT_WINDOW_DAYS]);
  for (const row of rows) {
    const remaining = days(row.expiry_date);
    alerts.push({
      key: `vehicle-doc:${row.id}:${stamp}`,
      audience: 'Transport Officer',
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
      audience: 'Storekeeper',
      severity: critical ? 'Critical' : 'Warning',
      title: `${critical ? 'Critical' : 'Low'} stock — ${row.name}`,
      message: `${row.site} holds ${row.stock} ${row.unit} against a minimum of ${row.minimum} ${row.unit}. Raise a purchase request.`,
      referenceType: 'material',
      referenceId: row.id
    });
  }
}

async function budgetAlerts(stamp, alerts) {
  const rows = await query(`SELECT p.id,p.name,p.budget,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.project_id=p.id),0) + p.actual spent
    FROM projects p WHERE p.active=1 AND p.budget > 0`);
  for (const row of rows) {
    const used = (Number(row.spent) / Number(row.budget)) * 100;
    if (used < 85) continue;
    alerts.push({
      key: `budget:${row.id}:${stamp}`,
      audience: 'Finance / Accounts',
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
      audience: 'Project Manager',
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
      audience: 'Project Manager',
      severity: remaining < 0 ? 'Critical' : 'Info',
      title: `${remaining < 0 ? 'Milestone delayed' : 'Milestone approaching'} — ${row.title}`,
      message: `${row.project}: milestone due ${new Date(row.due_date).toISOString().slice(0, 10)} (${remaining < 0 ? `${Math.abs(remaining)} day(s) late` : `in ${remaining} day(s)`}).`,
      referenceType: 'milestone',
      referenceId: row.id
    });
  }
}

async function employeeDocumentAlerts(stamp, alerts) {
  const rows = await query(`SELECT d.id,d.title,d.expiry_date,e.name FROM employee_documents d JOIN employees e ON e.id=d.employee_id
    WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [ALERT_WINDOW_DAYS]);
  for (const row of rows) {
    const remaining = days(row.expiry_date);
    alerts.push({
      key: `employee-doc:${row.id}:${stamp}`,
      audience: 'HR',
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
      audience: 'Finance / Accounts',
      severity: remaining < 0 ? 'Critical' : 'Warning',
      title: `${remaining < 0 ? 'Overdue' : 'Upcoming'} supplier payment — ${row.supplier}`,
      message: `Invoice ${row.invoice_no}: ${money(Number(row.amount) - Number(row.paid_amount))} outstanding, due ${new Date(row.due_date).toISOString().slice(0, 10)}.`,
      referenceType: 'supplier_invoice',
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
    audience: 'Project Manager',
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
    pendingApprovalAlerts(stamp, alerts)
  ]);
  for (const alert of alerts) await raise(alert);
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
