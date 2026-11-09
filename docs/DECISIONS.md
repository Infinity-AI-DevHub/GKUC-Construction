# Decision register

This register records durable product and engineering decisions. It is not a release log; use `PROGRESS.md` for chronological changes. Update this file when a decision changes, then append the implementation event to `PROGRESS.md`.

## Data, workflow and safety

| Area | Current decision |
| --- | --- |
| Source of truth | MySQL is the source of truth. Static UI mocks must not replace API-backed workflows. |
| Auditability | Meaningful writes record audit history. Reasons are required where a correction could alter an operational record. |
| Company scope | GKUC Construction and GKUC Readymix have separate finance and payroll runs/policies. Shared people/materials/vehicles do not imply shared financial records. |
| Historical data | Preserve history. Use archived status or a scoped delete of Draft-only derived records; do not hard-delete paid, approved or linked business records. |
| Uploads | Storage provider errors are separate from application errors. S3/Contabo must use the S3 configuration documented in README; do not confuse R2 credentials with Contabo S3 credentials. |
| Production | A local test or local bundle is not a production deployment. Production actions need explicit user instruction and evidence. |

## Payroll decisions

The detailed specification lives in [PAYROLL.md](PAYROLL.md). The decisions below explain why it exists.

- The prior staff workbook contains manually entered values and inconsistent exceptions. It is a historical comparison source, not an executable payroll specification.
- Payroll must calculate from saved attendance, approved leave, approved claims, employee profile values and the effective dated policy. It must persist calculation details in the payslip so later policy edits do not rewrite history.
- Both company policies currently use the same agreed rates, but remain separate records because the underlying payroll companies and runs are separate. Do not centralize them without an explicit data model change and migration.
- Employee EPF is 8%, employer EPF is 12% and employer ETF is 3% in the agreed policy. Eligibility and salary basis are employee/profile policy concerns; never assume a flat EPF deduction amount.
- A policy with an eligible employee and a zero contribution rate blocks Draft generation rather than silently paying an incorrect salary. Correct with a dated policy and regenerate the Draft.
- Policy removal is archival. A replacement can use the same effective date; active duplicates are rejected.
- Deleted Draft payrolls may be recreated for the same dates. Approved/Paid payroll stays locked and retains its saved policy reference.
- Salary-detail XLSX exports and payslip PDFs should show saved day-by-day calculation evidence, not only final totals.

## Payroll calculation boundaries

- OT and late are intentionally independent. Do not subtract late time from OT.
- Do not quarter-hour-round the new rules. Formula values use actual minutes and round currency only at the final money step.
- Short-day earnings use actual elapsed worked time capped at eight paid hours. This avoids a second short-day deduction where an employee makes up time after arriving late.
- Leave does not advance the 25-day monthly premium threshold. The day that takes the worked-day equivalent beyond 25 is wholly paid at 1.5× basic daily rate; its OT and late rules do not change.
- Travel OT must have approved evidence and must not overlap automatic Office/Site OT. Office staff do not receive Travel OT.

## Finance decisions

- A supplier cheque may allocate across multiple supplier invoices. Its amount is auto-summed from selected invoices; if changed manually, a mandatory override reason is retained.
- Credit purchases should be reviewable supplier by supplier.
- Owner personal/household spending paid from company funds belongs in finance as a clearly categorized owner/director drawings or private-expense record, not as a project cost. This preserves company cash visibility without distorting project profitability.
- Petty cash requires editable accounts/floats and transactional history. Changes must preserve the ledger/audit trail.

## Commercial and project decisions

- Progress claims must retain the client-approved document as an attachment/proof and support a generated payment-request letter.
- The payment-request letter signatory is the user who prints/generates it; their name and role come from the database.
- Interim payment application tables must retain the client-provided heading terminology; do not casually rename columns.
- BOQ/import parsers must handle varied spreadsheets defensively, provide understandable errors and a review/edit step rather than assume one template shape.
- A cost line may link to multiple completed tasks. Completion can be recorded inline when no existing task exists; all links must persist without posting the cost twice.

## People, leave and attendance decisions

- Leave limits are advisory warnings, not a hard block: users may record leave beyond annual entitlement after seeing the warning.
- Sunday is ordinarily non-working, but authorized manual attendance must still be recordable for Sunday work.
- Office tasks must be assignable without requiring a project.
- Attendance issues must be reproducible from the actual employee/date/times before changing payroll logic. Missing attendance must not be silently fabricated.

## Fleet and maintenance decisions

- Fleet assets may exist without an assigned driver.
- Maintenance plans are configurable by asset/type and support kilometre or hour-meter intervals, reminders, inspections, defects, costs and approval before return to service.
- Manufacturer manuals decide final vehicle/equipment service intervals; generic schedules are preliminary defaults only.

## UX decisions

- Reuse the established visual system. Forms, tables and cards need visible spacing and consistent action button styling.
- Related actions belong in their corresponding section. For example, “Issue cheque” belongs in the Finance-issued-cheques header, parallel to “Receive cheque” in received cheques.
- Avoid a UI that only displays results without a route to correct or review them. Operational imports should expose rows for review before final submission.

## Deferred or unresolved work

- Historical client/project/BOQ Excel import files were deliberately deferred pending revised source workbooks. Do not import them based on earlier preflight analysis without a new user request and fresh validation.
- Contabo S3 migration must be verified with the actual server environment and provider credentials. A successful connection diagnostic does not prove production uploads/permissions are correct.
- Full backend suite may include older date-sensitive tests. Report focused validation and any broader failures separately; never call the whole suite green without running it.

## 2026-11-02 — client invoice presentation

- Use the supplied invoice body format while preserving the system's current letterhead and its saved company address (the user explicitly selected the saved address rather than the PDF's address).
- Always print a purchaser TIN field. If the saved invoice snapshot has no TIN, leave a dotted space for handwriting; never invent a tax identifier.
- New invoices start with Reference, Description and Amount columns. Unit, Quantity and Rate remain selectable and persist per invoice; existing saved selections remain intact. Financial calculations and saved invoice amounts do not change.

## 2026-11-02 — optional invoice recipient

- Company-level invoices may be created without selecting or creating a client. Keep purchaser fields blank and provide dotted write-in spaces on the print; do not invent a client identity.
- Company ownership, pricing and tax rules still apply. Previous paid-invoice credits require a saved client so unnamed purchasers are never treated as the same billing account.

## 2026-11-03 — employee-specific HR daily pay agreements

- Effective from 2026-01-01, HR may explicitly assign the actual Sunil employee a Bass/Gola daily-work method (3,000/2,500, eight hours); one work type per date, selected by HR, without a supervisor approval step. Missing choices block payroll.
- The operator uses meter hours × 650 with a 1,800 minimum, or non-machine attendance hours × 225 capped at eight; transport is 300 per attended day including partial days/Sundays. Machine days have no OT; Standby days receive normal labour Site OT from 30 minutes at the effective company rate. No late deduction on either type. More-than-25-day Machine work pays fixed 1,800 × 1.5 basic rather than adding it to meter pay. Calendar months apply; 45,000 is not a second salary.
- Special EPF is currently off as instructed; ETF and other staff contribution settings remain unchanged. No automatic employee-name matching or live rule assignment. HR saves effective profiles and daily evidence explicitly. Approved/Paid salary snapshots never change when those inputs are corrected.

## 2026-11-03 — operator OT clarification

The user's follow-up supersedes blanket operator OT exclusion: machine-operating days have no OT, while HR-recorded Standby days receive normal labour Site OT from 30 minutes, using the dated company rate. No operator late deductions; no Office/Travel OT extension. Daily work choices remain authoritative, reviewed OT replaces automatic OT, and saved approved/paid payroll is unchanged.


## 2026-11-03 — Shared online desktop and browser behavior

Use Electron with the existing bundled React interface and the same HTTPS API, database
and live stream. Do not duplicate payroll/business logic or connect desktop clients
directly to MySQL. The user supplied https://staff.gkucconstruction.com as the default
server. Keep the browser available for low-performance machines. No offline business
writes, automatic updater, guaranteed zero lag or production deployment is included.
Connection changes restart/sign out. New releases must be checked against deployed
API contracts. See [DESKTOP.md](DESKTOP.md) for unsigned-package and verification limits.

## 2026-11-03 — desktop interoperability after manual QA

Keep portable QR/share links on the selected online origin, never `siteops://app`.
Use network-origin, short-lived ticket URLs for native desktop PDF viewing while keeping
renderer sandboxing, TLS verification and origin restrictions. Use the same in-app text
prompt in both clients; reason/name entry must not depend on Electron's unsupported
native prompt. Cancellation must stop a pending decision. Manual checks and automated
coverage remain separate; the seven full-suite failures and untested Windows runtime
prevent an unconditional production-readiness claim. See MANUAL_QA.md and DEPLOYMENT.md.

## 2026-11-04 — remember desktop sign-in and mandatory document attribution

Per user request, remember desktop sign-in on the device using OS-encrypted opaque
sessions, not saved passwords or browser localStorage. Use a revocable 30-day server
session for remembered logins; preserve the 12-hour browser default. Restore before
bootstrap and clear on logout, invalidation or connection change. No offline access
or authorization bypass is introduced. Every generated document ends with Developed
by Infinity AI (Pvt) Ltd, Sri Lanka; payslips repeat it on each printed page. Keep
this credit separate from editable company footer settings and historical salary data.

## 2026-11-04 — approved tasks may be corrected by management

User explicitly requested changing approved task statuses as well. Supersede the
previous task lock: management with task-update permission may choose any other
status with a required reason. Clear the current approver, retain approval and
change history, and require Completed before reapproval. Staff without management
permission cannot change approved task status. Payroll approval locks are unaffected.

## 2026-11-04 — quotation alternatives and document visibility

Allow independent quotations for the same work to use the same client-facing printed
number. Keep each record traceable by its existing ID/reference; do not renumber
financial links or relax invoice reference uniqueness. Users choose printed fields
per document in QS/Finance. Hiding totals also suppresses words/category summaries;
hiding printed values never changes saved calculations, budgets, VAT ledgers or
payments. Keep Infinity AI attribution mandatory. Revisions inherit presentation
choices but remain independently reviewable snapshots.

## 2026-11-05 — reviewed bond Excel imports

Bond imports can create and update within one selected company. Match existing records
by internal system reference, falling back to bond number plus bank only when no
reference is supplied; ambiguous/missing references require a manual target decision.
Never guess from amount, project or beneficiary. Upload stores a review draft only.
Require per-row verification; editing clears it. Final submit revalidates in one
transaction with snapshot/duplicate checks. Imported updates preserve reference and
extension history, and do not create extension events or accounting entries.
See [Bond import](BOND_IMPORT.md) for workflow and supported workbook contract.

## 2026-11-05 — source-key relationships in historical templates

Treat supplied client/project/BOQ IDs as external source keys, never native SQL IDs.
Import parent registers before dependent workbooks and persist audited key-to-record
links. Include Contacts and Project Team instead of rejecting populated related sheets.
Source employee codes require exact/manual matching, and source key mismatches require
explicit correction. Financial line/header discrepancies block confirmation. Imported
BOQs remain Draft; original approval/version/reference metadata is retained separately.
Repeat keys skip and do not overwrite live records. See HISTORICAL_IMPORTS.md.

## 2026-11-05 — optional end dates, recurring deadline cycles and extensions

Keep end dates optional and mutable through controlled date entry. A later end date
requires a reasoned, append-only extension and saved printable request letter. Saving
an extension updates the internal target immediately; it does not assert client approval.
Notify every active account daily from one calendar month before the latest target,
including overdue days, until completion/inactivity or a revised reminder window.
Reminders are deliveries rather than escalation cases. Keep historical letters intact;
show Completed ahead of Extended and keep normal operational stage/health independent.
See PROJECT_DEADLINES.md.

## 2026-11-05 — editable PO, recognition after goods/invoice confirmation

User confirmed that saving the PO is not an expense/debt trigger. Keep purchase commitments
separate from actual receipts, invoices and payments. Permit explicit manual line amounts
and editable printed fields/numbers, with reasoned revision history. Preserve recorded
receipt valuation and original invoice approval snapshots; a revised PO never silently
changes posted expenses/payments/outstanding. Retain approval/role/risk controls for new
commitments and physical quantity/history constraints. See PURCHASE_ORDERS.md.

## 2026-11-06 — role-independent temporary feature pause

Temporarily disable Petty cash, Bonds, Expenses, QS BOQs and client Invoices for every
user, including owners and administrators. Enforce access before the business routes,
including record/PDF/import paths; hiding navigation alone is insufficient. Preserve
records and grants. Keep unrelated modules and aggregate reporting available. Restore
through the shared pause list and matching frontend/backend deployment, without DB edits.
See TEMPORARY_FEATURE_PAUSE.md.

## 2026-11-06 — allow paused page entry with configured error copy

User revised the temporary pause presentation: keep pages clickable, replace operational
content with “Error in local machine”, “Error in windows operating system” and a solution
asking the administrator to install separate drivers. Preserve server operation blocks
for all roles. This copy is explicitly simulated/configured, not a technical diagnosis;
actual restoration still requires removing the configured pause, not installing drivers.

## 2026-11-06 — remove temporary restrictions and simulated errors

User requested removal of all fake errors and restoration of hidden functionality.
Delete the temporary pause layer rather than retaining dormant OS/driver copy.
Restore the existing persistent workflows, detailed data and imports under their normal
permissions. Preserve genuine operational errors and authorization checks. No database
or payroll-policy changes are needed. This supersedes the temporary pause decisions above.

## 2026-11-09 — supplier invoices across companies in issued cheques

User explicitly requested showing all supplier invoices while issuing a cheque regardless
of the Construction/Readymix filter. Permit same-supplier allocations across both companies.
Keep the selected company as payer and the original company on each invoice; record payer
on cleared supplier payments for cash reporting. Preserve reservations, exact allocation,
reasoned reductions and clear-once behavior. Do not infer an intercompany journal or alter
other company filters from this exception.

## 2026-11-09 — show petty-cash funding in Expenses without duplicate costs

User requested that Add money appear automatically on Expenses with no double entry.
Display existing Top up records in a separate funding table on that page, including all
account types and opening funding. Funding stays an internal transfer, excluded from
expense/profit/cash-out totals; actual spending is recognised once through existing paths.
Do not insert a second expense row merely to display the funding.


## 2026-11-09 — operator attendance optional only for saved Machine work

User confirmed Machine operator meter entries may count as worked payroll dates without
attendance. Apply to the dated pay method, not employee name/title. Without attendance
or Machine input the operator is absent/unpaid; Standby still requires attendance.
Use payroll-only evidence with source IDs, never create artificial clock records.
Conflicting explicit absence/leave requires review. Preserve approved leave, existing
rates/premiums/transport and immutable Approved/Paid payroll.

## 2026-11-09 — manual outflow worksheet, bank amount and PDF

User explicitly requires display/planning only: saving planned amounts or the manual
bank balance never creates actual expenses, income, payments or account balances.
Cash outflow table is manual standalone planning, supports multiple rows in one save,
and remains separate from automatically read Receivables and Outstanding. Interpret
Outstanding as supplier invoices plus operating bills. The later clarification limits
From/To filtering to cash-outflow rows; all current unpaid receivable/payable balances
are shown irrespective of dates, after all saved payments. PDF shows the selected
dates without notes or headings explaining selective filter scope; retain the
mandatory Infinity AI developer credit. Bank balance is remembered for the exact company/date range,
not treated as verified cash. Preserve existing finance records and legacy schedules.

## 2026-11-09 — bond titles and project choices

Show project/tender name as the primary bond list identity, actual bank bond number
below. Hide system/import reference from the list title while preserving it internally
and in search/history/import contracts. Fix project-company field compatibility and
provide minimal project choices to bond writers, without cross-company linking.

## 2026-11-09 — expose the existing QS Retention workspace in Finance

User requires the same page, operations, view and records in both modules. Reuse one
shared component and the existing QS retention API/table. Finance managers may add and
release through that same workflow; Finance viewers remain read-only. Never mirror,
copy or automatically insert a second retention merely because it is viewed in Finance.

## 2026-11-09 — BOQ taxes and other deductions

User requested tax rates and arbitrary deduction rates/fixed amounts during BOQ creation
and recognition from uploaded rows/fields/sheets. Persist labelled Add/Deduct entries,
Percent or Amount, with all percentages explicitly based on work subtotal. Do not assume
VAT or cascade taxes silently. Recognised source rows are editable proposals requiring
saved confirmation; preserve originals and prevent counting a summary as priced work too.
Existing approval remains the budget update event; BOQ pricing does not create a second
VAT, payment or retention ledger entry. Keep legacy/no-adjustment BOQs unchanged.
