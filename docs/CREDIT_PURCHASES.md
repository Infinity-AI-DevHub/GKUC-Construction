# Credit purchases and dashboard reminders

Finance > Money out > Credit purchases > Record credit purchase.
Enter the items, invoice reference,
supplier, amount, payment due date, first reminder date, frequency and recipients.
Existing credit records appear here automatically. The Supplier invoices page
shows other supplier invoices. Both pages use the same underlying liabilities,
so balances, statements, payment approvals and reminders remain unchanged.
An active supplier must already exist in the supplier register.

Credit purchases use the existing supplier invoice liability, supplier statements,
expected outflows and payment controls. Recording credit does not record a cash
payment. No duplicate expense or second liability is created. Existing invoices
are unchanged. Purchases without a purchase order still require independent
payment-exception approval before payment.

The additive supplier_credit_reminders and supplier_credit_reminder_users tables
are created by normal backend schema initialization. Creation and audit are atomic.
Recipients must be active users. Reminder information is intentionally disclosed
to the selected recipients even when they cannot access the Finance workspace;
selection does not grant Finance access or payment permissions.

Warnings appear in My work today for the selected operating company on/after the
first reminder date, using Sri Lanka dates. They remain until acknowledged and
refresh every minute while the dashboard is open. Each recipient acknowledges
independently. Once clears permanently; Daily/Weekly/Monthly schedules the next
warning one day/week/calendar month from acknowledgement. An overdue warning
does not disappear just because its recurrence date passed. Payment due date is
shown separately from the reminder date. Partial payments reduce the displayed
balance; full payment suppresses all warnings. Acknowledgement never pays a debt.

These are in-app reminders, not email or WhatsApp delivery. Production must receive
the updated backend/frontend and normal additive schema initialization; no
production database was modified during development.
