export const LETTER_TYPES = Object.freeze({
  probation: 'Probation confirmation',
  'one-year': 'One-year service'
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const dateText = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});

/** Calendar-month milestones, clamped for employees who started on the 29th-31st. */
export function letterMilestone(joinDate, type) {
  if (!LETTER_TYPES[type] || !/^\d{4}-\d{2}-\d{2}$/.test(String(joinDate))) return null;
  const [year, month, day] = joinDate.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return null;
  const targetMonth = month - 1 + (type === 'probation' ? 6 : 12);
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function letterDue(joinDate, type, asAt) {
  const milestone = letterMilestone(joinDate, type);
  return Boolean(milestone && milestone <= asAt);
}

export function letterReminderStage(milestone, asAt) {
  if (!milestone || !asAt) return null;
  const remaining = Math.round((Date.parse(`${milestone}T00:00:00Z`) - Date.parse(`${asAt}T00:00:00Z`)) / 86400000);
  if (remaining === 7) return 'upcoming';
  if (remaining === 0) return 'due';
  if (remaining < 0 && -remaining % 7 === 0) return 'overdue';
  return null;
}

/** Issued HTML is stored verbatim: later employee or company edits cannot alter a signed letter. */
export function employeeLetterHtml({ employee, company, type, milestone, issuedOn, signer, draft = false }) {
  const heading = LETTER_TYPES[type];
  if (!heading || !milestone) throw new Error('Choose a valid employee letter and employment start date.');
  const companyName = escape(company.name);
  const employeeName = escape(employee.name);
  const designation = escape(employee.designation || 'Employee');
  const body = type === 'probation'
    ? `<p>Dear ${employeeName},</p>
       <p>We are pleased to confirm your employment with ${companyName} following completion of your six-month probationary period on <strong>${dateText(milestone)}</strong>.</p>
       <p>You joined the company on ${dateText(employee.joinDate)} and your current designation is <strong>${designation}</strong>. Your employment continues in accordance with your employment agreement and applicable company policies.</p>
       <p>We thank you for your contribution and look forward to your continued service.</p>`
    : `<p>To whom it may concern,</p>
       <p>This is to certify that <strong>${employeeName}</strong> (employee ID ${escape(employee.code)}) joined ${companyName} on ${dateText(employee.joinDate)} and completed <strong>one year of service</strong> on ${dateText(milestone)}.</p>
       <p>The employee's current designation is <strong>${designation}</strong>. This letter is issued at the employee's request as a record of service.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(heading)} - ${employeeName}</title>
  <style>
    @page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#edf1f6;color:#17263b;font:15px/1.65 Arial,sans-serif}
    .bar{background:#092342;color:#fff;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;gap:20px}.bar button{border:0;border-radius:6px;background:#a71930;color:#fff;padding:10px 17px;font-weight:700;cursor:pointer}
    .paper{width:210mm;min-height:297mm;margin:24px auto;background:#fff;padding:24mm 21mm 20mm;box-shadow:0 10px 35px #152b4930}
    header{display:flex;justify-content:space-between;gap:22px;align-items:start;padding-bottom:19px;border-bottom:3px solid #a71930}
    .identity{display:flex;gap:13px;align-items:center}.identity img{width:55px;height:55px;object-fit:contain}.identity strong{display:block;font-size:20px;color:#102d54}.identity small{display:block;color:#536277;line-height:1.4}
    .meta{text-align:right;font-size:12px;color:#536277;max-width:195px}.meta b{display:block;color:#102d54;font-size:13px}
    main{padding-top:39px}h1{font-size:22px;line-height:1.25;color:#102d54;margin:0 0 8px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#a71930;margin:0 0 26px}
    .ref{font-size:13px;color:#536277;margin-bottom:24px}p{margin:0 0 20px}.signature{margin-top:64px;page-break-inside:avoid}.signature .line{border-top:1px solid #718198;width:235px;padding-top:8px;font-weight:700}.signature small{display:block;color:#536277}
    footer{border-top:1px solid #dce4ec;margin-top:55px;padding-top:12px;color:#65758a;font-size:11px}
    .draft{border:2px solid #a71930;color:#a71930;font-weight:800;text-align:center;letter-spacing:.16em;padding:9px;margin-bottom:22px}
    @media print{body{background:#fff}.bar{display:none}.paper{margin:0;box-shadow:none;min-height:297mm}}
  </style></head><body><div class="bar"><span>${draft ? 'Draft preview - not issued.' : 'Check this letter, then download its PDF.'}</span><button type="button">Download PDF</button></div>
  <article class="paper"><header><div class="identity"><img src="/brand/gkuc-mark-256.png" alt=""><div><strong>${companyName}</strong>
  <small>${escape(company.address || '').replaceAll('\n', '<br>')}</small></div></div><div class="meta"><b>${dateText(issuedOn)}</b>
  ${company.registrationNumber ? `Business Reg. No: ${escape(company.registrationNumber)}<br>` : ''}${company.telephone ? `Tel: ${escape(company.telephone)}` : ''}</div></header>
  <main>${draft ? '<div class="draft">DRAFT - NOT ISSUED</div>' : ''}<h1>${escape(heading)}</h1><h2>Human Resources</h2><div class="ref">Employee: ${employeeName} &nbsp;|&nbsp; ID: ${escape(employee.code)}</div>
  ${body}<div class="signature"><div class="line">${draft ? 'Authorised HR signatory' : escape(signer)}</div><small>Human Resources · ${companyName}</small></div></main>
  <footer>This letter is issued by ${companyName} and reflects the employee record at the time of issue.</footer></article></body></html>`;
}
