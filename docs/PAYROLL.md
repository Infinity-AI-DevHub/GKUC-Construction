# Payroll architecture and agreed rules

This is the authoritative payroll specification, including the employee-specific agreements and Operator Standby OT clarification confirmed on 2026-11-03. It replaces attempts to reproduce every exception in the former manually-entered salary workbook. The objective is a transparent, repeatable calculation that can be shown day by day in the payslip and salary-details export.

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
| Employee-specific daily rules and HR input API | `backend/src/lib/special-pay.js`, `backend/src/routes/special-pay.js` |
| HR daily work/meter entry UI | `frontend/src/pages/SpecialDailyPay.jsx` |
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

## Employee-specific daily pay agreements — effective 2026-01-01

These are opt-in employee agreements, not new defaults for everyone. HR must select the actual employee in **People → Payroll Inputs → Special daily pay → Set employee pay method** and save the dated rule (default effective date 2026-01-01). Source code does not guess Sunil's/operator's employee ID or silently assign either method in a live database. A later dated Standard method restores normal rules. Earlier periods retain the prior method; saved Approved/Paid payroll remains locked.

### Bass / Gola work-role method

- HR records exactly one work type per employee/date: Bass (LKR 3,000/day) or Gola (LKR 2,500/day). No supervisor confirmation or separate approval is required.
- Full day is eight paid hours. Short-day earnings use actual attendance hours capped at eight, using that day's chosen rate. Attendance and work location are still recorded/imported through the existing workflow.
- Site OT is LKR 225/h, minimum 30 minutes; Travel OT is LKR 100/h, minimum 31 minutes, with approved travel evidence. Ordinary late grace/deduction rules continue, using LKR 225/h. Special-role automatic OT money uses exact eligible minutes.
- Calendar-month worked-day equivalents use actual attendance hours / eight, capped at one per day. Leave does not count. When the running count exceeds 25, the day's chosen Bass/Gola basic rate uses 1.5×; OT and late rates do not change.
- Sundays/holidays use the selected daily role rate. There is no extra Sunday multiplier. Approved paid leave requires HR to select its applicable role too; the saved leave pay uses that daily rate, without adding a worked-day premium.
- Missing daily choices, invalid attendance times or review-required attendance block Draft generation with an HR correction message. No fallback to a guessed role is allowed.

### Machine operator method

- HR records Machine work (start/end hour-meter readings, positive difference at most 24 hours) or Standby (hours attended without operating the machine).
- Machine work: `max(LKR 1,800, meter hours × LKR 650)`. Attendance duration does not reduce machine pay. Meter work counts as one worked-day equivalent because it receives a full minimum daily payment.
- Standby: `LKR 1,800 / 8 × min(attended hours, 8)`. Four hours pays LKR 900; eight pays LKR 1,800. Standby contributes the same fraction (hours / eight, capped at one) toward the calendar-month threshold.
- When the running monthly count exceeds 25, a Machine day's basic payment is **LKR 1,800 × 1.5 = LKR 2,700**, replacing the normal meter-based basic payment on that extra day. It is not an extra LKR 2,700, an extra LKR 900, or 1.5× meter earnings. Standby uses the corresponding prorated LKR 2,700 rate. Leave does not advance the threshold; each calendar month resets it.
- LKR 300 transport allowance applies once per worked date, including half-days and Sundays. No transport is generated on absent/leave dates. Conflicting recurring Transport/Machine allowances or separate approved machine/operator claims block generation rather than paying the same entitlement twice.
- **Machine work dates have no OT. Standby dates qualify for normal labour Site OT**, using the company policy effective on that work date (currently LKR 225/h), with a 30-minute minimum. Once the minimum is met, use actual eligible minutes. Ordinary morning/evening OT windows apply to saved attendance; standby basic remains capped at eight hours so OT is not added to the basic hours again.
- No operator late deduction on either work type. Office/Travel OT remains excluded. Existing non-rejected OT on a Machine date, or non-Site OT on a Standby date, must be resolved before payroll. HR OT suggestions and entry routes check the saved daily work type; missing/archived work choices cannot enable OT. Reviewed Site OT on a Standby date replaces automatic Site OT rather than adding both.
- LKR 1,800 × 25 is an example of 25 full standby days, not a separate LKR 45,000 addition or an absence guarantee. Salary advances continue through the existing saved advance/recovery ledger.

### Storage, contributions and history

`employee_special_pay_rules` saves effective methods and a snapshot of the agreed rates; `employee_special_pay_days` saves HR choices/readings/hours, source/correction reason, recorder and an active flag. Edits and reversible archival are audited. Daily entries do not create attendance; an orphan daily record without worked attendance or approved leave blocks generation. Earlier operator inputs in the same month are needed to determine the premium correctly.

As currently agreed, either special method disables employee/employer EPF in calculations while it is effective. The employee profile is not overwritten. **ETF retains the existing employee eligibility and statutory basis**; no inference of an ETF exemption or global LKR 30,000 basis correction is made. Contribution explanation snapshots state the special EPF exception. Non-special staff and statutory policies are unchanged.

Draft generation snapshots each day's rule, work type, HR input ID/recorder/reason, rates, readings, formula, earned basic and transport. Payslip PDFs and XLSX read those saved calculations, including a Special daily pay sheet. Per-day export basic uses saved earned amounts (including premiums), not a current profile rate. Changing an input/rule does not automatically recalculate any run; explicitly regenerate a Draft. Approved/Paid runs cannot be regenerated.

Coverage: `backend/test/special-pay.test.js` tests effective dates, role/short-day pay, operator minimum/standby/transport, no Machine-day OT or operator late, Standby Site OT at 29/30/31-minute boundaries, 30/31-minute role thresholds, calendar resets/premiums, Standard restoration and saved export reconciliation. API scenarios test permission/persistence, missing-input blocking, archived inputs, Draft regeneration, approved snapshot protection, role-based paid leave, EPF exception and unchanged ETF eligibility.

### 2026-11-03 clarification — operator Standby OT

The initial blanket “no operator OT” instruction is superseded: only Machine work dates exclude OT. Standby uses the dated normal labour Site rate and 30-minute minimum, independent of the employee's ordinary payroll category. Late deductions remain excluded on both types. This clarification applies within the special agreement effective from 2026-01-01 and only affects future or explicitly regenerated Draft runs; existing saved Approved/Paid calculations are not rewritten.

## Manual UI verification — 2026-11-03

In disposable local data, HR created a Daily employee at LKR 3,000, entered an office
07:30–16:30 attendance day, and built a one-employee Draft with gross/net LKR 3,000.
The saved two-page payslip and downloaded salary XLSX reflected that record. Explicit
Draft regeneration retained the total. After approval and marking Paid in test data,
recalculate/delete controls disappeared and rebuilding the same period was blocked.
The browser read the same Paid record created in Electron. No money was transferred.

HR also saved an effective Work role rule and a dated Bass input through the UI. These
checks supplement existing automated calculation/API coverage; they do not prove every
operator/25-day/OT combination through manual UI tests or live policy configuration.
The test used local seeded policy. Production still requires the agreed 2026-01-01
policies and explicit employee setup. No payroll calculation changed in this QA pass.
See MANUAL_QA.md for exclusions and DEPLOYMENT.md for the production setup sequence.

## 2026-11-03 production settings and manual allowance clarification

HR confirmed that variable allowances are entered manually. The sole agreed automatic
allowance is the Operator's LKR 300 per worked date (including half-days/Sundays).
Keep that entitlement separate from HR-entered allowances and preserve the duplicate
Transport/Machine safeguards. Policy travel/site-charge rates alone do not generate
an allowance: an explicit eligible HR input/claim and its approval are required.
Manual approved amounts retain the amount entered; they are not silently prorated.
Attendance-prorated transport remains an explicit separate method and requires a
configured full-transport day threshold; the supplied screenshot leaves it blank.
Existing saved Approved/Paid payslip amounts remain unchanged.

The supplied Construction settings screenshots show effective date 2026-01-01,
07:30–16:30 work, morning eligibility through 07:00, eight paid hours, 15-minute late
grace and the existing 30/31-minute category OT thresholds. They show Office/Site
labour/Supervisor Site OT at 225, labour/Supervisor Travel at 100, Driver Site at 100
and Driver Travel at 225 LKR/hour; 25 attended days then 1.5×; contribution basis
30,000 and percentage settings 8/12/3. These screenshots verify the supplied values,
not that the dialog was saved or that both companies have production policies.
No source-code change writes those values to production.

Regression expectations now use actual OT minutes and per-work-date policies,
category-specific late rates and actual attended basic pay. Driver Office OT is
rejected; only Site/Travel are allowed. The Draft rollback test owns its missing
transport-threshold policy fixture instead of depending on policies left by other
tests. Invoice payment-mode verification compares rendered text rather than markup.
