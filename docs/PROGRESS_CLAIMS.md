# Progress claims and versioned valuation BOQs

## Printable QS Documents (2026-10-26)

QS > Progress claims prepares full interim payment applications and payment-request letters. Prepare or copy a valuation BOQ, approve its basis, then choose New interim application. Draft authoring includes a printed bill number, project reference, recipient title/organisation/address, salutation, subject, letter wording and signatory/designation. Details are saved with the application and locked on submission. Existing records without these fields still print using standard wording.

Valuation lines support Quantity, Percentage and Note. For percentage-valued provisional or lump sums, BOQ quantity is 1 and the rate is the complete approved sum; enter completion as a percentage. Thus 80% of LKR 50,000 is LKR 40,000. Previous certified value is subtracted to determine this application's amount. Note rows print explanatory text but have no monetary value. Certification and payment logic are unchanged.

The register and application detail provide Print application and Print letter controls. Requests authenticate, resolve local branding, wait for assets, then open the browser print dialog. Application PDF and Covering letter provide PDF preview/download. Applications use landscape A4 grouped BOQ/previous/this/cumulative columns; letters use portrait company stationery. Drafts are marked. Creating or printing documents does not create invoices or income.

Backend startup adds nullable `progress_claims.document_details` JSON without rewriting existing records. Deploy backend and frontend together. Local verification covers persistence, permissions, submission locks, escaped text, percentage calculations, mobile/desktop forms, print controls, PDF generation and rendered pages. No production deployment performed.

## Entry Points

Quantity Surveying > Progress claims is for QS preparation and approval.
Finance > Money in > Progress claims is for client certification, optional invoice
documents and receipts. Both views show the same records. Existing quotation and
invoice routes are unchanged for other projects.

## Valuation Basis

Choose a project and create a valuation BOQ. Source is QS prepared or Client
supplied. Award/contract reference is optional; absence is not treated as an award.
Enter measured items or lump sums (unit sum, quantity 1), or copy an existing
project BOQ. This is a commercial valuation snapshot, not an automatic rewrite
of the cost-control budget or the original BOQ.

Save Draft, approve internally with a reference, then optionally record Client
agreed with its supporting reference. An internally approved valuation may be
used before client agreement, but the application clearly retains that status.
Drafts are editable; approved versions require a new version and revision reason.
The latest unused version can be deleted with a reason and confirmation. QS BOQ
permission is required, plus QS approval permission if already approved. Any
application reference, even withdrawn, blocks deletion. The complete deleted
record is preserved in audit. Removing the final unused version returns the
project to Quotation and invoice billing without changing any financial records.
Previously certified item codes/rates must remain. Use new variation item codes
for revised pricing and keep original certified quantities. New items and revised
unclaimed quantities can be included in the next approved version.

## Applications

Enter period and application dates plus cumulative completed quantities. The
system calculates Previous, This and Cumulative from the latest certified
quantities, not previous applications or payments. Drafts can be edited. Submit
or withdraw with a reason; submitted applications cannot be rewritten. Complete
or withdraw the one pending application before preparing a revision/new claim.
Periods may cover cumulative work, but the valuation cutoff cannot move backwards.
Only the additional value since the last certificate is claimed. Applications store BOQ, approval
and valuation snapshots so later agreement/revisions do not rewrite them.

Generate application and covering-letter PDFs from the application record.
Documents distinguish internal approval from client agreement and mark drafts.

## Certification and Money

A finance.invoice user records client certificate reference/date, independently
certified cumulative quantities, due date, retention, advance recovery, other
recoveries, applicable VAT rate/basis, stamp duty and a supporting explanation.
Certified quantities cannot exceed submitted quantities. VAT basis is explicitly
Gross or After recoveries; stamp duty is deducted after VAT. This is configuration,
not a determination of statutory treatment. Finance must verify the actual
contract/client certificate and applicable tax requirements. Filed VAT periods
cannot receive new taxable certificates through this workflow.

Certification creates exactly one issued Payment Certificate in client_invoices,
using the existing receivable, receipt, income, cheque and reporting mechanisms.
Retention creates one entry in the retention register with an explicit release
date. Claimed, certified payable, received and outstanding amounts stay separate.
The generated certificate PDF is a record of the entered client certification;
it does not replace the client's signed original.

An optional invoice gets a separate document reference linked to that same
receivable. It creates no second balance, VAT entry, retention or income. Its
financial date remains the recorded certificate date; reference issuance is
audited separately. Existing invoices/payment receipts remain linked by ID.
Record partial payments normally; receive/clear cheques through the existing
Received cheques workflow against the certificate receivable. Generic invoice
creation is blocked for progress-claim projects to prevent duplicate billing.

## Safety and Deployment

Permissions: qs.view read; qs.boq prepare/edit/submit; qs.approve valuation
approval; finance.view read; finance.invoice certify, optional invoice, receipts.
All mutations are transactional and audited. Company scope follows the project.
Project locks serialize applications and certification; only one certificate and
one optional invoice are allowed per application. No production data was changed.

Additive schema: projects.billing_route, progress_schedules, progress_claims,
client_invoices.taxable_base and Payment Certificate document type. Existing
projects keep Quotation and invoice by default. Creating a valuation BOQ selects
Progress claims for that project. Projects with existing non-cancelled invoice
history cannot be converted automatically: opening certified quantities and
balances must first be reconciled through an explicitly planned migration.
This implementation does not backfill those opening balances or reinterpret
historical documents. Deploy backend/schema initialization and frontend together.
