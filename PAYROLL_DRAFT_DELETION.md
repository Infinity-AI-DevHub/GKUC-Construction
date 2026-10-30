# Delete a draft and rerun its dates

Draft deletion uses a transaction and physically deletes the payroll run, its payslips, generated pay components, project allocations and salary-advance recovery links. Employee profiles, original salary advances, petty cash, attendance, OT, leave and source claims remain. The complete generated snapshot is retained in the audit log. A status-qualified final deletion must affect exactly one run or the transaction rolls back. Approved and paid runs remain protected.

The current local code already supported this hard-deletion flow. This update fixes the payroll list failing to reload on company changes and ignores delayed responses belonging to a previous company selection. The delete confirmation explains which records are removed and that the same dates can be used again. Deleting one company does not delete a second company's run.

Overlap errors now identify the actual blocking run reference, company, frequency, dates and status. The employee-level protection also names the employee and their conflicting payroll, including when the company or frequency has changed. Do not bypass this protection: delete only the identified Draft or review the approved/paid record. Exact existing draft dates can be recalculated directly.

Tests cover draft rebuild/deletion, unauthorised and approved/paid deletion rejection, source preservation, company batch rollback, deleting one/both drafts and rerunning identical dates, plus a browser check for company switching and stale-response protection. No database migration is needed for this update. Production causes remain unverified until the deployed code and the named conflicting runs are inspected.
