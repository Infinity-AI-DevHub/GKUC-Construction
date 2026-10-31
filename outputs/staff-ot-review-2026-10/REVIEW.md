# Approved Staff workbook — October 2026 OT review

Read-only review. The approved workbook values are the reference. Candidate-rule differences are not payroll errors and are not proposed corrections. No application code, database rows or source workbook cells were changed.

## Scope and notation

- Scanned all 115 worksheet names/date columns and identified 19 October 2026 daily blocks: 589 dated rows. Historical months were kept outside this month’s comparisons.
- Time entries such as `7.3`, `7.5`, `17.3` are interpreted as 07:30, 07:50, 17:30, not decimal hours. This interpretation is strongly supported by entries such as 7.52, 17.57 and 16.59.
- OT hours such as `0.5`, `0.75` and `1.25` are decimal hours: 30, 45 and 75 minutes.
- OT hour inputs in this month are manual, but most amount cells contain formulas and cached calculated results. Formula inspection was used to verify rates and cached values; formulas do not explain how manual hours were decided.
- Blank OT input means no OT hours recorded. It is treated as zero for model comparisons only, not proof that HR explicitly rejected OT. Missing punches are not filled in or used to invent hours.
- Nadeera’s block also contains 2026-09-30 at row 6. Its OT is blank/zero; October-only comparisons exclude that boundary row.

## Findings

1. Every positive ordinary/Site OT entry (183 rows) uses LKR 225/hour and the cached amount equals recorded hours × 225. All 62 Site/Travel date rows have cached Travel OT amounts consistent with recorded Travel hours × LKR 100.
2. Recorded ordinary/Site OT hours total 171.00 and amounts total LKR 38,475.00. Travel OT totals 22.50 hours and LKR 2,250.00. Combined recorded OT is 193.50 hours / LKR 40,725.00. These are October daily-row totals; they are not net salary.
3. The 14 active ordinary-staff sheets have 296 rows with valid paired times. A simple elapsed-attendance-minus-9-hours model, rounded down to 15-minute units with a 30-minute minimum, matches 247/296 (83.45%); 49 approved rows differ. It matches 130/176 positive OT rows and 117/120 blank-OT rows. This is an explanatory candidate, not a proven universal payroll policy.
4. Nearest-quarter-hour duration rounding matches 245/296. Rounding each punch to the nearest quarter hour matches 227/296. No tested single simple rule reproduces the full approved sheet. A sensitivity scan adding 1–14 minutes before floor rounding improved the best count only to 261/296 (at an arbitrary 4-minute tolerance); there is no evidence to adopt such an inferred tolerance.
5. Positive entered hours are in 15-minute units, and no positive ordinary/Site OT entry is below 0.50 hour. This supports a 30-minute payable threshold in this month, but does not prove a rule for every future employee/date.
6. Earlier arrivals appear in the approved results; late arrivals often reduce OT. Comparing only time after 16:30 matches 158/296.
7. Ruwantha and Nihal use separate AM / Site off / normal off columns. Site OT generally uses the post-16:30 site interval; Travel OT generally uses early travel before 07:30 plus time after the later of site-off and 16:30. Floor-to-15-minute and 30-minute-minimum candidates match Site on 47/48 paired rows and Travel on 46/48. Some travel during the normal shift is not overtime.
8. There are incomplete end-of-month punches, absences with daily pay, special allowances, and sheets without recorded OT. Their approved payment treatment cannot be inferred from OT timestamps alone. Ashan IT and Dulan Driver have no entered OT hours/amounts; Virajini’s October block has no attendance. The inactive Virajini template still contains old ×100 formulas, so it is not evidence of a current paid OT rate.

## Examples of the observed ordinary-staff pattern

| Employee / Excel row | Date | In → Out | Elapsed minus 9 hours | Approved OT | Approved OT amount |
|---|---|---|---:|---:|---:|
| MADUWANTHI 3308 | 2026-10-01 | 07:28 → 17:02 | 34 min | 0.50 h | 112.50 |
| MADUWANTHI 3315 | 2026-10-08 | 07:36 → 17:22 | 46 min | 0.75 h | 168.75 |
| kawya 671 | 2026-10-01 | 06:57 → 17:00 | 63 min | 1.00 h | 225.00 |
| HANSIKA 3434 | 2026-10-01 | 07:52 → 17:03 | 11 min | blank | 0.00 |
| KASUN ACC 415 | 2026-10-22 | 08:03 → 17:35 | 32 min | 0.50 h | 112.50 |

A 9-hour elapsed baseline is consistent with a 07:30–16:30 attendance span. It does not establish the timing or duration of an unpaid break; break punches are not present. It should not be labelled nine paid hours.

## Per-employee OT reconciliation

Hours and amounts below are sums of the actual October daily entries, checked against cached OT total cells.

| Sheet | Paired time rows | Ordinary/Site hours | Ordinary/Site LKR | Travel hours | Travel LKR | Simple duration model matches |
|---|---:|---:|---:|---:|---:|---|
| HANSIKA | 26 | 8.50 | 1,912.50 | 0.00 | 0.00 | 20/26 |
| MADUWANTHI | 23 | 14.25 | 3,206.25 | 0.00 | 0.00 | 18/23 |
| HIRUSHI | 21 | 23.00 | 5,175.00 | 0.00 | 0.00 | 14/21 |
| RUWANTHA | 24 | 4.50 | 1,012.50 | 20.50 | 2,050.00 | Not modelled as ordinary staff |
| NIHAL | 24 | 1.50 | 337.50 | 2.00 | 200.00 | Not modelled as ordinary staff |
| kawya | 25 | 29.50 | 6,637.50 | 0.00 | 0.00 | 22/25 |
| KASUN ACC | 22 | 8.75 | 1,968.75 | 0.00 | 0.00 | 17/22 |
| hashani | 14 | 4.50 | 1,012.50 | 0.00 | 0.00 | 13/14 |
| Nadeera | 24 | 7.25 | 1,631.25 | 0.00 | 0.00 | 22/24 |
| BHAGYA TRAINEE | 24 | 13.00 | 2,925.00 | 0.00 | 0.00 | 22/24 |
| Tharidu | 24 | 16.75 | 3,768.75 | 0.00 | 0.00 | 20/24 |
| Dinushika | 24 | 9.50 | 2,137.50 | 0.00 | 0.00 | 18/24 |
| Dilsha | 22 | 8.25 | 1,856.25 | 0.00 | 0.00 | 19/22 |
| Bandara(exe) | 14 | 2.25 | 506.25 | 0.00 | 0.00 | 14/14 |
| Rochana | 24 | 13.25 | 2,981.25 | 0.00 | 0.00 | 22/24 |
| Chamith | 9 | 6.25 | 1,406.25 | 0.00 | 0.00 | 6/9 |
| Ashan IT | 9 | 0.00 | 0.00 | 0.00 | 0.00 | Not modelled as ordinary staff |
| Dulan Driver | 1 | 0.00 | 0.00 | 0.00 | 0.00 | Not modelled as ordinary staff |
| VIRAJINI | 0 | 0.00 | 0.00 | 0.00 | 0.00 | Not modelled as ordinary staff |

## All 49 ordinary-staff differences from the best simple candidate

These approved values remain unchanged. Differences may reflect manual rounding, approval decisions or context absent from the sheet. Do not replace them with the candidate.

| Sheet / Excel row | Date | In → Out | Approved OT h | Candidate h |
|---|---|---|---:|---:|
| HANSIKA / 3440 | 2026.10.07 | 07:51 → 17:17 | 0.50 | 0.00 |
| HANSIKA / 3442 | 2026.10.09 | 07:43 → 17:57 | 1.25 | 1.00 |
| HANSIKA / 3453 | 2026.10.20 | 07:50 → 17:16 | 0.50 | 0.00 |
| HANSIKA / 3455 | 2026.10.22 | 07:52 → 17:35 | 0.75 | 0.50 |
| HANSIKA / 3456 | 2026.10.23 | 07:50 → 17:19 | 0.50 | 0.00 |
| HANSIKA / 3462 | 2026.10.29 | 07:52 → 17:39 | 0.50 | 0.75 |
| MADUWANTHI / 3312 | 2026.10.05 | 07:36 → 17:32 | 1.00 | 0.75 |
| MADUWANTHI / 3327 | 2026.10.20 | 07:35 → 17:16 | 0.75 | 0.50 |
| MADUWANTHI / 3333 | 2026.10.26 | 07:37 → 17:35 | 1.00 | 0.75 |
| MADUWANTHI / 3335 | 2026.10.28 | 07:39 → 17:05 | 0.50 | 0.00 |
| MADUWANTHI / 3337 | 2026.10.30 | 07:40 → 17:06 | 0.50 | 0.00 |
| HIRUSHI / 3620 | 2026.10.03 | 07:35 → 17:00 | 0.50 | 0.00 |
| HIRUSHI / 3623 | 2026.10.06 | 07:40 → 21:00 | 4.50 | 4.25 |
| HIRUSHI / 3625 | 2026.10.08 | 07:42 → 17:30 | 1.00 | 0.75 |
| HIRUSHI / 3626 | 2026.10.09 | 07:35 → 18:00 | 1.50 | 1.25 |
| HIRUSHI / 3627 | 2026.10.10 | 07:35 → 18:15 | 1.75 | 1.50 |
| HIRUSHI / 3638 | 2026.10.21 | 07:33 → 19:00 | 2.50 | 2.25 |
| HIRUSHI / 3639 | 2026.10.22 | 07:40 → 18:00 | 1.50 | 1.25 |
| kawya / 673 | 2026.10.03 | 07:04 → 17:30 | 1.50 | 1.25 |
| kawya / 678 | 2026.10.08 | 06:55 → 17:22 | 1.50 | 1.25 |
| kawya / 693 | 2026.10.23 | 07:23 → 17:19 | 1.00 | 0.75 |
| KASUN ACC / 398 | 2026.10.05 | 07:38 → 17:19 | 0.75 | 0.50 |
| KASUN ACC / 400 | 2026.10.07 | 07:51 → 17:19 | 0.50 | 0.00 |
| KASUN ACC / 401 | 2026.10.08 | 07:41 → 17:23 | 0.75 | 0.50 |
| KASUN ACC / 416 | 2026.10.23 | 07:50 → 17:19 | 0.50 | 0.00 |
| KASUN ACC / 422 | 2026.10.29 | 08:02 → 18:00 | 1.00 | 0.75 |
| hashani / 339 | 2026.10.05 | 07:22 → 17:17 | 1.00 | 0.75 |
| Nadeera / 13 | 2026.10.07 | 07:08 → 16:49 | 0.75 | 0.50 |
| Nadeera / 27 | 2026.10.21 | 07:08 → 16:53 | 0.50 | 0.75 |
| BHAGYA TRAINEE / 411 | 2026.10.20 | 07:33 → 17:16 | 0.75 | 0.50 |
| BHAGYA TRAINEE / 417 | 2026.10.26 | 07:37 → 17:35 | 1.00 | 0.75 |
| Tharidu / 64 | 2026.10.03 | 06:51 → 17:09 | 1.00 | 1.25 |
| Tharidu / 77 | 2026.10.16 | 06:53 → 16:47 | 0.50 | 0.75 |
| Tharidu / 80 | 2026.10.19 | 06:50 → 17:15 | 1.50 | 1.25 |
| Tharidu / 89 | 2026.10.28 | 06:54 → 16:47 | 0.50 | 0.75 |
| Dinushika / 233 | 2026.10.05 | 07:21 → 17:10 | 0.50 | 0.75 |
| Dinushika / 237 | 2026.10.09 | 07:20 → 17:19 | 1.00 | 0.75 |
| Dinushika / 238 | 2026.10.10 | 07:17 → 16:59 | 0.75 | 0.50 |
| Dinushika / 240 | 2026.10.12 | 07:19 → 16:43 | 0.50 | 0.00 |
| Dinushika / 256 | 2026.10.28 | 07:30 → 17:01 | 0.00 | 0.50 |
| Dinushika / 257 | 2026.10.29 | 10:30 → 17:14 | 0.75 | 0.00 |
| Dilsha / 183 | 2026.10.09 | 08:04 → 17:30 | 0.50 | 0.00 |
| Dilsha / 190 | 2026.10.16 | 07:01 → 16:30 | 0.50 | 0.00 |
| Dilsha / 202 | 2026.10.28 | 07:15 → 16:47 | 0.00 | 0.50 |
| Rochana / 175 | 2026.10.01 | 07:02 → 18:31 | 2.50 | 2.25 |
| Rochana / 182 | 2026.10.08 | 07:02 → 16:31 | 0.50 | 0.00 |
| Chamith / 31 | 2026.10.26 | 07:12 → 16:43 | 0.00 | 0.50 |
| Chamith / 33 | 2026.10.28 | 05:30 → 18:49 | 4.50 | 4.25 |
| Chamith / 35 | 2026.10.30 | 07:46 → 17:10 | 0.50 | 0.00 |

Specific limits on one universal formula: HANSIKA row 3440 (07:51–17:17) has 0.50 hour although raw excess is 26 minutes. MADUWANTHI row 3312 (07:36–17:32) has 1.00 hour although raw excess is 56 minutes. Dinushika row 257 (10:30–17:14) has 0.75 hour despite a short overall day; its daily pay is reduced to 500, suggesting basic-pay reduction and evening OT can sometimes be handled separately. Dinushika row 256 (07:30–17:01) has blank OT, while other comparable entries receive 0.50 hour. These are approved exceptions/context questions, not a declaration that the sheet is wrong.

## Site / Travel decomposition

Example: Ruwantha 2026-10-01, row 3033: 05:30 start, 18:00 site-off, 20:30 normal-off. Site OT = 18:00 − 16:30 = 1.50 hours ×225 =337.50. Travel OT = (07:30−05:30) + (20:30−18:00) =4.50 hours ×100 =450.00. Site allowance500 is a separate entry. No interval is counted twice.

Ruwantha 2026-10-21, row3053: 05:40 start,16:30 site-off,21:00 normal-off. Candidate early travel110min + evening270min=380min, floored to375min=6.25h, exactly the approved Travel OT625.00.

Paired-row candidate differences:
- RUWANTHA row 3055 (2026.10.23): approved Site 0.00 / Travel 0.50; candidate Site 0.00 / Travel 0.00 hours.
- NIHAL row 1940 (2026.10.05): approved Site 0.50 / Travel 0.00; candidate Site 0.00 / Travel 0.75 hours.

## Existing system comparison (code inspection only)

`backend/src/lib/hr-payroll-rules.js` suggests early time before normalStart plus evening time after normalEnd + otGraceMinutes, then floors the combined time to otInterval. `attendance-payroll.js` excludes approved/pending travel intervals before automatic Office/Site OT, respects explicit reviewed OT decisions, and keeps Travel OT separate.
With a hypothetical 07:30–16:30 policy, 0.25h steps and 0.25h minimum, that outside-shift calculation yields197.00h on the same296 paired ordinary rows with zero evening grace, or145.00h with15min evening grace, versus165.00h approved. These are input-matched scenario comparisons, not a reproduction of production settings or the whole payroll.
The current helper does not generally subtract late arrival from evening OT; late deductions are calculated separately. Changing only the OT rate or adding one global15min grace cannot reproduce this sheet. Live policy values, employee categories, explicit OT decisions and approved Travel claims have not been provided.

## Recommended implementation direction — not implemented

- Preserve this approved month as an immutable reference.
- Confirm whether the intended ordinary rule is daily elapsed time minus9hours, with a30min minimum and15min increments, or separate early/evening intervals with special late-arrival treatment. Confirm rounding explicitly rather than infer a4-minute tolerance.
- Keep the two-site-off/return-off readings and separate225/100rates for travelling staff; a single check-out time cannot reconstruct these trips reliably.
- Allow approved manual OT overrides with a reason and preserve the original punches and automatic suggestion.
- Validate any revised rule against every supplied October row and retain all approved exceptions instead of silently overwriting them.

## Source preservation

Source SHA-256: `f27b4b1856472fe5925e22782fd90777fc8ad713720b3b133686eef03bd47143`

`daily-audit.html` contains all589 October rows, their original cell values, cached outputs, OT amount checks, and model comparisons. `analysis.json` retains the full extracted evidence and verification counts.
