# Temporary feature pause — removed 2026-11-06

The earlier temporary restriction and simulated local-machine/Windows/driver errors
have been removed at the user's request. HR, Petty cash, Bonds, Expenses, QS BOQs and
Invoices now use their normal pages, APIs, forms, imports and document workflows.
The dashboard's configured OS warning has also been removed.

The shared pause configuration, middleware and notice component were deleted, along
with detailed-data suppression in bootstrap, projects and clients. Ordinary role,
company, validation and audit controls remain. No database migration, policy write or
historical-record recalculation is required. Earlier PROGRESS.md entries retain the
history of the temporary restriction; this document supersedes its restoration steps.

Apply the updated backend and frontend together through the normal authorized release
process. Existing desktop installers contain their previous frontend bundle and need
a separate rebuild/distribution to receive the restored UI. Local source/build checks
do not establish production deployment or live-system availability.
