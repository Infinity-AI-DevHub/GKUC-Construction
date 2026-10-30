# Short attendance days

Daily salary starts at the configured daily rate for a worked day. Valid check-in and check-out times now reduce its basic earnings when normal-shift attendance is below the policy's paid hours per day. For example, LKR 1,600 for 8 paid hours and 2 normal hours attended earns LKR 400 before other payroll items.

Only time inside the normal shift counts toward basic hours, capped at paid hours per day. Earlier/later OT stays separate and does not replace missed normal hours. No lunch deduction is guessed: the system currently records no break punches, so elapsed normal-shift time is used. A 9-hour shift configured for 8 paid hours reaches a full day's basic pay after 8 elapsed normal-shift hours.

The existing late deduction is credited against the missing-hours value before reducing basic earnings, so the same time is not charged twice. Paid leave remains a full configured daily rate; EPF/ETF continue to use their configured monthly basis independently of attendance. Incomplete, reversed, overnight or review-marked punches do not invent a short-day deduction and require review; incomplete/invalid punches generate warnings. Correct these attendance records before approving payroll.

Per-day reductions are saved in calculation detail, shown in the payroll breakdown and Excel attendance sheet, and explained on the payslip PDF. Existing saved payroll is not changed automatically. Explicit draft regeneration applies corrected attendance; approved/paid payroll remains locked by the existing controls.
