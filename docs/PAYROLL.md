# Payroll architecture and agreed rules

This is the authoritative payroll specification as agreed on 2026-11-02. It replaces attempts to reproduce every exception in the former manually-entered salary workbook. The objective is a transparent, repeatable calculation that can be shown day by day in the payslip and salary-details export.

## Policy model

- Policies belong to a payroll company and have an `effective_from` date.
- The agreed rule set starts **2026-01-01** for both GKUC Construction and GKUC Readymix.
- Save one dated policy for each company from People → Payroll settings. The two companies presently use the same values, but payroll runs, employees, components and totals remain company-scoped.
- Policy values can be edited from the Effective-dated payroll policies table. An update is audited.
- Editing a policy changes future calculations and a manually regenerated Draft run. Approved/Paid payroll and saved payslips retain their snapshot.
- Policy deletion archives it for calculations; it does not hard-delete historical records.

## Standard work and salary

| Rule | Value |
| --- | --- |
| Normal work starts | 07:30 |
| Normal work ends | 16:30 |
| Paid hours per day | 8 |
| Short day earnings | `daily rate ÷ 8 × actual worked hours`, capped at 8 hours |
| Leave day contribution to 25-day threshold | 0 |
| Daily work over 8 hours | Does not make the attendance-day count exceed 1; OT is calculated separately |

For a valid attended day, actual worked time is the elapsed check-in to check-out time, capped at 8 paid hours. This avoids applying a short-day deduction to an employee who arrived late but later worked enough hours. Missing or review-required attendance remains flagged and must not silently invent OT or late deductions.

## Overtime

OT is an addition to salary. It uses exact actual minutes; no 15-minute rounding occurs. Once the relevant minimum is met, the whole eligible interval is payable.

Morning OT is eligible only where check-in is **07:00 or earlier**. Morning and evening eligible minutes are combined before the applicable minimum is checked. Evening OT begins after 16:30. Office staff have no Travel OT. Travel OT requires an approved travel record with documented intervals; its intervals are removed from automatic Site/Office OT to prevent duplicate payment.

| Category | Office OT | Site OT | Travel OT |
| --- | --- | --- | --- |
| Office staff, including IT | LKR 225/h; minimum 30 min | — | Not allowed |
| Supervisor | — | LKR 225/h; minimum 30 min | LKR 100/h; minimum 31 min |
| Driver | — | LKR 100/h; minimum 31 min | LKR 225/h; minimum 30 min |
| Site labourer | — | LKR 225/h; minimum 30 min | LKR 100/h; minimum 31 min |

Formula after the applicable minimum is reached:

```text
OT amount = eligible OT minutes ÷ 60 × category/type OT rate
```

Examples:

- Office check-out 17:07: 37 evening minutes. It exceeds the 30-minute minimum, so OT is 37/60 × 225.
- Driver Site OT of 30 minutes: no payment; Driver Site minimum is 31 minutes.
- Driver Travel OT of 30 minutes: paid; Travel minimum is 30 minutes.

## Late deduction

Late is a deduction and is independent from OT.

- 07:31 through 07:45 are free.
- From 07:46 onward, deduct only the actual minutes after 07:45.
- Rate is the employee's normal attended-work OT rate: Office 225, Labour 225, Supervisor 225, Driver 100.
- Travel rate is never used for late deduction.

```text
late minutes for deduction = max(0, check-in − 07:45)
late deduction = late minutes ÷ 60 × late hourly rate
```

Examples at LKR 225/h:

| Check-in | Deductible minutes | Deduction |
| --- | ---: | ---: |
| 07:45 | 0 | LKR 0.00 |
| 07:46 | 1 | LKR 3.75 |
| 08:00 | 15 | LKR 56.25 |
| 08:12 | 27 | LKR 101.25 |
| 08:15 | 30 | LKR 112.50 |

The 08:12 calculation is 27 minutes because 08:12 minus 07:45 is 27 minutes. Do not round these minutes.

## 25-day monthly premium

This applies to all employees, each calendar month.

- Count each attended day as `min(actual worked hours ÷ 8, 1)`.
- Leave does not count.
- When the running monthly worked-day equivalent goes beyond 25, the entire current work day uses `daily rate × 1.5`.
- The daily rate multiplier changes basic earnings only. OT rates, OT hours, late rate and late deduction do not change.
- The count resets at each calendar month.

Example: 24 full worked days plus a four-hour day gives 24.5. The next full work day takes the total to 25.5 and its complete 8-hour basic pay uses 1.5×.

## Statutory contribution values

| Contribution | Rate |
| --- | ---: |
| Employee EPF | 8% |
| Employer EPF | 12% |
| Employer ETF | 3% |

The current application uses each eligible monthly employee's saved statutory salary basis, not fluctuating earnings, OT, leave, allowances or reimbursements. Employee eligibility and contribution start date remain profile settings. This is a product configuration; statutory compliance must be checked by the company accountant before changing policy eligibility rules.

## Code ownership

| Concern | Primary code |
| --- | --- |
| Policy request validation and API | `backend/src/routes/payroll.js` |
| Default/dated HR rules and OT/late minute arithmetic | `backend/src/lib/hr-payroll-rules.js` |
| Category OT and late rate selection; payslip totals | `backend/src/lib/payroll-policy.js` |
| Attendance, short day, day premium, OT and late calculation | `backend/src/lib/attendance-payroll.js` |
| Payroll settings UI | `frontend/src/pages/People.jsx` |
| Payroll test scenarios | `backend/test/hr-payroll-rules.test.js`, `backend/test/attendance-payroll.test.js` |

## Change checklist

1. Update the relevant dated policy fields and labels.
2. Update calculation libraries, not only UI defaults.
3. Add a focused calculation test with real times and expected money.
4. Verify generated daily detail, payslip total and export still reconcile.
5. Update this document and append the decision to `PROGRESS.md`.

## Attendance scanner identity memory (2026-11-03)

The existing biometric import manual-match action now saves the scanner's source name internally alongside its approved number-to-employee mapping. Later previews and commits can recognize an unambiguous saved scanner name even if the export number differs. Profile display names are unchanged. Duplicate names and number/name ownership conflicts remain for manual HR matching, and hidden/Left profiles cannot be matched by name.

This changes identity resolution only: attendance preview/review/import, manual correction protection, attendance calculations, policy rates and saved payroll snapshots retain their existing behavior. Focused coverage includes remembered scanner names across CSV and legacy Excel, source/profile name differences, duplicates/conflicts, deactivated profiles, multiple scanner IDs, reimports and the supplied report in an isolated test database.
