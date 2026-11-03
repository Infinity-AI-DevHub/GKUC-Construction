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

## 2026-11-03 — remember scanner names after manual attendance matching

- Decision / request: Keep the existing upload/manual-match/import process; remember the imported scanner name against the selected employee so later imports do not need the same manual matching. Do not display this as another employee name.
- Changed: Added guarded nullable `employee_biometric_ids.scanner_name` storage linked to the employee. The existing Match request includes the scanner name and saves/audits it transactionally with the ID link; scanner-created profiles retain their source name too. Shared preview/commit resolution uses approved numbers and unambiguous saved names after case/whitespace normalization. It never guesses from employee display names. Duplicate-name/new-number ambiguity, conflicting number/name owners, and hidden/Left profiles are handled conservatively. No new workflow steps or displayed profile fields; employee names, corrections, payroll rules and saved payslips are unchanged.
- Data or deployment action: No deployment, production restart, live migration or live attendance import. The supplied workbook was read locally without modification; integration tests use only the isolated temporary local test database.
- Validation: Parser/identity unit tests, focused API integration tests and frontend build results recorded below.
- Open items / limits: Earlier mappings have no scanner name until a future manual match includes it; existing scanner-number recognition continues to work. One remembered name is retained per scanner-number link; additional scanner numbers for the same employee may retain different names. Ambiguous names still require review rather than unsafe guessing. Full backend suite and interactive browser review were not run.
- Final validation: All 13 identity/parser unit tests passed. Seven focused API tests passed (155 skipped by name filter), covering manual scanner-name persistence, later legacy-Excel recognition/commit, private alias storage and audit, duplicate names, old number-only links, multiple numbers, deactivation and corrupt-file handling. The supplied report's opt-in test passed through import/reimport and payroll identity checks in the temporary test database. Frontend production build and `git diff --check` passed.

## 2026-11-03 — effective HR work-role and machine-operator daily pay

- Decision / request: Implement both confirmed agreements from 2026-01-01. HR records Bass/Gola per day without supervisor approval. Operator uses machine-meter pay/minimum or standby hours, daily transport, no OT/late, and the confirmed 1,800 × 1.5 extra-day basic. Keep these employee-specific and preserve saved payroll.
- Changed: Added effective employee pay-method/rate snapshots and audited daily work/meter records, with reversible daily archival. People → Payroll Inputs → Special daily pay lets HR explicitly select the real employee, save the effective method and enter/correct daily evidence. No employee ID is inferred from a name. The existing attendance/import process remains. Generation blocks missing/mismatched/orphan/review-required inputs, uses the correct dated method and month-to-date count, pays role-based basic/short days/paid leave, enforces Site 225/30-minute and Travel 100/31-minute OT, and applies operator minimum/standby/transport/premium exclusions. Pending/approved operator OT and overlapping transport/machine entitlements require review instead of double payment. Advances use the existing recovery ledger. Special EPF is disabled only in calculation while effective; ETF retains existing profile eligibility/basis and other employees are unchanged.
- Persistence / exports: Added guarded `employee_special_pay_rules` and `employee_special_pay_days` tables and an `hr.payroll`-protected `/payroll/special-pay` API. All inputs/rule changes are audited. Payslips snapshot the HR source, rule/rates, role, readings, formula and earned amounts; PDFs and XLSX show saved special detail, including a Special daily pay sheet. Daily reconciliation uses saved earned basic, not a generic profile rate. Special project allocations use saved earned salary. Existing Drafts update only on explicit regeneration; Approved/Paid snapshots remain immutable. Added employeeId to payslip API rows for stable identity.
- Data or deployment action: No deployment, PM2 restart, live migration, live employee-method assignment or live payroll write. Only the isolated temporary local test database was written. The actual employees still need their correct effective methods saved through the app after deployment; code does not silently configure live profiles/policies.
- Validation: Focused tests and final checks recorded below. Rendered both sample methods to two-page PDFs using synthetic data and inspected all pages. Frontend build passed.
- Known existing test discrepancy: The older API test `biometric attendance pays automatic OT and minute lateness for every category using dated settings` still expects 2 OT hours, while the unchanged HEAD calculation produces 2.5 for its 16:30/16:00 shift-end fixture. Reproduced against the original calculation source to confirm it predates this change; that legacy assertion was not rewritten. Full backend suite and interactive browser workflow review were not run.
- Final validation: 40 focused calculation/export/schema/attendance-match tests passed, including the new special-method scenarios. Five filtered API tests passed (159 skipped): HR persistence/authorization, missing inputs, Draft regeneration, approved snapshot protection, paid leave/EPF/ETF reconciliation, existing draft lifecycle, manual/calculated travel and one-time deduction handling. Frontend production build passed. All four pages of the two synthetic payslip PDFs were visually checked; special earnings/transport reconciled, machine readings/formulas were legible, role late-rate display used the saved LKR 225/h and operator late-rate rows were omitted. Final `git diff --check` passed. Full-suite success is not claimed because of the separately documented pre-existing OT test assertion.

## 2026-11-03 — operator Standby-day Site OT clarification

- Decision / request: Supersede the earlier blanket operator OT exclusion. On non-machine Standby dates only, pay ordinary labour Site OT from 30 minutes. Machine-operating dates retain no OT; operator late deduction stays excluded.
- Changed: Special employee calculation context includes the active daily work record. Automatic and reviewed Standby Site OT use the company policy effective on the work date, minimum 30 minutes, and actual minutes for automatic OT money. Machine-day and non-Site operator OT remain blocked. HR suggestions, suggestion confirmation and employee OT entry check the saved work type; missing/archived choices cannot enable OT. Reviewed Standby Site OT replaces automatic OT. Updated daily-pay guidance and authoritative payroll/architecture/decision documentation. No schema or existing data change.
- Data or deployment action: Local code only; no deployment, production restart, live database writes or saved payroll recalculation. API tests write only the temporary local test database. The clarification uses the existing 2026-01-01 effective special agreement.
- Validation: 22 focused special-pay/attendance/HR-rule/export tests passed. Three filtered API tests passed (162 skipped), covering Standby eligibility/suggestions/manual review, no Machine-day OT, missing-choice blocking, exact-minute automatic amounts, reviewed-vs-automatic replacement, draft lifecycle and existing special paid-leave/contribution behavior. Frontend production build and `git diff --check` passed.
- Open items / limits: Full backend suite and interactive browser review were not run. The normal labour Site rate comes from the effective company policy (agreed current rate LKR 225/h), not the LKR 650 machine meter rate. Approved/Paid snapshots remain unchanged.

## 2026-11-03 — documentation completeness review for special payroll

- Decision / request: Verify that the newly implemented employee-specific payroll methods and final Operator Standby OT correction are included in durable documentation.
- Findings / changed: The full Bass/Gola and operator rules, effective date 2026-01-01, HR setup/entry workflow, storage/API, saved-payslip protection, validation and deployment limits were already recorded in `docs/PAYROLL.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, README and this progress log. Corrected the older decision summary that still said blanket no operator OT, added the final Machine-versus-Standby distinction to the README, updated the payroll specification's confirmation date and linked the new calculation/API/UI owners in its code map. Prior progress entries remain unchanged as historical records; the later OT clarification supersedes the earlier blanket exclusion.
- Validation: Cross-checked the current rule descriptions across the five documents and ran `git diff --check` and `git diff --cached --check`. No code tests/build were rerun because this follow-up changes Markdown only.
- Data or deployment action: Documentation-only local changes. No deployment, application database writes, employee rule assignment or payroll recalculation.
- Open items / limits: Live configuration/deployment is still a separate action; documentation does not imply it has happened.
