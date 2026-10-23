# Paid and Unpaid Leave in Payroll

## Corrected Salary Rule

Earned salary is the employee's daily rate multiplied by the sum of unique worked days
and approved paid-leave days inside the payroll period. Approved unpaid leave contributes
zero salary. It is not deducted again from an already attendance-based salary.

Example: at LKR 1,600 per day, 20 worked days plus one approved paid-leave day and one
approved unpaid-leave day produce LKR 33,600 earned salary, not LKR 32,000. OT, allowances,
contributions, advances and other deductions are then calculated separately. Consequently,
the change in net pay need not equal LKR 1,600 when those deductions apply.

This behavior is shared by Daily, Weekly and Monthly payroll and every employee category.
Leave payment type is taken from `leave_requests.payment_type`, independently of the leave
category such as Annual or Casual. Only Approved requests affect salary; Pending and
Rejected requests do not. Full-day dates follow the existing inclusive-calendar-day leave
request model and are clipped to the payroll period and employment start date.

## Reconciliation and Safety

- A date can contribute salary only once. Duplicate same-payment leave dates are deduplicated.
- Approved Paid and Unpaid requests overlapping each other stop payroll for HR review.
- Approved leave conflicting with worked attendance also stops payroll. HR must correct
  the attendance or leave request; the system does not silently discard either source.
- An Absent or On leave attendance marker on an approved paid-leave day does not prevent
  that day being paid. Approved leave dates are not displayed as ordinary absence days.
- Leave does not generate automatic OT or lateness. Reviewed OT contradicting a leave
  date is rejected by payroll validation, including leave dates with no attendance row.
- A missing daily salary rate for paid leave produces an actionable error, not zero pay.
- Existing transport flags still determine whether leave/absence counts toward transport.
  Approved leave can count even without a separate attendance row, but never twice.
- Per-worked-day allowance rules remain based on worked days, not paid leave days.

The statutory contribution basis remains the separately configured monthly salary basis,
prorated over payable days (worked plus approved paid leave) and capped at that monthly
basis. OT and allowances do not become part of that statutory basis. Advance recovery is
recomputed from the resulting available net amount under the existing recovery rules.

Project attendance allocations retain only the actual daily salary for a worked day;
paid-leave pay is not distributed across the employee's attended project dates. Leave
salary remains in company payroll totals rather than being assigned to an invented site.

## UI and Historical Records

Payslips store worked days, paid-leave days, unpaid-leave days, payable days and the paid-
leave portion of earned salary. The payroll card and detailed table show these separately.
The dated calculation snapshot records the included leave dates, payment types and request
IDs. The work-date breakdown shows salary included for each approved leave day.

The leave form uses the policy effective on the selected leave start date. Waiting months
are no longer hard-coded to six. Paid leave is unavailable during the waiting period;
Unpaid is offered only if that policy allows it. Backend eligibility checks remain in force.
Annual, casual and monthly entitlement rules are unchanged.

The schema migration is additive: four payslip columns are added. Existing financial
amounts, attendance, employees and leave requests are not rewritten. Historical payable
days fall back to the recorded attended days; no historical paid leave is invented.

After a verified production backup, deploy the backend/frontend together and restart the
new backend to apply the migration. Recalculate existing Draft payroll to include approved
paid leave. Approved/Paid payroll stays locked and unchanged; historical payment corrections
require a separately reviewed adjustment, not automatic rewriting or attendance deletion.

## Verification

Pure tests cover the LKR 1,600 shortfall, pending/rejected requests, boundaries, duplicate
dates, conflicting attendance, OT/late exclusion and contribution proration. Isolated API
tests use actual leave create/approval endpoints for all three payroll frequencies, verify
the same draft gains LKR 1,600 after approval, check project allocation amounts, prove
failed rebuild rollback and confirm paid snapshots survive later leave-status changes.
Browser tests exercise the real leave form and payroll detail on desktop and mobile.
