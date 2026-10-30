# Client invoice columns and cumulative bills

Finance → Invoices supports invoice-specific presentation and optional deductions of
previously settled invoices. No existing financial records are rewritten on deployment.

## Columns

In Create invoice, select Unit, Quantity and Rate independently. Description and Amount
always appear. Hide Quantity and Rate together to enter manual lump-sum amounts directly.
These choices control this invoice's preview and PDF, including the totals' column spans.

Use **Invoice columns** on an existing invoice to change these choices later, including
issued or paid invoices. The change is audited and cannot change amounts, issue status,
recorded receipts or cumulative invoice links. Old invoices default to all three columns.
Quotation-term invoices can use this action after their draft has been created.

## Deducting previous invoices

Enter the **total work to date** using manual work lines. Under **Deduct previously paid
invoices**, select the fully paid invoices for the same company, client and project (or
same client with no project). Leave this section empty for an ordinary incremental bill.
Selected invoices must precede the new invoice date and use the same VAT rate and tax
treatment. BOQ/quotation-linked rows and billing terms cannot be combined with cumulative
deductions because those workflows already track quantities or allocate billing terms.
Projects billed through Progress claims continue using that separate workflow.

The preview and PDF show the full cumulative work, tax and deductions, followed by a
separate `Less paid invoice <reference>` row for each prior invoice, and the new amount
payable. Enter cumulative retention and recoveries too; the server rejects reversals of
previously billed amounts and requires a positive new balance. A prior cumulative
invoice automatically includes its paid predecessors; each predecessor is counted once,
even if also selected explicitly. Sources are validated inside the creation transaction.
The stored snapshot keeps references and amounts stable if document numbers change later.

Example without VAT: total work to date LKR 150,000, previously paid invoice LKR 50,000,
new amount payable LKR 100,000. No receipt or income is created for the previous LKR
50,000 again. Receive the new LKR 100,000 against the new invoice in the normal way.

## Data and reports

Startup adds nullable JSON `client_invoices.invoice_options` idempotently. It holds column
choices, prior paid-invoice snapshots and cumulative totals for the printed document.
Normal invoices retain their existing representation. For a cumulative invoice, ledger
columns (`gross`, `vat_amount`, `retention_amount`, `advance_recovery`, `other_deductions`)
contain only the increments over all credited predecessors; `net_payable` is the new
balance. Line amounts and the JSON cumulative totals represent the full work to date.
This keeps receivables, VAT schedules and retention totals from counting old amounts again.
The existing VAT report uses gross when taxable_base is null, so no report-specific change
is required. `paid_amount` and receipt history refer only to new money against this invoice.

`GET /receivables/paid-invoices` scopes the selectable sources by company, client and
project independently of the recent invoice register's 300-row limit.
`PUT /receivables/invoices/:id/columns` requires `finance.invoice` and changes only columns.
Creation and preview accept `columns` and `previousInvoiceIds`; totals are recalculated on
the server. Hidden columns never suppress validation or change linked source prices.

Deploy the backend and frontend together, rebuild the frontend and restart the backend
so the schema addition runs before using the controls. Tests cover all eight column
combinations, source validation, ancestry, incremental totals, full invoice creation,
receipts and PDF/HTML output.
