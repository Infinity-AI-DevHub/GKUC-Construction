# One supplier cheque for multiple invoices

Finance → Cheques → Issue cheque now accepts multiple invoices from the chosen supplier
and operating company. The searchable checklist shows each available unpaid balance and
any amount already covered by a pending cheque. Selecting invoices automatically fills
the amount with their combined available balances; it does not add already-paid amounts.

The amount remains editable. Any difference from the calculated total requires a reason,
validated in both the browser and server and retained with the cheque and audit entry.
The amount cannot exceed the selected available balances. A lower amount is a partial
payment: it is allocated to the oldest invoice date first, then invoice ID for ties.
The form previews the split, including any selected invoice receiving zero in this cheque.
The unpaid remainder stays outstanding; a reason is not an invoice discount or write-off.
Choose **Use calculated total** to restore the automatic amount.

The issued register and confirmation dialog show all selected invoice references, their
allocations and any amount-change reason. Supplier statements show a pending cheque once,
with all its invoice references. Issuing a cheque does not mark invoices paid. Confirming
Cleared pays each positive allocation in one transaction; repeated clearance cannot post
payments twice. If any invoice balance has become insufficient, the whole clearance rolls
back so none is partly applied. Returned/cancelled/replaced cheques release their pending
coverage. Reactivating a returned cheque revalidates the available invoice balances.

Open Prepared/Issued cheques reserve their allocations against another cheque selection.
Expected outflows subtract each allocation from its invoice and include the cheque amount
once, so one payment is not forecast multiple times. Payments made through another route
can still change invoice balances; refresh the selection before writing a new cheque and
resolve any clearance conflict rather than silently redistributing an already-written one.

## Storage and compatibility

Startup adds issued_cheques.invoice_total and amount_override_reason, and creates
issued_cheque_invoices containing selected invoice IDs, invoice-number snapshots,
allocated amounts and available-balance snapshots. Existing single-invoice cheques are
backfilled idempotently without creating new payments or changing cheque status. Their
historical selected balance and override reason remain unknown rather than being invented.
New single-invoice cheques retain invoice_id for compatibility; multi-invoice cheques use
the allocation table. The API still accepts the legacy invoiceId input, and existing
unlinked/general cheque payments remain supported. A changed calculated amount on a new
invoice-linked cheque requires a reason, including requests using the legacy input.

POST /purchasing/cheques accepts invoiceIds, expectedInvoiceTotal and amountOverrideReason.
It rejects duplicate IDs, mixed suppliers/companies, fully paid/reserved invoice selections,
stale totals, overpayments and unexplained overrides. Invoice locks serialize allocation
creation; clearing and invoice/payment updates are atomic. The original cheque number,
bank, payee, purpose and future-date reminder behavior remain in place.

Deploy backend and frontend together, rebuild the frontend and restart the backend so
startup adds the allocation table before the updated interface is used. Tests cover full
and partial allocation, reason enforcement, scope validation, reserved balances, forecast
and statement totals, clearance rollback, concurrent repeated clearance, and the existing
single-invoice flow. A browser check also selects multiple invoices, verifies automatic
amounts and partial allocations, and confirms the submitted override reason.
