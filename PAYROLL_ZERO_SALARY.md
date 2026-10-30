# Payroll zero salary review

Both-company generation still calculates separate company drafts atomically and only includes the chosen payment frequency. This change does not replace salaries with the EPF/ETF basis or infer rates.

Legacy attendance without employee IDs now matches a unique name after Unicode normalization, whitespace normalization and case folding. Explicit employee IDs remain authoritative; ambiguous names are never guessed. Uniqueness checks include employees outside the chosen company/frequency and inactive records so another person's attendance cannot be assigned accidentally.

If worked or approved paid-leave days exist but the daily salary rate is zero, generation fails with the employee name and corrective action. In batch mode the entire transaction rolls back, including any first-company regeneration. Set the confirmed daily rate and regenerate the draft. Employees with no worked days or approved paid leave may still legitimately have zero salary: the saved calculation now states why. Zero take-home due to deductions and advance recovery is distinguished from zero basic earnings.

New batch responses include zero-amount employees and their saved reasons. The interface displays a review warning on batch completion and displays the worked/paid-leave days, saved rate and reasons on zero-salary payslip cards. Older snapshots use only their saved inputs; this does not invent historical settings or recalculate them on viewing. Existing draft recalculation applies corrected inputs, while approved/paid runs remain locked.

Verification includes both-company legacy name matching, missing-rate rollback, corrected-rate regeneration, existing batch rebuilding and approved-run locking. The old batch test was corrected to find its fixture employee rather than assume no other employees exist in the database.
