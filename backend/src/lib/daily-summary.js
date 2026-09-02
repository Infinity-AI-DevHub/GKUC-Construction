import { query, getOne } from '../db.js';
import { sendDirect } from './channels.js';
import { notify } from '../alerts.js';

/*
 * The evening summary.
 *
 * One message at the end of the day saying what happened and what needs the MD tomorrow.
 * The point is not to reproduce the dashboard on a phone — somebody reading this is
 * standing in a car park, not sitting down to review. So it answers three questions and
 * stops: did the work move, is there money to chase, and is anything about to go wrong.
 *
 * It is deliberately sent even when the day was quiet. A summary that only arrives when
 * there is bad news becomes a summary nobody trusts the absence of.
 */

const money = value => {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 1000000) return `LKR ${(amount / 1000000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1000) return `LKR ${Math.round(amount / 1000)}k`;
  return `LKR ${Math.round(amount)}`;
};

const line = (label, value) => `${label}: ${value}`;

/** Gathers the day. Read-only, so it can be previewed as often as anybody likes. */
export async function buildSummary() {
  const [
    attendance, tasks, reports, expenses, receipts, overdue, alerts, bonds, tools, findings, projects
  ] = await Promise.all([
    getOne(`SELECT COUNT(*) onSite FROM attendance WHERE work_date=CURDATE() AND state IN ('On site','Late')`),
    getOne(`SELECT
        SUM(status='Completed' AND DATE(updated_at)=CURDATE()) doneToday,
        SUM(status NOT IN ('Completed','Approved') AND due < CURDATE()) overdue,
        SUM(status NOT IN ('Completed','Approved')) open
      FROM tasks`),
    getOne(`SELECT COUNT(*) filed FROM daily_reports WHERE report_date=CURDATE()`).catch(() => ({ filed: 0 })),
    getOne(`SELECT COALESCE(SUM(amount),0) spent FROM expenses WHERE expense_date=CURDATE()`),
    getOne(`SELECT COALESCE(SUM(amount),0) received FROM incomes WHERE received_date=CURDATE()`),
    getOne(`SELECT COALESCE(SUM(net_payable-paid_amount),0) outstanding,
                   COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN net_payable-paid_amount ELSE 0 END),0) late
              FROM client_invoices WHERE status IN ('Issued','Part paid')`).catch(() => ({ outstanding: 0, late: 0 })),
    getOne(`SELECT SUM(severity='Critical') critical, SUM(severity='Warning') warning
              FROM notifications WHERE status<>'Read' AND DATE(created_at)=CURDATE()`),
    getOne(`SELECT COUNT(*) expiring FROM bank_bonds
             WHERE status='Live' AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)`).catch(() => ({ expiring: 0 })),
    getOne(`SELECT COUNT(*) out FROM equipment_assignments
             WHERE returned_at IS NULL AND due_back IS NOT NULL AND due_back < CURDATE()`).catch(() => ({ out: 0 })),
    getOne(`SELECT COUNT(*) open FROM risk_findings WHERE status='Open' AND severity IN ('Critical','High')`)
      .catch(() => ({ open: 0 })),
    query(`SELECT name, progress FROM projects WHERE active=1 AND site_status='Active' ORDER BY progress DESC LIMIT 4`)
  ]);

  return {
    date: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
    onSite: Number(attendance?.onSite || 0),
    tasksDone: Number(tasks?.doneToday || 0),
    tasksOverdue: Number(tasks?.overdue || 0),
    tasksOpen: Number(tasks?.open || 0),
    reportsFiled: Number(reports?.filed || 0),
    spent: Number(expenses?.spent || 0),
    received: Number(receipts?.received || 0),
    outstanding: Number(overdue?.outstanding || 0),
    lateMoney: Number(overdue?.late || 0),
    critical: Number(alerts?.critical || 0),
    warnings: Number(alerts?.warning || 0),
    bondsExpiring: Number(bonds?.expiring || 0),
    toolsOut: Number(tools?.out || 0),
    riskFindings: Number(findings?.open || 0),
    projects: projects || []
  };
}

/**
 * The message itself.
 *
 * Written to be read on a phone in a few seconds: short lines, no table, the number first
 * where the number is the point. WhatsApp's own emphasis marks are used sparingly — one
 * bold heading, because a wall of bold reads as shouting.
 */
export function formatSummary(summary, companyName = 'GKUC') {
  const parts = [`*${companyName} — ${summary.date}*`, ''];

  parts.push('_Site_');
  parts.push(line('On site today', `${summary.onSite}`));
  parts.push(line('Daily reports filed', `${summary.reportsFiled}`));
  parts.push(line('Tasks finished today', `${summary.tasksDone}`));
  if (summary.tasksOverdue) parts.push(line('Tasks overdue', `${summary.tasksOverdue}`));

  parts.push('', '_Money_');
  parts.push(line('Spent today', money(summary.spent)));
  parts.push(line('Received today', money(summary.received)));
  if (summary.outstanding) {
    parts.push(line('Owed by clients', money(summary.outstanding)
      + (summary.lateMoney ? ` (${money(summary.lateMoney)} overdue)` : '')));
  }

  /* Only listed when there is something to act on, so its presence means something. */
  const attention = [];
  if (summary.critical) attention.push(`${summary.critical} critical alert${summary.critical === 1 ? '' : 's'}`);
  if (summary.riskFindings) attention.push(`${summary.riskFindings} fraud/error finding${summary.riskFindings === 1 ? '' : 's'}`);
  if (summary.bondsExpiring) attention.push(`${summary.bondsExpiring} bond${summary.bondsExpiring === 1 ? '' : 's'} expiring within a month`);
  if (summary.toolsOut) attention.push(`${summary.toolsOut} tool${summary.toolsOut === 1 ? '' : 's'} not returned`);

  if (attention.length) {
    parts.push('', '_Needs you_');
    for (const one of attention) parts.push(`• ${one}`);
  } else {
    parts.push('', 'Nothing outstanding needs you tonight.');
  }

  if (summary.projects.length) {
    parts.push('', '_Progress_');
    for (const project of summary.projects) parts.push(`${project.name} — ${project.progress}%`);
  }

  return parts.join('\n');
}

/**
 * Sends it.
 *
 * Goes to everybody holding the permission rather than to one hardcoded person: the MD is
 * who this is for today, and a system that names them in code is one that stops working
 * the day somebody else needs it too.
 */
export async function sendDailySummary({ dryRun = false } = {}) {
  const summary = await buildSummary();
  const company = await getOne('SELECT name FROM company_settings LIMIT 1').catch(() => null);
  const text = formatSummary(summary, company?.name || 'GKUC');
  if (dryRun) return { text, summary, sent: [] };

  const recipients = await query(`
    SELECT DISTINCT u.id, u.name, u.whatsapp_phone phone
      FROM users u
      LEFT JOIN role_permissions rp ON rp.role_id=u.role_id AND rp.permission_key='reports.daily-summary'
      LEFT JOIN user_permissions up ON up.user_id=u.id AND up.permission_key='reports.daily-summary'
        AND up.effect='Grant' AND (up.expires_at IS NULL OR up.expires_at >= CURDATE())
     WHERE u.active=1 AND (rp.permission_key IS NOT NULL OR up.permission_key IS NOT NULL)`);

  const sent = [];
  for (const person of recipients) {
    /* In-app regardless, so the summary exists in the record even with no phone on file. */
    await notify({
      userId: person.id, severity: 'Info',
      title: `Evening summary — ${summary.date}`,
      message: text,
      referenceType: 'daily_summary', referenceId: new Date().toISOString().slice(0, 10)
    }).catch(() => {});

    if (!person.phone) { sent.push({ name: person.name, status: 'No WhatsApp number on file' }); continue; }
    const outcome = await sendDirect('WhatsApp', person.phone, { title: '', message: text });
    sent.push({ name: person.name, status: outcome.status, detail: outcome.detail });
  }
  return { text, summary, sent };
}

/**
 * Runs it once a day, at the hour the company chooses.
 *
 * Checked every quarter of an hour rather than scheduled once, because a process that has
 * been restarted at any point during the day would otherwise have missed its slot and said
 * nothing until tomorrow.
 */
let lastSentOn = null;
export function startDailySummary() {
  const tick = async () => {
    try {
      const hour = Number(process.env.DAILY_SUMMARY_HOUR ?? 18);
      if (Number.isNaN(hour) || hour < 0) return;
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (lastSentOn === today) return;
      if (now.getHours() < hour) return;
      lastSentOn = today;
      const result = await sendDailySummary();
      console.log(`Evening summary sent to ${result.sent.length} recipient(s)`);
    } catch (error) {
      console.error('Evening summary failed', error);
    }
  };
  const timer = setInterval(tick, 15 * 60000);
  timer.unref();
  setTimeout(tick, 30000);
  return timer;
}
