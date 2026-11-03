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


## 2026-11-03 — Electron desktop client and local verification

Added `desktop/` with Electron 45.2.1, electron-builder 26.18.0, locked dependencies,
root build/run/test scripts, bundled existing React assets, secure custom-protocol API
streaming, sandboxed isolated renderer, restricted settings bridge, native download
save dialogs, popup/print support and HTTPS connection settings. Default production
origin supplied by user: https://staff.gkucconstruction.com. No backend/DB is packaged.
Windows x64 NSIS and Mac arm64 ZIP builds are unsigned; browser remains available.
Shared frontend now resyncs on live connection/reconnection and preserves tokens during
transient bootstrap failures; 401 handling remains sign-out.

Validation: frontend build succeeded; 34 frontend and 3 desktop core tests passed.
Real macOS Electron transport test passed (local fixture: bearer headers, multipart,
incremental SSE, secure renderer, popup and PDF generation). Separate real-backend
Electron test passed using a new disposable loopback MySQL database: UI login,
authenticated bootstrap, live connection and second-client write refresh. Full Node 20
backend suite: 322 passed, 7 failed, 2 skipped. Failures concern weekly OT, invoice
payment-mode text, biometric OT, Draft duplication and driver/legacy OT expectations;
backend source was not changed in this desktop change. See docs/DESKTOP.md for details.

No deployment, remote DB write, production configuration edit or production account
login. Windows runtime, actual printers, low-spec hardware benchmarks, full network
failure recovery and signed releases remain unverified. Full-suite failures need
reconciliation before claiming complete release readiness. Updated README, architecture,
decisions and desktop handoff documentation in this change set.

### Desktop verification follow-up — 2026-11-03

Both Windows x64 NSIS installer and macOS arm64 ZIP builds completed successfully.
The packaged Mac app launched its local login with an unreachable HTTPS test server.
Actual-backend desktop coverage also passed a simulated bootstrap 503 without sign-out,
then stopped/restarted the local backend and verified live reconnection plus bootstrap
resync with the same session. The transport test additionally saved and checked an
attachment download. Both package archives were inspected: expected default HTTPS
origin, no backend directory or `.env` file. No production connection/account write was
used. This supplements the earlier verification limits; long/proxy-specific outages,
Windows runtime and physical printers remain unverified.

## 2026-11-03 — manual desktop UI verification and rollout guide

User requested local manual testing and production instructions. Used actual Electron
and Express with a new disposable loopback MySQL database (43974), then browser parity
checks against that same data. Visited all 16 main modules and 100 section views/tabs;
inspected additional finance/HR entry dialogs. Submitted synthetic fleet renewals,
optional fuel, maintenance, invoice/client, quotation, scanner mapping/import, task,
project/recovery, supplier/credit purchase, expense, stock, Drive and payroll workflows.
HR Daily payroll reconciled to 3,000; saved PDF/XLSX, Draft regeneration, Approved/Paid
locking and rejection of duplicate Paid-period generation were checked. No bank transfer.

Corrected seven issue groups: wrong-login wording; optional fuel project validation;
blank/unstable desktop PDF previews via network-origin ticket windows and PDF support;
optional expense category; equipment-service unchanged status; online origins for QR/
Drive links; unsupported native text prompts across eight call sites via shared async
in-app dialog, including real cancellation of subcontractor decisions. Backend business
source, schema and payroll formulas were not changed.

Added docs/MANUAL_QA.md with observed results and explicit gaps; docs/DEPLOYMENT.md with
server backup/build, single PM2 worker, HTTPS/SSE proxy, HR policy setup, client signing/
distribution and rollback instructions. Updated README, desktop, architecture, decisions
and payroll verification documentation. Added a guarded local-only manual QA launcher;
it rejects occupied ports/non-loopback DBs/non-local storage and disables outbound
notification credentials in future runs. Existing dirty work was retained.

Validation at this stage: frontend build passed; 37 frontend tests passed; desktop core
checks passed. Full backend Node 22 compatibility run repeated the earlier result:
322 passed, 7 failed, 2 skipped. No full-suite green claim. Final desktop integration/
packaging checks are recorded in the follow-up below. Project-less quotation acceptance
still emits misleading project-budget wording; noted separately. Not every form mutation,
role/row combination or hardware/provider branch was exercised manually. See the report.

No deployment, PM2 restart, production .env edit, remote storage operation or live DB
write. Only disposable local test data was written; public-link exercise used a synthetic
local file and was revoked. No external messages or actual printer output were sent.

### Manual QA final verification — 2026-11-03

Final frontend suite: 38 passed (including desktop PDF origin rejection and online-link
origin tests). Desktop core: 3 passed; real Electron transport: passed; actual local
backend login/live update/transient-error/restart-resync integration: passed; rebuilt
packaged Mac offline-login smoke: passed. Browser in-app prompt focused its response
field and Escape cancelled it. Both Windows NSIS and Mac ZIP builds completed, their
packaged runtime/UI bytes matched source, default HTTPS origin was correct, and backend,
.env and QA fixtures were absent. Generated SHA256SUMS beside installers.

The manually downloaded synthetic invoice PDF and payroll XLSX were retained under
ignored desktop/test-results as local evidence. Browser/test windows were closed and
both owned manual QA databases were removed; the local QA port was no longer listening.
A launcher guard retest rejected an occupied IPv6/wildcard port before creating data;
startup now requires its own child server's ready log, avoiding another process's
health endpoint. No production action occurred. Full backend suite remains 322/7/2
(pass/fail/skip), as documented above; Windows/device/provider coverage is still open.

- Final launcher smoke: started a fresh isolated Node 22 backend successfully using its
  own readiness log, then stopped it. Confirmed all three databases allocated during
  manual QA/launcher verification were removed. No production schema/data was touched.

## 2026-11-03 — precise explanation of full-suite failures

Re-read exact failing assertions after the user asked what failed. Correction to the
prior shorthand: the Draft lifecycle failure is not its duplicate/overlap check. It is
at api.test.js:3850: an inserted invalid transport component was expected to reject
regeneration with 409, but generation returned 201; therefore that test did not establish
the subsequent rollback assertion. Corrected MANUAL_QA.md and DESKTOP.md accordingly.

Seven counted failures group into five areas: weekly OT suggestion expected 1.25h but
returned 1.5h (07:00–07:30 plus 16:30–17:30); invoice raw-HTML string mismatch for Mode
of Payment/Cheque; biometric overtime expected 2h but returned 2.5h; the invalid transport
rejection above; two tests attempting prohibited Driver Office OT plus their parent
scenario-suite failure. The driver rule matches PAYROLL.md; its test fixtures need
reconciliation. No business code changed or tests rerun for this explanation/correction.
No production action or database write was performed.


## 2026-11-03 — reconcile backend regressions and confirm manual allowances

User supplied Construction payroll-settings screenshots and confirmed that the
Operator's LKR 300 per worked day is the only automatic allowance; other variable
allowances are HR-entered. Documented that clarification and the screenshot evidence
limits in PAYROLL.md. Existing manual claim/component persistence already supports
HR amounts; policy rates alone do not create paid allowance claims. No runtime
calculation, live policy or saved payslip was changed.

Corrected stale tests: weekly 07:00–17:30 OT is 1.5 hours; biometric calculations use
each day's policy, actual attended basic pay and category-specific late rates; Driver
Office OT is prohibited. Invoice checks compare visible payment text across markup.
Draft rollback owns its dated policy with a missing transport threshold and synthetic
LKR 200 Site rate, avoiding leaked settings from preceding tests. Added a regression
for variable manually approved transport amounts without a threshold, while keeping
explicit prorated transport blocked until HR configures its threshold.

Validation: full backend Node 20.12.2 `node --test` from backend: **330 passed,
0 failed, 2 skipped; 332 including nested tests**. New allowance unit test also
passed separately (6/6 in hr-payroll-rules.test.js). `git diff --check` passed.
Updated MANUAL_QA.md, DESKTOP.md and DEPLOYMENT.md to replace the earlier seven-failure
release finding with actual results. Node 22 was not rerun in this follow-up;
Windows runtime/signing/hardware and live integration remain separate outstanding
verification. No frontend/runtime changes: no rebuild required for these test/docs
changes. No deployment, PM2 operation, remote database write or production .env edit.


## 2026-11-03 — GKUC Construction desktop name and rings icon

User requested desktop name GKUC Construction and the existing blue rings alone on
white. Updated Electron product/window/menu/setup/error/download labels, installer
artifact names and shortcut name. Used the unchanged brand mark on a white square
SVG canvas; rendered native PNG/ICO/ICNS assets with a reproducible generator.
Windows executable resource editing is enabled so the EXE itself receives the name
and icon, independent of signing. Preserved app ID and the old packaged user-data
folder to retain saved connection settings across the rename. Browser/API branding
and payroll behavior are unchanged. Updated DESKTOP.md, DEPLOYMENT.md and ARCHITECTURE.md.

Validation: frontend production build passed during both platform builds (existing
large-chunk advisory remains). Desktop core tests 3/3, Electron transport/UI test 1/1
and new-name packaged macOS smoke test 1/1 passed. Native window title/app name were
verified separately from the web page's unchanged document title. Mac bundled ICNS
exactly matches the new icon; direct Windows PE resource inspection confirmed all
six ICO sizes match the generated white-background assets and product metadata
contains GKUC Construction. Windows runtime/client installation and code signing
remain unverified; builds are unsigned. No backend tests were required for this
desktop branding change. No deployment or live database write.

Both renamed release artifacts were rebuilt successfully: desktop/release/
GKUC-Construction-1.0.0-win-x64.exe and GKUC-Construction-1.0.0-mac-arm64.zip.
SHA256SUMS now lists these final artifacts. `git diff --check` passed.


## 2026-11-04 — fix clipped/repeated desktop app icon (1.0.1)

User's Finder screenshot showed a repeated lower logo fragment. Reproduced in the
1.0.0 256px ICO payload; validating only the 1024px PNG had missed it. Multi-size
viewport screenshots captured stale raster tiles. Replaced that rendering with
fresh per-size canvas rasterization of the unchanged logo/white SVG, with guards
for nonblank content, opacity and clear edge margins. Also removed malformed legacy
small ICNS representations and write PNG-backed standard/Retina entries directly.
Bumped desktop package and lockfile to 1.0.1; rebuilt Mac and Windows artifacts and
updated SHA256SUMS. Updated DESKTOP.md and DEPLOYMENT.md with corrected version/limits.

Validation: generated and extracted all six ICO and eight ICNS PNG representations;
checked opacity and mark bounds at each size, visually inspected corrected 256px and
small Retina versions. Rendered the actual rebuilt app icon through macOS NSWorkspace
and visually confirmed a single complete logo centred on its rounded white tile.
Native preview is ignored desktop/test-results/icon-1.0.1-mac-native.png. Windows
PE inspection confirms all six corrected icon payloads are embedded in the EXE;
Mac bundled ICNS exactly matches source. Desktop core tests 3/3 and packaged Mac
login/name/security smoke test 1/1 passed; both platform builds succeeded.
`git diff --check` passed. Windows installation/runtime and signing remain unverified;
packages remain unsigned. No frontend/backend behavior, production deployment or
live data was changed. Unrelated desktop/.DS_Store was left untouched.


## 2026-11-04 — recreate deleted desktop release outputs

User requested rebuilding after deleting release files. Rebuilt GKUC Construction
1.0.1 Mac arm64 ZIP and Windows x64 NSIS installer from the current frontend and
corrected icon assets; regenerated SHA256SUMS for these two final files. Both builds
completed successfully. Packaged macOS login/name/security smoke test passed 1/1;
bundled ICNS matches the corrected source. Existing large frontend chunk advisory
remains. No source behavior changed. Windows runtime remains unverified and builds
remain unsigned. No deployment or live database write.


## 2026-11-04 — remembered desktop login and developer credit (1.0.2)

User requested desktop sign-in survive app close/reopen and exact attribution on
generated PDFs (once at end, every page for payslips). Desktop saves only opaque
session+server in OS-encrypted safeStorage, never passwords; queued atomic mode-0600
writes prevent save/logout races. Main-frame IPC only; PDF/pop-up/settings frames
cannot access the saved login. Restore happens before React/bootstrap; logout,
expiry/revocation and connection changes clear it. Unavailable/plaintext OS storage
is refused. Login API optional rememberDevice flag issues revocable 30-day sessions;
browser defaults remain 12 hours. Existing sessions schema and permission checks
remain unchanged. No silent live data/policy changes.

Added shared idempotent developer-credit decorator with exact Developed by Infinity
AI (Pvt) Ltd, Sri Lanka. Common documents and HR letters show it once at end, outside
editable footer settings. Payslips use reserved @page bottom-centre margin on every
page alongside confidentiality and page numbers. PDF/HTML send fallback also covers
older saved letter HTML without rewriting the stored letter; credit stays inside
its white paper container. Uploaded third-party PDFs are not rewritten. Salary and
Approved/Paid calculation snapshots remain unchanged.

Validation: frontend 39/39, desktop core/store 4/4, transport/security 1/1 (pop-up and
settings-frame access denied), actual local-backend integration 1/1 with encrypted
file check, full process restart authenticated, server-expired-token removal, manual
logout and signed-out restart; packaged Mac smoke 1/1. Initial integration retries
exposed the seeded introduction overlay intercepting the test's logout click; the
test now dismisses the introduction and waits for persisted clearing.
Full Node 20 backend: 333 passed, zero failed, two optional skips (335 incl nested).
An initial midnight run exposed three existing UTC/local-day fixture mismatches;
aligned API test today/shift with the API/seed business day and reran successfully,
without changing financial calculations. Focused PDF-credit tests reran 2/2 after
adding legacy-letter placement. Multi-page invoice credit is once on final page;
five-page payslip credit once on each page. Rendered pages visually verified with
no footer overlap. Frontend production build passed (existing chunk advisory).

Both 1.0.2 platform artifacts rebuilt successfully, inspected to contain encrypted
session implementation, and SHA256SUMS regenerated. Updated README, ARCHITECTURE,
DECISIONS, PAYROLL, DESKTOP, DEPLOYMENT and MANUAL_QA. Deploy updated backend/browser
first, then new desktop; first desktop sign-in creates saved device login. Windows
installation/runtime and signing remain unverified; artifacts remain unsigned.
`git diff --check` passed. No deployment, PM2 action or live database write.


## 2026-11-04 — rebuild deleted 1.0.2 release folder

User deleted release outputs and requested rebuilding. Rebuilt current frontend
and GKUC Construction 1.0.2 macOS arm64 ZIP and Windows x64 installer, preserving
corrected icons and encrypted remembered-login behavior. Both platform builds
succeeded; packaged Mac login/name/security smoke check passed 1/1. Regenerated
SHA256SUMS for the two artifacts. Existing unsigned/Windows-runtime verification
limits remain. No feature changes, deployment or live database writes.
