# Payroll OT source migration

## Scope

OT rates now come only from the effective payroll policy for the employee's payroll company,
category and work date. Employee-specific legacy rates are no longer used. Existing Custom
employees use the policy's Custom Office/Site/Travel rates; older policies without those
fields use that policy's Office/Labour Site/Labour Travel rates, never employee overrides.
Confirm these central rates with HR before allowing new OT entry.

## Production Procedure

1. Take and verify a full database backup. Keep a matching copy of the current release.
2. Pause payroll/OT entry and stop all old backend workers, including scheduled workers.
   Do not run old and new releases together: old code can still write legacy overrides.
3. Deploy the new backend and frontend together. Before starting workers, from `backend/`
   with the production environment selected, run `npm run payroll:migrate-ot`.
   This is read-only and lists affected employees and historical OT requiring review.
4. Run `npm run payroll:migrate-ot -- --apply` to archive and retire employee overrides.
   Alternatively, the new backend performs the same migration automatically on startup.
5. Review the output, confirm company/category assignments and payroll policy rates, then
   start the new workers and resume entry. Rerunning the migration is safe.

Never run the seed command on an existing production database.

## Preserved Data

The first original OT values and employee identification are retained in
`employee_ot_rate_archive`, without a cascading employee foreign key. Archive, clear and
audit writes commit in a single transaction. Failure rolls back all three. This includes
deactivated employees, which remain deactivated.

No employee is deleted or recreated. Attendance, biometric identity mappings, employment
dates, salary amounts, eligibility, existing OT, claims, payroll runs, payslips, recoveries
and financial allocations are not changed by this migration. Weekly-rate and statutory
conversion fields are intentionally outside its scope.

## Existing OT Review

The report compares existing non-rejected OT against its linked policy using the current
employee category. A difference is a review flag, not proof the historical payment was
wrong: employee category or company may have changed since the work date. Missing linked
policies also require review. Historical amounts are never silently recalculated, including
draft payroll and pending OT during this migration. Source OT keeps its original recorded
rate. On a subsequent draft rebuild, approved hours use the policy rate effective on their
work date and attendance may supply automatic OT; see `PAYROLL_ATTENDANCE_CALCULATIONS.md`.

Do not bulk-update payslips or OT rates. Paid/approved history must be retained; any agreed
financial correction needs a separately reviewed adjustment under the normal payroll process.
An archived value is evidence, not a reason to reactivate employee overrides. A rollback to
old application code requires a separately reviewed data rollback from the verified backup;
do not automatically copy archived rates back while the new release is running.
