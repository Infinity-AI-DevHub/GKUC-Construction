# Attendance OT and Late Deductions

## Confirmed Calculation Gaps

Previously, payroll only summed separately Approved overtime rows. Biometric attendance
could contain valid late checkout times but still produce zero OT because it never fed
those hours into the payroll engine. Late deductions also used the payroll period-end
policy for every day. Finally, advance recovery was capped before subtracting lateness,
which could consume money already deducted for lateness and overstate the recovered advance.

The user confirmed that attendance OT should be calculated automatically in the draft.

## Current Calculation

`backend/src/lib/attendance-payroll.js` resolves each employee's work date against the
effective policy for their payroll company. Payroll settings supply OT rates, shift times,
rounding, minimum OT and grace periods. The employee's daily salary supplies their late
deduction hourly rate; the separate monthly statutory salary basis is not used as earnings.
Salary also includes approved paid-leave days; see `PAYROLL_PAID_LEAVE.md` for reconciliation,
unpaid-leave exclusion. Statutory contributions apply only to Monthly runs and use the
full configured monthly basis without proration; Daily and Weekly runs have none.

For a 16:30 shift end, 15-minute unpaid evening grace and 15-minute rounding:

| Checkout | Payable evening OT |
| --- | --- |
| 16:45 | 0 |
| 16:59 | 0 |
| 17:00 | 0.25 hours |
| 17:15 | 0.50 hours |
| 17:30 | 0.75 hours |

Existing early-morning OT behavior is retained. Explicit policy values are respected;
historical policies are not silently rewritten. Ensure policy effective dates cover the
work dates being recalculated, rather than assuming a policy saved today applies earlier.

Late deduction is `max(0, minutes late - grace minutes) * (daily rate / paid hours) / 60`.
At daily rate LKR 3,200 and 8 paid hours, hourly rate is LKR 400. With a 07:30 start,
08:00 deducts zero, 08:01 deducts LKR 6.67, and 08:15 deducts LKR 100. Attendance status
need not literally be Late: a Checked out biometric record still uses its actual check-in.
Missing salary rates on deductible late attendance produce an actionable error rather
than silently producing zero deductions. Salary advance recovery is capped after lateness.

## Category and Review Rules

- Office employees use Office OT; Site labourers and Supervisors use their Site rates.
- Drivers use Driver Site OT only for attendance explicitly located at Site; otherwise
  Driver OT applies. Travel is never inferred from attendance.
- Custom employees use the central Custom Office/Site rate, according to an explicit
  attendance location or their Office/Site employee type when no location was supplied.
- Explicit non-Travel OT decisions replace automatic Office/Site OT for that day.
  Pending and Rejected decisions are not automatically bypassed and appear as warnings.
- Approved reviewed OT retains its reviewed hours, but a fresh draft uses the policy rate
  effective on its work date. The original source record/rate is not overwritten.
- Travel requires its separately reviewed source input. Recorded travel intervals,
  including pending claims, are removed from automatic Office/Site intervals before
  rounding, preventing duplicate payment. Missing travel intervals require review.
- Absent and leave days produce no automatic OT or lateness. Attendance flagged as
  needing review produces neither automatically; its warning remains visible.
- Duplicate approved OT and approved OT contradicting absent/leave attendance stop
  calculation for review instead of silently inflating payroll.

## Persistence and Production Rollout

New payslips save a dated calculation snapshot in `payslips.calculation_detail`. Payroll
detail displays OT hours, source, policy, rate and pay, plus arrivals, grace, charged
minutes and late deductions. Historical slips without a snapshot remain readable.

Attendance OT project costs have their own `Attendance OT` allocation source, separate
from ordinary salary allocations. Draft rebuild/delete removes and recreates these safely.
Generating a draft never fabricates Approved OT source records or mutates attendance.

Deploy backend and frontend together and restart the updated backend to apply the added
JSON column and allocation enum value. Take a verified backup first. Recalculate existing
Draft payroll to populate the corrected values and snapshots. Approved/Paid payroll is
not rewritten. No attendance/employee deletion or reimport is required.

## Verification

Tests cover all payroll categories, both Driver and Custom work types, optional locations,
same-name employees with distinct IDs, imported punches, quarter-hour boundaries,
date-specific policy changes, manual overrides, pending/rejected decisions, travel overlap,
unresolved punches, duplicate/contradictory OT, advance recovery, project allocations and
repeat draft runs. The supplied legacy All Report.xls is tested through actual import,
reimport and payroll generation in a disposable database with explicit test salary rates.
No production database or uploaded source workbook is modified by these tests.
