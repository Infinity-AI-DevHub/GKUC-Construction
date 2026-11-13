import { withDeveloperCredit } from './developer-credit.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = key => key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase());
const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short'
});
const money = new Intl.NumberFormat('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lkr = value => 'LKR ' + money.format(value);
const empty = value => value === null || value === undefined || value === '';

function displayValue(value) {
  if (value instanceof Date) return escape(dateTime.format(value));
  if (Array.isArray(value)) return value.length
    ? '<ol>' + value.map(item => '<li>' + displayValue(item) + '</li>').join('') + '</ol>' : '—';
  if (value && typeof value === 'object') return fields(value);
  return escape(value);
}

function fields(row) {
  return '<dl>' + Object.entries(row).filter(([, value]) => !empty(value))
    .map(([key, value]) => `<div><dt>${escape(label(key))}</dt><dd>${displayValue(value)}</dd></div>`).join('') + '</dl>';
}

function renderRecord({ row, details }, index) {
  const { id, ...values } = row;
  const heading = row.reference || row.invoice_no || row.title || row.name || `Record ${index + 1}`;
  return `<article><h4>${escape(heading)}</h4>${fields(values)}
    ${details.map(({ label, items }) => `<h5>${escape(label)} · ${items.length}</h5>
      <ol class="lines">${items.map(item => `<li>${fields(item)}</li>`).join('')}</ol>`).join('')}</article>`;
}

function summarise(sections) {
  const registers = new Map(sections.flatMap(section => section.entries.map(entry => [entry.title, entry.records.map(record => record.row)])));
  const metrics = {};
  const tasks = registers.get('Tasks');
  const milestones = registers.get('Milestones');
  const reports = registers.get('Daily site reports');
  const attendance = registers.get('Attendance records');
  const invoices = registers.get('Client invoices')?.filter(row => !['Draft', 'Cancelled'].includes(row.status));
  if (tasks) metrics.tasks_completed = `${tasks.filter(row => ['Completed', 'Approved'].includes(row.status)).length} / ${tasks.length}`;
  if (milestones) metrics.milestones_completed = `${milestones.filter(row => row.status === 'Completed').length} / ${milestones.length}`;
  if (reports) {
    metrics.daily_site_reports = reports.length;
    metrics.recorded_delay_hours = reports.reduce((total, row) => total + Number(row.delay_hours || 0), 0);
  }
  if (attendance) {
    const worked = attendance.filter(row => ['On site', 'Late', 'Checked out', 'Business trip'].includes(row.state));
    metrics.attended_shifts = worked.length;
    metrics.distinct_worker_names = new Set(worked.map(row => row.employee_name)).size;
  }
  if (invoices) {
    metrics.issued_client_invoices = invoices.length;
    metrics.invoice_payable = lkr(invoices.reduce((total, row) => total + Number(row.net_payable || 0), 0));
    metrics.invoice_payments = lkr(invoices.reduce((total, row) => total + Number(row.paid_amount || 0), 0));
  }
  return metrics;
}

export function projectReportDocument({ project, sections, restricted, finance, preparedBy, generatedAt = new Date() }) {
  const summary = {
    client: project.client, site: project.site, manager: project.manager, stage: project.stage,
    health: project.health, site_status: project.site_status, overall_progress: `${project.progress}%`,
    start_date: project.start_date, target_completion: project.end_date, approved_budget: lkr(project.budget),
    ...summarise(sections)
  };
  if (finance) Object.assign(summary, {
    opening_cost: lkr(finance.opening_cost), ledger_expenses: lkr(finance.ledger_expenses),
    recorded_cost: lkr(finance.recorded_cost), recorded_income: lkr(finance.recorded_income),
    budget_remaining: lkr(Number(project.budget) - Number(finance.recorded_cost))
  });
  return withDeveloperCredit(`<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>Project report · ${escape(project.name)}</title>
  <style>
  @page { size:A4; margin:14mm 15mm 17mm; }
  * { box-sizing:border-box; }
  body { font:10pt/1.4 Arial,sans-serif; color:#162d44; margin:0; overflow-wrap:anywhere; }
  header { display:flex; align-items:center; gap:12px; border-bottom:2px solid #183454; padding-bottom:10px; }
  header img { width:42px; height:42px; object-fit:contain; }
  h1 { font-size:22pt; line-height:1.12; margin:16px 0 6px; }
  h2 { font-size:15pt; margin:20px 0 7px; border-bottom:1px solid #b6c6d7; padding-bottom:4px; }
  h3 { font-size:11pt; margin:13px 0 5px; }
  h4,h5 { margin:0 0 4px; font-size:10pt; }
  h5 { margin-top:8px; }
  h1,h2,h3,h4,h5 { break-after:avoid; }
  article { margin:0 0 7px; border-top:1px solid #d5dee7; padding:6px 0; }
  dl { margin:0; display:flex; flex-wrap:wrap; column-gap:18px; row-gap:2px; }
  dl > div { max-width:100%; }
  dt,dd { display:inline; margin:0; white-space:pre-wrap; }
  dt { font-weight:bold; }
  dt::after { content:': '; }
  dd ol { white-space:normal; }
  ol { margin:4px 0; padding-left:22px; }
  li { margin:2px 0; }
  .lines > li { border-bottom:1px solid #e4eaf0; padding:3px 0; }
  .summary { padding:12px; border:1px solid #b6c6d7; }
  .summary dl > div { flex:1 1 43%; }
  .muted { color:#475e74; }
  .section-index { columns:2; padding-left:21px; }
  .section-index li { break-inside:avoid; }
  .details { break-before:page; }
  </style></head><body>
  <header><img src="/brand/gkuc-mark-256.png" alt=""><div><strong>${escape(project.company)}</strong><br>Project report</div></header>
  <h1>${escape(project.name)}</h1>
  <p class="muted">Project #${escape(project.id)} · Generated ${displayValue(generatedAt)} · ${escape(preparedBy)}</p>
  <h2>Project summary</h2><div class="summary">${fields(summary)}</div>
  <h3>Report contents</h3>
  <ul class="section-index">${sections.map(({ title, entries }) =>
    `<li>${escape(title)} (${entries.reduce((count, entry) => count + entry.records.length, 0)})</li>`).join('')}</ul>
  ${restricted.length ? `<p class="muted">Sections restricted by your access permissions: ${restricted.map(escape).join(', ')}.</p>` : ''}
  <main class="details"><h2>Project details</h2>${fields(project)}
    ${sections.map(({ title, entries }) => `<section><h2>${escape(title)}</h2>${entries.map(({ title, records }) =>
      `<h3>${escape(title)} · ${records.length}</h3>${records.length ? records.map(renderRecord).join('') :
        '<p class="muted">No records on file.</p>'}`).join('')}</section>`).join('')}
  </main></body></html>`, { everyPage: true });
}
