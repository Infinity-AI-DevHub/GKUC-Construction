# VAT Ledger Creation and Manual Entries

Updated 2026-10-24.

Finance users with finance.vatSchedules can create a company-specific VAT period from
Finance > VAT ledger > Create VAT ledger. Saved periods are selectable from the same
page. Existing reconciliation saves remain supported. New periods cannot overlap a
saved period for the same company; different companies have independent periods.

Add VAT entry records an Input or Output document with its date, reference,
counterparty, optional VAT registration number, taxable base, user-supplied VAT rate
and notes. The server calculates rounded VAT and total. Entries appear in schedules,
reconciliation totals and Excel exports. They do not create income, costs or payments.

The selected period must exist and contain the document date. Filed periods reject
manual additions and reconciliation edits. A new entry to a Reconciled period resets
that period to Draft. Creation, entry additions and reconciliation writes share a
company lock. Exact/manual duplicate references are rejected; references already in
automatic source ledgers cannot be added as manual VAT again.

Entries in vat_manual_entries are company/date scoped and audited. Schema creation is
additive; existing invoices, incomes, expenses and historical VAT records are retained.
Deploy backend and frontend together and restart the backend before using the controls.
VAT eligibility and rate selection remain the Finance user's responsibility.
