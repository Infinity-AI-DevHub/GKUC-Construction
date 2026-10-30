# Missing EPF on a payslip

The employee EPF line is now always visible on payroll cards, including saved zero amounts. No existing payslip is recalculated by viewing it. New and rebuilt draft runs capture the basis, policy ID, rates and reasons for omitted contributions alongside the existing calculation detail. Older runs do not have those explanations; current employee settings cannot prove what was used at their creation.

On the application server, from `backend`, run:

```sh
npm run payroll:diagnose -- Maduwanthi
```

This reads matching employee profiles, effective policy settings and their latest six saved payslips. It performs no updates, migrations, generation or recalculation. Use an employee code or shorter name fragment if no match is found. Output includes the contribution basis and amounts, so share it only with authorised payroll staff.

Compare the previous successful run with the affected run: frequency, basis, policy/rate, eligibility, classification and contribution start date. Correct the actual profile or policy only after confirming the cause. Existing approved/paid payroll remains unchanged; draft recalculation remains an explicit existing workflow.
