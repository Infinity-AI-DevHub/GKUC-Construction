import { test } from 'node:test';
import assert from 'node:assert/strict';
import { employeeLetterHtml, letterDue, letterMilestone, letterReminderStage } from '../src/lib/employee-letters.js';

test('six-month and one-year milestones use the real start date and clamp month ends', () => {
  assert.equal(letterMilestone('2026-01-31', 'probation'), '2026-07-31');
  assert.equal(letterMilestone('2024-02-29', 'one-year'), '2025-02-28');
  assert.equal(letterMilestone(null, 'probation'), null);
  assert.equal(letterDue('2026-01-31', 'probation', '2026-07-30'), false);
  assert.equal(letterDue('2026-01-31', 'probation', '2026-07-31'), true);
});

test('HR reminders occur before, on and weekly after an unissued milestone', () => {
  assert.equal(letterReminderStage('2026-07-31', '2026-07-24'), 'upcoming');
  assert.equal(letterReminderStage('2026-07-31', '2026-07-31'), 'due');
  assert.equal(letterReminderStage('2026-07-31', '2026-08-07'), 'overdue');
  assert.equal(letterReminderStage('2026-07-31', '2026-08-08'), null);
});

test('draft letters are visibly marked and employee/company text is escaped', () => {
  const html = employeeLetterHtml({ employee: { name: 'A <B>', code: 'EMP-1', designation: 'Engineer', joinDate: '2025-01-01' },
    company: { name: 'GKUC & Co', address: '', registrationNumber: 'BR-123' }, type: 'probation',
    milestone: '2025-07-01', issuedOn: '2025-07-01', signer: 'HR Officer', draft: true });
  assert.match(html, /DRAFT - NOT ISSUED/);
  assert.match(html, /A &lt;B&gt;/);
  assert.match(html, /GKUC &amp; Co/);
  assert.match(html, /Business Reg. No: BR-123/);
  assert.doesNotMatch(html, /<B>/);
  const issued = employeeLetterHtml({ employee: { name: 'A', code: 'EMP-1', designation: 'Engineer', joinDate: '2025-01-01' },
    company: { name: 'GKUC', address: '' }, type: 'one-year', milestone: '2026-01-01', issuedOn: '2026-01-02', signer: 'HR Officer' });
  assert.doesNotMatch(issued, /DRAFT - NOT ISSUED/);
  assert.match(issued, /one year of service/);
});
