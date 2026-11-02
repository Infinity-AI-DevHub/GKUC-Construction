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
