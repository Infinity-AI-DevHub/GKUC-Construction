# Missing Checkout Warnings

Updated 2026-10-24.

Employee attendance history highlights worked records with a check-in and no checkout.
The dashboard's My work today warning counts overdue affected employees once, alongside
the number of unresolved attendance records. Historical days are overdue. Current-day
records become overdue after the selected company's effective normal workday end,
using Asia/Colombo time (16:30 fallback). Future days are excluded.

Absent, On leave and Business trip rows are excluded. Out-only rows are not a missing
checkout. Deactivated and Left employees are not included in the dashboard warning.
Legacy name-only attendance matches only a unique visible employee name.

Counts and paged details use the employee's payroll company, not an arbitrary currently
assigned project. HR view, manage or attendance permission is required; other users get
no warning details or counts. Corrections require hr.manage or hr.attendance and use the
existing audited attendance correction endpoint and mandatory reason. Payroll is not
recalculated automatically. The warning refreshes after corrections/data changes and
each minute while an authorized user's dashboard is open.

No schema migration, fabricated checkout times or automatic attendance edits are made.
