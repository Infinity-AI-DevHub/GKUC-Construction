# HR payroll update — implementation status

Date: 27 September 2026

**Status: partial implementation; not ready for production sign-off.** Existing payroll architecture was extended, not replaced. Unrelated working-tree changes were preserved. This report does not certify that all requested scenarios or permissions are complete.

## Implemented

- Attendance and OT routes no longer accept `site.attendance` alone. Attendance uses HR attendance/administrative permission; confidential payroll inputs use HR payroll permission. Denied permission checks are audit-logged.
- Attendance supports the requested information-source labels and notes. Existing attendance correction reasons and employee/date duplicate protection remain in use. Historical quick toggles now require the correction workflow.
- Effective-dated payroll policies carry shift times, rounding, minimum OT, warning threshold, transport divisor/threshold/comparison, distance allowance, motorcycle rate and fixed-payment compatibility rules.
- Employee allowance eligibility is configurable independently of pay basis and payment frequency.
- Attendance produces Office/Site OT suggestions. Absent and leave records produce no OT. Confirmation creates pending OT, not payable OT. Travel OT uses a distinct travel claim. Duplicate and overlapping inputs are rejected on the tested creation paths.
- HR Payroll Inputs provides employee/project/date/type/status filtering, calculation previews, distinct confirmation and approval actions, supporting attachments, and exceptions for missing sources, high OT, legacy duplicates and attendance corrections after a draft.
- Travel, motorcycle mileage, machine/operator and special-duty claims are stored as dedicated inputs to the existing payroll. Mileage validates odometers and policy conflicts. Named components remain distinct from basic salary.
- Transport supports full, attendance-prorated, per-day and manually specified calculation methods at API level. The full-payment threshold is deliberately unset until HR configures it; inclusive and strict comparisons are selectable.
- Payroll uses approved claims/OT, retains basic-pay-only EPF/ETF calculations, stores separate named allowance/reimbursement components and prevents overlapping employee payroll periods. Status transitions are Draft → Approved → Paid without reopening approved/paid runs.
- Project allocations reference attendance, OT and claim source records without generating another employee payment. Existing QS labour/date duplicate checks are extended to reject already allocated payroll labour. Project spend includes approved/paid payroll allocations.

## Schema changes

Additive migrations in `backend/src/schema.js` introduce:

- `payroll_policies.hr_rules` JSON.
- `employees.allowance_eligibility` JSON.
- Expanded attendance source labels and `attendance.source_notes`.
- `overtime_records.input_detail` JSON.
- `hr_payroll_claims`, including employee/date/type uniqueness, policy reference, input/calculation JSON, status and reviewer metadata.
- Employee component calculation method and allowance type.
- Payslip component calculation details and unique originating claim reference.
- `payroll_project_allocations`, unique by originating source type/id.
- Attendance and payroll-claim attachment owner types.

No user records were intentionally deleted or reset. Automated fixture cleanup is confined to the isolated test database.

## Files changed for this update

Backend: `src/schema.js`, `src/index.js`, `src/db.js`, `src/lib/http.js`, `src/lib/hr-payroll-rules.js`, `src/routes/payroll-inputs.js`, `src/routes/payroll.js`, `src/routes/employees.js`, `src/routes/attendance.js`, `src/routes/hr-registers.js`, `src/routes/analytics.js`, `src/routes/bootstrap.js`, `src/routes/boq.js`, `src/routes/uploads.js`, `test/api.test.js`, `test/hr-payroll-rules.test.js`.

Frontend: `src/main.jsx`, `src/pages/People.jsx`, `src/pages/PayrollInputs.jsx`, `src/payroll-input-display.js`, `src/payroll-input-display.test.js`.

Other dirty files visible in the repository include earlier work and are not claimed as changes for this update.

## Validation

- Node 22 and the repository's npm scripts used.
- Backend: 124 tests passed.
- Frontend: 11 tests passed.
- Production build passed; existing large-bundle warning remains.
- `git diff --check` passed.
- Browser inspection verified the People → Payroll Inputs screen loads, filters/claim form/calculation preview are present and the review tables render. This is not exhaustive browser testing of every role and scenario.
- API scenarios include a daily-rate worker paid weekly, separate approved Site/Travel OT, overlap and duplicate rejection, staged claim approval, mileage errors/conflicts, payroll component totals, immutable paid amounts following a policy change, project source allocation and approval audit entries.
- Unit tests cover rounding, absence/leave exclusions, transport threshold/proration, distance rules, mileage arithmetic and named allowances/basic-only contribution arithmetic.

## Outstanding work — required before production

1. Append-only, effective-dated employee compensation history and correct handling of changes within payroll periods. Current employee compensation remains mutable; stored approved payslip amounts are retained, but full historical profile snapshots are not implemented.
2. Claim correction/revision and adjustment workflows with mandatory reasons. Rejected/approved claims are locked; one-claim-per-day/type uniqueness currently prevents replacement claims for the same date/type.
3. Disable supervisor/site-only system login as requested. Sensitive HR operations are denied, but supervisor accounts are not globally deactivated and can still use unrelated permitted features.
4. Complete entry-versus-final-approval separation across OT and payroll runs. The effective policy separation flag currently applies to claim approval and is not yet exposed in the settings UI.
5. Final-approval overlap revalidation, concurrency tests and database-enforced OT uniqueness for every legacy/API path.
6. Full immutable employee/policy/input/source snapshots, source links and readable base-rate/OT/proration breakdowns in every payslip and printed document.
7. Complete review exceptions for missing applicable rates and all duplicate/overlapping records; require review of post-draft attendance corrections before approval rather than only flagging them.
8. Validate mixed effective policies within periods, partially effective recurring components and manual-amount review semantics.
9. Complete project allocation of employer contributions/recurring allowances, verify all Finance reports consume the same allocation totals, and concurrency-proof the QS/payroll labour duplicate protection.
10. Full end-to-end role/browser coverage, correction audit tests and explicit assertions for every requested scenario. Current passing tests are not equivalent to complete coverage of the specification.

## Business decisions still requiring confirmation

- Full monthly transport threshold and whether the comparison is inclusive or strict.
- Minimum payable OT and maximum daily warning threshold (editable provisional defaults are 0.5 and 6 hours).
- Whether qualifying long-distance is based on one-way distance or total return distance, whether supplied food changes the allowance, and whether multiple trips in a day are payable separately.
- Whether Office/Site morning and evening portions round independently or as a combined total; current implementation rounds the combined total down to the configured interval.
- Eligible states for allowance proration, overnight shift handling and deduction/proration rules across daily/weekly/monthly periods.
- Which HR users must provide final approval and whether separation is mandatory.

No legal interpretation of EPF/ETF eligibility or contribution rules is asserted here; this implementation preserves the business rule supplied by the user.
