# Draft Payroll Recalculation and Deletion

Payroll users can recalculate or delete a Draft payroll from the payroll register.
Both actions require confirmation. Submitting Prepare payroll again for exactly the same
company, payment frequency and date range also rebuilds that Draft in place, keeping its
ID and reference. Partial overlaps and cross-frequency employee overlaps remain blocked.
Approved and Paid payroll cannot be deleted or rebuilt.

## Recalculation

The previous run, payslips, components, advance recoveries and project allocations are
copied into the audit trail before the generated children are removed. The same parent
run is then rebuilt from attendance-based Office/Site OT, reviewed OT decisions, approved claims, current
employee compensation, effective payroll policy and recurring components. Its generated
timestamp is refreshed so attendance corrections already included no longer appear as
corrections after that draft.

Removing old generated children before reading available advances/claims is essential:
otherwise a rerun would omit the advance or claim already consumed by its previous version.
Recalculation is one database transaction. Any error restores the previous draft in full.

Company-row locks serialize create, rebuild, delete and approval operations. Concurrent
same-period submissions rebuild the same Draft, never create a second payment run.
Approval/paid transitions lock and recheck the run in the same transaction.

## Deletion

Only generated run records are removed: payroll project allocations, salary advance
recoveries, payslip components, payslips and the Draft parent. App deletion retains the full
previous snapshot in the audit log. Removing recovery allocations makes the original
advance outstanding again; it does not create or delete petty cash transactions.
Approved source claims become available for a future payroll when their generated
payslip component is removed. Attendance, biometric identities, employee records, OT,
claims, pay components, advances and petty cash entries are preserved.

## Existing Production Draft

After a verified database backup, stop payroll writes and use
`ops/delete-draft-payroll.sql` in the selected production database. The first query lists
IDs, companies, periods, frequencies and statuses. Replace the final CALL argument `0`
with the single confirmed Draft ID. The default refuses deletion. The procedure rolls
back automatically on any SQL exception and refuses Approved/Paid runs. It records a
parent-run deletion audit, not the full child snapshot; retain the verified full backup.
It requires permission to create a stored procedure. Do not disable foreign key checks.

See `PAYROLL_ATTENDANCE_CALCULATIONS.md` for dated OT/late calculation and review rules.
No direct deletion is required after the new application is deployed: an exact-period
Draft can simply be generated again. Deploy backend and frontend together; old servers
will continue rejecting duplicate periods. Stop old workers before starting the new release.
Attendance calculation snapshots and their project allocation source require the startup
schema migration. The separate OT-source migration still runs as described in its rollout guide.

## Verification

Isolated database tests cover updated earnings, identical run ID/reference, no duplicate
allocations, simultaneous reruns, rollback after calculation failure, release/reuse of
advances and claims, forbidden deletion by non-payroll users, Approved/Paid protection,
source-record preservation, audit snapshots, SQL deletion and forced SQL rollback.
