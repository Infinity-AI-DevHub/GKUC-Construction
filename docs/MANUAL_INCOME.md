# Manual Income and Other Receipts

Updated 2026-10-24.

Finance > Income supports a real project or Other (no project). Other receipts belong
to the selected company with a null project ID; no placeholder project is created.
Project/company mismatches are rejected. Duplicate checks lock the project, or the
company for Other receipts, and keep the companies separate.
Selecting Other displays a required Income source field (up to 180 characters).
The source is stored separately from the description, shown in the income ledger,
and preserved when an Other cheque clears. Historical entries are not rewritten.

Do not track VAT is the default. The server forces VAT rate and amount to zero
even if a stale client submits a rate. No other tax is automatically applied.
Calculate and track VAT requires the user to supply the rate; VAT is calculated on
the entered base amount. Untracked amounts are never treated as VAT-inclusive and
VAT is never extracted from them. The server stores rounded net, VAT and total; financial cash
totals use the actual total receipt. No statutory rate is inferred by the application.

Manual taxable receipts enter the output VAT schedule on the receipt date. Invoice
receipts remain represented by their original invoices, not a second taxable receipt.
Non-taxable manual receipts are excluded from that output schedule. This classification
records the user's choice; it does not determine legal tax eligibility.

Cheque receipts, including Other, remain in received_cheques until cleared. Clearing
copies the saved tax amounts once to the income ledger. Invoice-linked cheques retain
the invoice's tax calculation and cannot supply an additional VAT calculation.

Startup migration adds tax metadata with safe defaults; existing amounts and source
records are not recalculated. Historical net amounts fall back to the recorded total.
Deploy backend and frontend together and restart the backend to apply schema additions.
