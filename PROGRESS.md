# GKUC SiteOps progress log

This file is append-only. Every material implementation, investigation, decision, data migration, deployment, test result or unresolved issue must receive a new dated entry. Do not rewrite historical entries. Link to the responsible code and documentation.

## Entry template

```md
## YYYY-MM-DD — concise title

- Decision / request:
- Changed:
- Data or deployment action:
- Validation:
- Open items / limits:
```

## 2026-11-02 — payroll rules made explicit and editable

- Decision / request: Replace inconsistent manual payroll treatment with transparent dated rules effective 2026-01-01. Keep OT and late independent. Apply the same rule values to GKUC Construction and GKUC Readymix, while retaining company-scoped policies and payroll runs.
- Changed: Added exact-minute OT, category/type 30/31-minute thresholds, 07:00 morning-OT cutoff, category-based late rates, a 15-minute late grace, actual-hours short-day pay, monthly 25-day 1.5× basic-rate premium, policy editing API/UI, and focused tests.
- Data or deployment action: No production policy or payroll was written in this repository session. After deployment, save a dated policy for each company through People → Payroll settings using the 2026-01-01 default.
- Validation: `node --test test/hr-payroll-rules.test.js test/attendance-payroll.test.js` from `backend/` passed. `npm run build --prefix frontend` passed.
- Open items / limits: The companies have matching values but remain separate effective-dated policies. Confirm any future requirement to centralize them into one shared policy record before changing data ownership.

## 2026-11-02 — durable agent documentation and handoff rules

- Decision / request: A new AI agent must be able to safely understand the architecture, durable product decisions, payroll specification and documentation workflow without relying on chat history.
- Changed: Added root `AGENTS.md`, tool-specific entrypoints for Codex/OpenAI/Claude/Cursor, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and `docs/PAYROLL.md`. The root instructions require a documentation update and a new append-only progress entry with every material change.
- Data or deployment action: Documentation-only change; no application database or production service was changed.
- Validation: Verified tracked-exception paths, repository status and whitespace with `git diff --check`.
- Open items / limits: Generated documents under `docs/` remain ignored. Only the three hand-authored Markdown guides are tracked exceptions.

## 2026-11-02 — multiple renewal types when adding a fleet asset

- Decision / request: Allow several renewal types, each with a separate due date, while creating one fleet asset.
- Changed: Added repeatable renewal rows with Add/Remove actions and responsive layout. Creation validates distinct supported renewal types, persists all document/current-expiry and renewal-history records atomically, and chooses the earliest submitted expiry for the asset summary. Existing single-renewal requests continue to work. Generic PATCH cannot bypass the dated renewal workflow. Creation audit includes the renewal list. No schema change required.
- Data or deployment action: No deployment, live database writes or production restart. API verification used only the local temporary `gkuc_siteops_test` database.
- Validation: Node 20 focused API tests (`fleet creation saves multiple renewal types` and `fleet histories preserve`) passed: 2 passed, 155 skipped by name filter. Frontend production build passed; `git diff --check` passed.
- Open items / limits: Full backend suite and interactive browser review were not run. The asset summary selects the earliest submitted renewal at creation; later renewals retain the existing dated-document behavior.

## 2026-11-02 — optional fuel float and litres

- Decision / request: Remove required validation for Fuel Float and Litres in Record fuel.
- Changed: Made both fields optional in the form and API. Blank litres persist as NULL through a guarded nullable-column migration; supplied quantities must remain positive and within the existing limit. Without a float, the selected company owns the fuel/odometer records and project costs still post, with no petty cash movement. Selected floats retain balance and company validation. Updated form guidance, unknown-quantity display and efficiency handling.
- Data or deployment action: No deployment, production restart or live database writes. Verification used the local temporary test database only.
- Validation: Node 20 focused API tests passed (3 passed, 155 skipped): optional fields, existing float accounting/balance/concurrency, and fleet histories. Frontend production build passed. `git diff --check` passed.
- Open items / limits: Full suite and interactive browser review were not run. No-float records are costs, not recorded petty cash payments, and do not enter the daily payment report. Aggregate litres include known quantities only.

## 2026-11-02 — reference-style invoices with optional priced columns

- Decision / request: Match the supplied `1164 new.pdf` invoice body, retain the system letterhead, use the saved company address, show a dotted purchaser-TIN field when missing, and let users opt into Quantity and Rate.
- Changed: Updated shared invoice preview/PDF layout with boxed date/reference, supplier/purchaser details, delivery/supply fields, additional information, reference/description/amount table and payment mode below amount in words. Missing TIN has a writable dotted placeholder; existing TIN snapshots print unchanged. Saved company address is shown in letterhead details. New forms/API creation default optional columns off; existing column settings and legacy fallback are preserved. Totals, deductions and cumulative invoice credits keep existing calculations.
- Data or deployment action: No deployment, production restart or live database writes. Only temporary test database writes occurred. A read-only attempt to load local document context found no `document_settings` table, so visual QA used clearly marked sample company data; no migration/startup was run against the application database.
- Validation: Focused invoice-options/document-layout tests, filtered invoice column/cumulative API test, frontend production build and whitespace check; final results recorded below. Rendered the updated one-page sample with the application's PDF renderer and inspected its PNG; tests also cover long-document pagination.
- Open items / limits: Production saved address/design was not available for local visual verification. Actual printing uses the existing saved company context. Full API suite and interactive UI review were not run. The existing system footer, signature, bank/terms settings and accounting deductions are retained.
- Final validation results: 14/14 invoice-options and document-layout tests passed, including rendered long-invoice pagination; filtered invoice API test passed (1 passed, 157 skipped), including new default-column persistence and later column changes. Frontend build passed. Final sample PDF visually inspected with no clipping/overlap; `git diff --check` passed. Pagination assertion now checks the VAT-inclusive final total when no separate net-payable row is needed.

## 2026-11-02 — create a saved client from invoice entry

- Decision / request: Allow a client who is not yet saved to be added directly while choosing the invoice recipient.
- Changed: Added Add new client beside the invoice client selector, reusing the existing Client Directory form and persistence API. Saved clients are added to the list and selected automatically; cancelling leaves the invoice intact. The workflow stays mounted, preserving entered invoice fields/manual work. When the recipient changes to the new client, old project, credits and project-linked lines are cleared. Initial list loading cannot overwrite newly created clients. Invoice writers can list/create clients through server permissions; client edit/archive/delete permissions remain unchanged. Modal layering supports opening the client form above the invoice workflow.
- Data or deployment action: Local code only; no deployment or live database writes. API checks use the temporary local test database.
- Validation: Focused API and frontend build results recorded below.
- Open items / limits: No full API suite or interactive browser review. Creating a client saves it independently, so it remains in Client Directory if the invoice is later cancelled.
- Final validation: 2 focused API tests passed (157 skipped by name filter), covering Finance client creation, validation/duplicates, denied unauthorized creation/editing, invoice purchaser snapshots, and existing invoice-column/cumulative behavior. Frontend production build passed; `git diff --check` passed.

## 2026-11-02 — allow invoices without a selected client

- Decision / request: Some invoices are not addressed to a client; allow creating them without client selection.
- Changed: Made the invoice selector optional with an explicit No client choice and review summary. API creation now accepts omitted/null client IDs for company-level manual invoices, saves an empty purchaser name with no directory link, and does not create a placeholder client. Purchaser name renders as a dotted write-in space. Existing project-derived recipients and invalid-client checks remain. Previous-invoice credits require a saved client in both preview and creation to keep unnamed purchasers separate; ageing uses an understandable empty-name label.
- Data or deployment action: Local changes only; no deployment, production restart or live database writes. Tests use the temporary local test database. No schema migration required.
- Validation: Focused API tests and frontend build results recorded below.
- Open items / limits: No full API suite or interactive browser review. No new edit-recipient workflow is introduced for already saved invoices.
- Final validation: 3 focused API tests passed (157 skipped), covering unnamed-client tax/standard invoices, omitted/null IDs, preview, issue/receipt lifecycle, blank purchaser print fields, no fabricated clients, invalid-client rejection and prevention of anonymous cumulative credits; existing inline-client and cumulative billing tests passed. All 14 invoice-options/document-layout tests passed, including rendered pagination. Frontend production build and `git diff --check` passed.

## 2026-11-02 — litres and barrels for tar quotations and invoices

- Decision / request: Support quoting and invoicing tar/material quantities in litres or barrels.
- Changed: Added shared unit suggestions with Litres and Barrels to invoice lines and manual client quotation creation/editing while keeping custom units editable. Choosing a volume unit on an invoice enables Unit/Quantity/Rate columns, and a Use quantity × rate action makes quantity pricing easy to access for any unit. Guidance explains rates are per selected unit. Existing API persistence and arithmetic already support these units and decimal quantities; no schema change was needed.
- Data or deployment action: Local changes only; no deployment or live database writes. Focused API verification uses the temporary local test database.
- Validation: Frontend build and focused API test results recorded below.
- Open items / limits: No automatic barrel-to-litre conversion is assumed. Full API suite and interactive browser review were not run.
- Final validation: 2 focused API tests passed (159 skipped), confirming Litres/Barrels and fractional quantities persist in both quotations and invoices, per-unit amounts and VAT reconcile, both printable documents show units/amounts, and existing optional-column/cumulative behavior remains correct. Frontend production build and `git diff --check` passed.
