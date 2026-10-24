# Bond records

Finance > Controls > Bonds permits users with finance.invoice to create, edit,
extend and delete bonds. Bond numbers are optional at creation and may be added
later with Edit. The system reference remains unchanged. Editing preserves bond
status, release date and extension records, and saves before/after audit details.
The form retains zero-day reminder settings and restricts projects to the company.

PUT /receivables/bonds/:id updates the full editable details with calendar-date,
amount, company and project validation. Existing PATCH status and POST extension
workflows remain available. No schema migration is required.

Deletion requires confirmation in the UI. DELETE /receivables/bonds/:id records
the complete bond and extension history in the audit log in the same transaction
as removing the register record. Associated extension rows cascade; independent
expense/payment records are untouched. Deleted bonds no longer contribute to
bond reports or expiry warnings. Deletion does not cancel a guarantee at the bank.

Changes are local until deployed; no production records were edited or deleted.
