import { query, getOne, pool } from '../db.js';
import { robustZScore, benfordDeviation, roundness, similarity, median } from './statistics.js';
import { notify } from '../alerts.js';

/*
 * The detectors.
 *
 * Each one answers a question somebody would ask if they had time to read every record:
 * is this figure like the others of its kind, was this bought from the same person twice,
 * did whoever asked for this also approve it. None of them is clever on its own. Together
 * they cover the ways money actually leaves a construction company — which is rarely a
 * dramatic theft and usually a slow habit nobody was positioned to notice.
 *
 * Every finding carries the evidence it was based on, because a flag a reviewer cannot
 * check is a flag they will learn to dismiss.
 */

const settings = new Map();

export async function loadSettings(force) {
  if (settings.size && !force) return settings;
  settings.clear();
  for (const row of await query('SELECT setting_key,value FROM risk_settings')) {
    settings.set(row.setting_key, row.value);
  }
  return settings;
}

const setting = (key, fallback) => {
  const value = settings.get(key);
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
};

const money = value => `LKR ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;

/*
 * Findings are keyed so the same condition seen twice is one finding, not two. Without it
 * a sweep that runs nightly would report the same invoice every night until somebody
 * looked at it, and the list would become something people scroll past.
 */
async function raise(finding) {
  const fingerprint = `${finding.rule}:${finding.entity}:${finding.entityId}`;
  await query(
    `INSERT INTO risk_findings
       (rule,category,severity,entity,entity_id,project_id,subject_user_id,amount,title,detail,
        evidence_json,score,fingerprint)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       severity=VALUES(severity), detail=VALUES(detail), evidence_json=VALUES(evidence_json),
       score=VALUES(score), amount=VALUES(amount)`,
    [finding.rule, finding.category, finding.severity, finding.entity, String(finding.entityId),
      finding.projectId || null, finding.subjectUserId || null, finding.amount ?? null,
      finding.title.slice(0, 200), finding.detail.slice(0, 1200),
      finding.evidence ? JSON.stringify(finding.evidence) : null,
      Math.min(999, Math.round(finding.score || 0)), fingerprint]);
  return fingerprint;
}

/* ---------------------------------------------------------------------------
   MONEY: is this figure like the others of its kind?
   --------------------------------------------------------------------------- */

/**
 * An expense far outside what that kind of cost normally is on that project.
 *
 * Compared against its own category's history rather than a fixed ceiling, because
 * "unusual" for fuel and "unusual" for a subcontract are different numbers, and a fixed
 * ceiling is either so high it catches nothing or so low it catches everything.
 */
async function expenseOutliers(found) {
  const minimum = setting('outlier.minimum.history', 8);
  const sigma = setting('outlier.sigma', 3);

  const groups = await query(`
    SELECT source, project_id projectId, COUNT(*) n
      FROM expenses GROUP BY source, project_id HAVING n >= ?`, [String(minimum)]);

  for (const group of groups) {
    const rows = await query(
      `SELECT id, amount, description, expense_date expenseDate, created_by createdBy
         FROM expenses WHERE source=? AND project_id=? ORDER BY id DESC LIMIT 400`,
      [group.source, group.projectId]);
    const amounts = rows.map(row => Number(row.amount));

    /* Only recent entries are judged; the older ones are the yardstick. */
    for (const row of rows.slice(0, 60)) {
      const history = amounts.filter((_, index) => rows[index].id !== row.id);
      if (history.length < minimum) continue;
      const z = robustZScore(Number(row.amount), history);
      if (z === null || z < sigma) continue;

      const typical = median(history);
      /*
       * Is this a decimal point rather than a fraud?
       *
       * Tested by asking the question directly: if the point is moved one, two or three
       * places, does the figure become an ordinary one for this category? Comparing the
       * ratio against a round 10 or 100 does not work — a slip on 48,700 lands at 10.7
       * times the median, not 10 — and loosening the tolerance until that fits starts
       * calling genuine large costs typing mistakes.
       */
      const decimalSlip = [10, 100, 1000].find(factor => {
        const corrected = Number(row.amount) / factor;
        const z = robustZScore(corrected, history);
        return z !== null && Math.abs(z) < sigma;
      });

      found.push(await raise({
        rule: decimalSlip ? 'expense.decimal.slip' : 'expense.outlier',
        category: decimalSlip ? 'Error' : 'Fraud',
        severity: z > sigma * 3 ? 'Critical' : z > sigma * 1.5 ? 'High' : 'Medium',
        entity: 'expense', entityId: row.id, projectId: group.projectId,
        subjectUserId: row.createdBy, amount: row.amount,
        title: decimalSlip
          ? `${money(row.amount)} looks like a decimal point in the wrong place`
          : `Unusually large ${String(group.source).toLowerCase()} cost — ${money(row.amount)}`,
        detail: decimalSlip
          ? `This is almost exactly ${decimalSlip} times the usual ${String(group.source).toLowerCase()} `
            + `cost on this project (${money(typical)}). Check whether ${money(Number(row.amount) / decimalSlip)} was meant.`
          : `${money(row.amount)} against a usual ${money(typical)} for ${String(group.source).toLowerCase()} `
            + `on this project — ${z.toFixed(1)} times the normal spread. Worth seeing the invoice behind it.`,
        evidence: { amount: Number(row.amount), typical, deviations: Number(z.toFixed(2)),
          comparedWith: history.length, description: row.description },
        score: Math.min(100, 40 + z * 8)
      }));
    }
  }
}

/**
 * A person whose figures do not fall the way real figures fall.
 *
 * Never used against one entry. Applied to somebody's whole run of them, where a habit of
 * inventing numbers shows up as a digit distribution nothing natural produces.
 */
async function benfordByPerson(found) {
  const sample = setting('benford.minimum.sample', 60);
  const people = await query(`
    SELECT created_by userId, COUNT(*) n FROM expenses
     WHERE created_by IS NOT NULL GROUP BY created_by HAVING n >= ?`, [String(sample)]);

  for (const person of people) {
    const rows = await query('SELECT amount FROM expenses WHERE created_by=? ORDER BY id DESC LIMIT 800',
      [person.userId]);
    const result = benfordDeviation(rows.map(row => Number(row.amount)));
    if (!result?.suspicious) continue;
    const who = await getOne('SELECT name FROM users WHERE id=?', [person.userId]);

    found.push(await raise({
      rule: 'expense.benford', category: 'Fraud', severity: 'High',
      entity: 'user', entityId: person.userId, subjectUserId: person.userId,
      title: `The figures ${who?.name || 'this person'} enters do not fall like real figures`,
      detail: `Across ${result.sample} entries the leading digits are distributed in a way that `
        + `naturally occurring amounts are not (chi-squared ${result.chi.toFixed(0)}, where anything `
        + `above 20 is unusual). The digit ${result.worst.digit} appears `
        + `${(result.worst.excess * 100).toFixed(0)} percentage points more often than expected. `
        + `This is a pattern across many entries, not a judgement on any one of them — it is a reason `
        + `to sample their supporting documents, nothing more.`,
      evidence: { chi: Number(result.chi.toFixed(2)), sample: result.sample, worstDigit: result.worst.digit,
        observed: result.observed.map(one => Number((one * 100).toFixed(1))) },
      score: Math.min(100, 55 + result.chi / 4)
    }));
  }
}

/** Large amounts that are suspiciously round. Real invoices rarely end in three zeroes. */
async function roundAmounts(found) {
  const floor = setting('round.amount.floor', 100000);
  const rows = await query(`
    SELECT e.id, e.amount, e.description, e.project_id projectId, e.created_by createdBy, e.expense_date expenseDate
      FROM expenses e WHERE e.amount >= ? ORDER BY e.id DESC LIMIT 300`, [String(floor)]);

  for (const row of rows) {
    const level = roundness(row.amount);
    if (level < 3) continue;
    found.push(await raise({
      rule: 'expense.round', category: 'Fraud', severity: level >= 4 ? 'Medium' : 'Low',
      entity: 'expense', entityId: row.id, projectId: row.projectId,
      subjectUserId: row.createdBy, amount: row.amount,
      title: `A very round ${money(row.amount)}`,
      detail: `Genuine costs rarely land on an exact round figure — an invoice is usually `
        + `${money(487350)} rather than ${money(500000)}. One of these means nothing; several from `
        + `the same person or supplier is worth a look at the paperwork behind them.`,
      evidence: { amount: Number(row.amount), zeroes: level, description: row.description },
      score: 20 + level * 5
    }));
  }
}

/* ---------------------------------------------------------------------------
   PROCUREMENT: the ways buying goes wrong
   --------------------------------------------------------------------------- */

/**
 * Orders broken up to stay underneath the approval threshold.
 *
 * The classic way to spend money nobody signed off: three orders of 90,000 rather than one
 * of 270,000. Judged per supplier within a window, because that is the shape it takes.
 */
async function splitPurchases(found) {
  const threshold = setting('approval.threshold', 250000);
  const window = setting('split.window.days', 7);

  const clusters = await query(`
    SELECT o.supplier_id supplierId, s.name supplier, o.project_id projectId,
           MIN(o.order_date) firstDate, MAX(o.order_date) lastDate,
           COUNT(*) orders, SUM(o.total) total, GROUP_CONCAT(o.reference) refs,
           GROUP_CONCAT(o.id) ids, MAX(o.issued_by) issuedBy
      FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id
     WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 180 DAY)
     GROUP BY o.supplier_id, o.project_id, FLOOR(DATEDIFF(o.order_date, '2000-01-01') / ?)
    HAVING orders >= 2 AND total > ? AND MAX(o.total) < ?`,
  [String(window), String(threshold), String(threshold)]);

  for (const cluster of clusters) {
    found.push(await raise({
      rule: 'purchase.split', category: 'Fraud', severity: 'High',
      entity: 'supplier', entityId: `${cluster.supplierId}:${cluster.firstDate}`,
      projectId: cluster.projectId, subjectUserId: cluster.issuedBy, amount: cluster.total,
      title: `${cluster.orders} orders to ${cluster.supplier} totalling ${money(cluster.total)} — each below the approval limit`,
      detail: `Between ${cluster.firstDate} and ${cluster.lastDate}, ${cluster.orders} separate orders `
        + `were raised to one supplier on one project. Together they come to ${money(cluster.total)}, `
        + `above the ${money(threshold)} that needs sign-off; individually every one of them sits `
        + `underneath it. That may be how the work arrived, or it may be how the sign-off was avoided. `
        + `References: ${cluster.refs}.`,
      evidence: { orders: cluster.orders, total: Number(cluster.total), threshold,
        references: String(cluster.refs).split(','), from: cluster.firstDate, to: cluster.lastDate },
      score: Math.min(100, 60 + (Number(cluster.total) / threshold) * 10)
    }));
  }
}

/** The same invoice paid twice, under a slightly different number. */
async function duplicateInvoices(found) {
  const window = setting('duplicate.window.days', 30);
  const rows = await query(`
    SELECT a.id, a.invoice_no invoiceNo, a.amount, a.invoice_date invoiceDate,
           a.supplier_id supplierId, s.name supplier,
           b.id otherId, b.invoice_no otherNo, b.invoice_date otherDate
      FROM supplier_invoices a
      JOIN supplier_invoices b
        ON b.supplier_id=a.supplier_id AND b.id > a.id
       AND ABS(b.amount - a.amount) < 1
       AND ABS(DATEDIFF(b.invoice_date, a.invoice_date)) <= ?
      JOIN suppliers s ON s.id=a.supplier_id
     ORDER BY a.id DESC LIMIT 200`, [String(window)]);

  for (const row of rows) {
    const identical = row.invoiceNo === row.otherNo;
    found.push(await raise({
      rule: 'invoice.duplicate', category: identical ? 'Fraud' : 'Error',
      severity: identical ? 'Critical' : 'High',
      entity: 'supplier_invoice', entityId: row.otherId, amount: row.amount,
      title: `${row.supplier} billed ${money(row.amount)} twice`,
      detail: `Invoice ${row.otherNo} (${row.otherDate}) is for the same amount as ${row.invoiceNo} `
        + `(${row.invoiceDate}) from the same supplier`
        + (identical ? ' — and carries the same invoice number.' : ', within a few days.')
        + ' Check it is genuinely two deliveries and not one invoice entered twice.',
      evidence: { amount: Number(row.amount), first: row.invoiceNo, second: row.otherNo,
        firstDate: row.invoiceDate, secondDate: row.otherDate, sameNumber: identical },
      score: identical ? 95 : 70
    }));
  }
}

/** Paid more than was invoiced, or invoiced more than was ordered. */
async function paymentMismatches(found) {
  const overpaid = await query(`
    SELECT i.id, i.invoice_no invoiceNo, i.amount, i.paid_amount paidAmount, s.name supplier
      FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id
     WHERE i.paid_amount > i.amount + 1 LIMIT 100`);
  for (const row of overpaid) {
    found.push(await raise({
      rule: 'payment.overpaid', category: 'Fraud', severity: 'Critical',
      entity: 'supplier_invoice', entityId: row.id, amount: row.paidAmount,
      title: `${row.supplier} was paid ${money(Number(row.paidAmount) - Number(row.amount))} more than invoiced`,
      detail: `Invoice ${row.invoiceNo} is for ${money(row.amount)} but ${money(row.paidAmount)} has been `
        + `paid against it. Money has left the company that no invoice asks for.`,
      evidence: { invoiced: Number(row.amount), paid: Number(row.paidAmount),
        difference: Number(row.paidAmount) - Number(row.amount) },
      score: 98
    }));
  }

  const overBilled = await query(`
    SELECT i.id, i.invoice_no invoiceNo, i.amount, o.total orderTotal, o.reference, s.name supplier
      FROM supplier_invoices i
      JOIN purchase_orders o ON o.id=i.order_id
      JOIN suppliers s ON s.id=i.supplier_id
     WHERE i.amount > o.total * 1.1 LIMIT 100`);
  for (const row of overBilled) {
    const excess = Number(row.amount) - Number(row.orderTotal);
    found.push(await raise({
      rule: 'invoice.over.order', category: 'Fraud', severity: 'High',
      entity: 'supplier_invoice', entityId: row.id, amount: row.amount,
      title: `${row.supplier} invoiced ${money(excess)} above the order`,
      detail: `Invoice ${row.invoiceNo} is ${money(row.amount)} against order ${row.reference} of `
        + `${money(row.orderTotal)}. Either the order was varied without being updated, or the `
        + `invoice is for more than was agreed.`,
      evidence: { invoiced: Number(row.amount), ordered: Number(row.orderTotal), excess },
      score: Math.min(100, 60 + (excess / Number(row.orderTotal)) * 40)
    }));
  }
}

/** Somebody approving their own request. */
async function selfApproval(found) {
  const rows = await query(`
    SELECT r.id, r.reference, r.project_id projectId, u.name, r.requested_by userId
      FROM purchase_requests r JOIN users u ON u.id=r.requested_by
     WHERE r.decided_by = r.requested_by AND r.status='Approved' LIMIT 200`);
  for (const row of rows) {
    found.push(await raise({
      rule: 'approval.self', category: 'Control', severity: 'High',
      entity: 'purchase_request', entityId: row.id, projectId: row.projectId, subjectUserId: row.userId,
      title: `${row.name} approved their own purchase request`,
      detail: `Request ${row.reference} was raised and approved by the same person. Whether or not `
        + `anything is wrong with it, nobody independent has looked at it — which is the point of `
        + `the approval step.`,
      evidence: { reference: row.reference, person: row.name },
      score: 75
    }));
  }
}

/* ---------------------------------------------------------------------------
   PEOPLE: ghost workers and padded time
   --------------------------------------------------------------------------- */

/**
 * Attendance recorded against a name that is not on the employee register.
 *
 * The obvious ghost-worker check — one person on two sites at once — cannot happen here:
 * the attendance table has a unique key on the name and the day, so the database refuses it
 * outright. That is a better control than any detector, and it is already in place.
 *
 * What it does not stop is a name being added that belongs to nobody. A day's work booked
 * for "S. Kumara" who exists on no employee record is the shape ghost workers actually
 * take in a system with that key.
 */
async function unknownWorkers(found) {
  const rows = await query(`
    SELECT a.employee_name name, COUNT(*) days, MIN(a.id) id,
           MAX(a.project_id) projectId, GROUP_CONCAT(DISTINCT p.name) projects
      FROM attendance a
      JOIN projects p ON p.id=a.project_id
     WHERE a.work_date >= DATE_SUB(CURDATE(), INTERVAL 120 DAY)
       AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.name = a.employee_name)
     GROUP BY a.employee_name
     ORDER BY days DESC LIMIT 100`);

  for (const row of rows) {
    found.push(await raise({
      rule: 'attendance.unknown.person', category: 'Fraud',
      severity: row.days >= 5 ? 'Critical' : 'High',
      entity: 'attendance', entityId: row.name, projectId: row.projectId,
      title: `"${row.name}" has ${row.days} day${row.days === 1 ? '' : 's'} of attendance but is on no employee record`,
      detail: `Work has been booked against a name that does not appear in the employee register, on `
        + `${row.projects}. Either somebody was taken on without being entered — in which case they `
        + `have no contract, no rate and no record — or a day's pay is being drawn for a person who `
        + `does not exist.`,
      evidence: { name: row.name, days: row.days, projects: row.projects },
      score: Math.min(100, 60 + row.days * 6)
    }));
  }
}

/**
 * A day's attendance where everybody's times are identical.
 *
 * Real arrivals scatter across several minutes. A whole gang checked in at exactly the same
 * second was entered from a chair, not recorded at a gate.
 */
async function copiedAttendance(found) {
  const rows = await query(`
    SELECT a.project_id projectId, p.name project, a.work_date workDate, a.check_in checkIn,
           COUNT(*) people, MIN(a.id) id
      FROM attendance a JOIN projects p ON p.id=a.project_id
     WHERE a.check_in IS NOT NULL AND a.work_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
     GROUP BY a.project_id, a.work_date, a.check_in HAVING people >= 6 LIMIT 100`);
  for (const row of rows) {
    found.push(await raise({
      rule: 'attendance.identical', category: 'Error', severity: 'Medium',
      entity: 'attendance', entityId: `${row.projectId}:${row.workDate}:${row.checkIn}`,
      projectId: row.projectId,
      title: `${row.people} people all checked in at exactly ${row.checkIn} on ${row.project}`,
      detail: `Arrivals normally scatter over several minutes. ${row.people} identical times on `
        + `${row.workDate} suggests the day was filled in afterwards rather than recorded as people `
        + `arrived. That is not dishonest in itself, but it means the attendance record is somebody's `
        + `recollection rather than evidence.`,
      evidence: { project: row.project, date: row.workDate, time: row.checkIn, people: row.people },
      score: 45
    }));
  }
}

/** Overtime beyond what a person can plausibly work. */
async function excessiveOvertime(found) {
  const max = setting('overtime.daily.max', 6);
  const rows = await query(`
    SELECT o.id, o.hours, o.rate, o.work_date workDate, o.project_id projectId,
           e.name, o.employee_id employeeId
      FROM overtime_records o JOIN employees e ON e.id=o.employee_id
     WHERE o.hours > ? ORDER BY o.id DESC LIMIT 200`, [String(max)]);
  for (const row of rows) {
    found.push(await raise({
      rule: 'overtime.excessive', category: 'Fraud',
      severity: Number(row.hours) > max * 2 ? 'High' : 'Medium',
      entity: 'overtime', entityId: row.id, projectId: row.projectId, amount: Number(row.hours) * Number(row.rate),
      title: `${row.name} claimed ${row.hours} hours of overtime in one day`,
      detail: `On top of a normal day that is ${(8 + Number(row.hours)).toFixed(1)} hours worked. `
        + `Anything above ${max} hours of overtime is worth confirming against who was on site.`,
      evidence: { hours: Number(row.hours), rate: Number(row.rate), date: row.workDate },
      score: Math.min(100, 40 + (Number(row.hours) - max) * 10)
    }));
  }
}

/* ---------------------------------------------------------------------------
   STORES: material that does not add up
   --------------------------------------------------------------------------- */

/** More issued than was ever received. */
async function impossibleStock(found) {
  const rows = await query(`
    SELECT m.id, m.name, m.unit,
      COALESCE(SUM(CASE WHEN sm.movement_type IN ('Receipt','Return') THEN sm.quantity ELSE 0 END),0) inQty,
      COALESCE(SUM(CASE WHEN sm.movement_type IN ('Issue','Transfer') THEN sm.quantity ELSE 0 END),0) outQty
      FROM materials m LEFT JOIN stock_movements sm ON sm.material_id=m.id
     GROUP BY m.id HAVING outQty > inQty + 0.001 LIMIT 100`);
  for (const row of rows) {
    const gap = Number(row.outQty) - Number(row.inQty);
    found.push(await raise({
      rule: 'stock.impossible', category: 'Fraud', severity: 'High',
      entity: 'material', entityId: row.id,
      title: `More ${row.name} has left the store than ever arrived`,
      detail: `${Number(row.outQty).toLocaleString()} ${row.unit} issued against `
        + `${Number(row.inQty).toLocaleString()} ${row.unit} received — a gap of `
        + `${gap.toLocaleString()} ${row.unit}. Either receipts were never entered, or material `
        + `left without being bought.`,
      evidence: { received: Number(row.inQty), issued: Number(row.outQty), gap, unit: row.unit },
      score: 78
    }));
  }
}

/* ---------------------------------------------------------------------------
   CONTROL: the rules of the system itself
   --------------------------------------------------------------------------- */

/** Spend running well ahead of progress. */
async function budgetBurn(found) {
  const rows = await query(`
    SELECT p.id, p.name, p.budget, p.progress,
      (p.actual + COALESCE((SELECT SUM(x.amount) FROM expenses x WHERE x.project_id=p.id),0)) spent
      FROM projects p WHERE p.active=1 AND p.budget > 0 AND p.progress > 0`);
  for (const row of rows) {
    const used = Number(row.spent) / Number(row.budget) * 100;
    const gap = used - Number(row.progress);
    if (gap < 25) continue;
    found.push(await raise({
      rule: 'budget.ahead.of.progress', category: 'Control',
      severity: used > 100 ? 'Critical' : gap > 40 ? 'High' : 'Medium',
      entity: 'project', entityId: row.id, projectId: row.id, amount: row.spent,
      title: `${row.name} has spent ${used.toFixed(0)}% of budget for ${row.progress}% of the work`,
      detail: `${money(row.spent)} of a ${money(row.budget)} budget is committed, but the project is `
        + `recorded as ${row.progress}% complete. At this rate the finished cost would be around `
        + `${money(Number(row.spent) / Math.max(Number(row.progress), 1) * 100)}. Either the progress `
        + `figure is behind, or the project is losing money.`,
      evidence: { budget: Number(row.budget), spent: Number(row.spent),
        percentUsed: Number(used.toFixed(1)), progress: Number(row.progress) },
      score: Math.min(100, 40 + gap)
    }));
  }
}

/** Records created outside working hours. */
async function outOfHours(found) {
  const start = String(setting('workday.start', '06:00'));
  const end = String(setting('workday.end', '20:00'));
  const rows = await query(`
    SELECT a.id, a.user_id userId, u.name, a.action, a.entity, a.entity_id entityId, a.created_at createdAt
      FROM audit_logs a JOIN users u ON u.id=a.user_id
     WHERE a.action IN ('CREATE','UPDATE','APPROVE','SEND','PAY')
       AND (TIME(a.created_at) < ? OR TIME(a.created_at) > ?)
       AND a.created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)
     ORDER BY a.id DESC LIMIT 150`, [start, end]);

  /* Grouped per person: one late evening is life, a habit of them is a pattern. */
  const byPerson = new Map();
  for (const row of rows) {
    if (!byPerson.has(row.userId)) byPerson.set(row.userId, { name: row.name, rows: [] });
    byPerson.get(row.userId).rows.push(row);
  }
  for (const [userId, person] of byPerson) {
    if (person.rows.length < 5) continue;
    found.push(await raise({
      rule: 'activity.out.of.hours', category: 'Control', severity: 'Low',
      entity: 'user', entityId: userId, subjectUserId: userId,
      title: `${person.name} has changed records outside working hours ${person.rows.length} times`,
      detail: `Between ${end} and ${start}, over the last two months. Site work runs late and this is `
        + `often nothing at all — but records altered when nobody else is about are worth being aware `
        + `of, particularly where money is involved.`,
      evidence: { occasions: person.rows.length, window: `${end}–${start}`,
        latest: person.rows.slice(0, 5).map(one => ({ action: one.action, entity: one.entity, at: one.createdAt })) },
      score: 25 + Math.min(30, person.rows.length)
    }));
  }
}

/* ---------------------------------------------------------------------------
   INTEGRITY: the documents behind the figures
   --------------------------------------------------------------------------- */

/** The same file uploaded more than once under different names. */
async function duplicateUploads(found) {
  const rows = await query(`
    SELECT g.checksum, COUNT(*) copies, GROUP_CONCAT(g.filename) names, MIN(g.id) id
      FROM gallery_photos g WHERE g.checksum IS NOT NULL AND g.removed_at IS NULL
     GROUP BY g.checksum HAVING copies > 1 LIMIT 100`);
  for (const row of rows) {
    found.push(await raise({
      rule: 'upload.duplicate', category: 'Integrity', severity: 'Medium',
      entity: 'gallery_photo', entityId: row.id,
      title: `The same photograph has been filed ${row.copies} times`,
      detail: `Identical files, byte for byte, under different names: ${row.names}. On a site record `
        + `meant to show what was there on a given day, the same picture appearing twice is either `
        + `a slip or an attempt to make one day's evidence do for two.`,
      evidence: { copies: row.copies, names: String(row.names).split(','), checksum: row.checksum },
      score: 50
    }));
  }
}

/* ---------------------------------------------------------------------------
   The sweep
   --------------------------------------------------------------------------- */

const DETECTORS = [
  ['expense.outlier', expenseOutliers],
  ['expense.benford', benfordByPerson],
  ['expense.round', roundAmounts],
  ['purchase.split', splitPurchases],
  ['invoice.duplicate', duplicateInvoices],
  ['payment.mismatch', paymentMismatches],
  ['approval.self', selfApproval],
  ['attendance.unknown.person', unknownWorkers],
  ['attendance.identical', copiedAttendance],
  ['overtime.excessive', excessiveOvertime],
  ['stock.impossible', impossibleStock],
  ['budget.burn', budgetBurn],
  ['activity.out.of.hours', outOfHours],
  ['upload.duplicate', duplicateUploads]
];

/**
 * Runs every detector.
 *
 * One failing detector must not stop the rest: a rule that throws on odd data would
 * otherwise silently disable every rule after it, and the company would believe it was
 * being watched when it was not.
 */
export async function runIntegritySweep() {
  await loadSettings(true);
  const found = [];
  const failures = [];

  for (const [name, detector] of DETECTORS) {
    try {
      await detector(found);
    } catch (error) {
      failures.push({ rule: name, error: String(error.message).slice(0, 200) });
      console.error(`Integrity rule ${name} failed`, error);
    }
  }

  /* Anything critical is put in front of somebody rather than left in a list. */
  const critical = await query(
    "SELECT id,title,detail FROM risk_findings WHERE status='Open' AND severity='Critical' AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)");
  for (const finding of critical) {
    await notify({
      audience: 'admin.audit', severity: 'Critical',
      title: `Possible fraud or serious error — ${finding.title}`,
      message: finding.detail.slice(0, 500),
      referenceType: 'risk_finding', referenceId: finding.id
    }).catch(() => {});
  }

  return { raised: found.length, rules: DETECTORS.length, failures };
}

/** Started with the server, then on a timer. */
export function startIntegrityWatch(intervalMinutes = Number(process.env.INTEGRITY_INTERVAL_MINUTES || 180)) {
  const tick = () => runIntegritySweep().catch(error => console.error('Integrity sweep failed', error));
  setTimeout(tick, 20000);
  const timer = setInterval(tick, intervalMinutes * 60000);
  timer.unref();
  return timer;
}
