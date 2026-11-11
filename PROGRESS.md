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


## 2026-11-04 — update task status directly from grouped Tasks list (1.0.3)

User requested status changes from the Tasks list shown in their screenshot. Added
a per-row status dropdown with a short explicit save/approval form using the existing
PATCH /tasks/:id. Options mirror the existing detail workflow: start/resume, block,
submit Completed, management approve/return. Blocking/returning requires a reason;
read-only users retain badges and Approved records remain locked. Reload keeps the
list, status filters, next action and existing shared task history in sync. No new
backend route, permission, schema or live data change. Updated ARCHITECTURE, DESKTOP
and release artifact references in DEPLOYMENT; bumped desktop package/lock to 1.0.3.

Validation: frontend suite 39/39, production frontend build succeeded (existing chunk
advisory). Isolated actual Electron+local-MySQL UI check passed for project and office
tasks: Cancel preserves old status; blank reason blocks save; block/resume/complete/
return/re-submit/approve persist; page reload retains Approved and its lock; audit
statusHistory includes both reasons. Initial UI-check retry corrected the locator to
include the shared form's required-field marker. Reusable local check and screenshot
are ignored desktop/test-results/task-status-check.cjs and tasks-list-status.png.
Temporary test database/server/profile were cleaned up. Focused Node 20 API checks
for task role enforcement, management approval and office persistence passed 3/3.
Packaged Mac smoke check passed 1/1. Mac arm64 ZIP and Windows x64 installer rebuilt
as 1.0.3 and SHA256SUMS regenerated. Windows runtime/signing remain unverified;
artifacts are unsigned. `git diff --check` passed. No deployment or live DB write.


## 2026-11-04 — pin global navbar during page scrolling (1.0.4)

User requested the navbar remain stationary when scrolling pages. Replaced root
overflow-x:hidden with clip so root ancestors no longer intercept sticky positioning.
Removed the module/QS-page rule that changed the global desktop navbar to relative.
Added shared section-menu clearance (104px desktop, 88px tablet) and corresponding
viewport-height limits for module/QS navigation to avoid hiding it under the global
bar. Existing mobile drawers and narrow QS horizontal section navigation retain
their behavior. No API/schema/business-rule changes. Updated ARCHITECTURE/DESKTOP
and current release filenames in DEPLOYMENT; desktop package/lock now 1.0.4.

Validation: frontend suite 39/39 and production build passed (existing chunk advisory).
Actual Electron + isolated local backend scroll check passed all 16 combinations:
Tasks, Finance, QS, People at 1440x950, 1920x1080, 900x800 and 390x844. Checked actual
page scrolling, pinned visible bar coordinates, account-menu usability after scrolling
and section-menu clearance wherever those menus use sticky positioning. Checked
desktop/mobile screenshots. Initial QA iterations corrected smooth-scroll timing
and the expected static QS tab strip below its existing 900px breakpoint; tablet
clearance was increased after measuring the 72px global header. QA script/evidence
are ignored desktop/test-results/navbar-check.cjs and navbar-sticky-{desktop,mobile}.png.
Disposable database/server/profile were cleaned up. Packaged Mac smoke passed 1/1.
Both 1.0.4 platform builds completed; SHA256SUMS regenerated. No deployment or live
DB writes. Windows runtime/signing remain unverified; packages remain unsigned.
`git diff --check` passed.


## 2026-11-04 — allow management to change approved task status (1.0.5)

User explicitly requested status changes for Approved tasks too. Superseded the
previous task-only lock. The Tasks list offers all non-Approved statuses to users
with site.tasks and projects.manage, with a mandatory reason. Detail also provides
Reopen task (In progress). Other staff remain unable to reopen approved work. API
clears approved_by, saves a reason comment and retains previous approval/change
audit history. Reapproval still requires Completed. Conditional UPDATE matches the
read status and returns 409 if it changed meanwhile, protecting against stale status
writes. No schema change, payroll-lock change or live records modified.

Validation: frontend 39/39 and production build pass (existing chunk advisory).
Focused Node 20 tests 3/3 include all five target statuses, missing reason, denied
supervisor access, cleared approver, retained reason history and reapproval. Full
backend: 334 passed, zero failed, two optional skips (336 including nested tests).
Actual isolated Electron+local-backend list check passed: blank reason preserves
Approved; reasoned reopen saves, clears approver and survives reload with history.
Temporary QA database/server/profile cleaned up. Packaged Mac smoke 1/1 pass.
Both 1.0.5 platform builds succeeded; SHA256SUMS regenerated. Updated ARCHITECTURE,
DECISIONS, DESKTOP and DEPLOYMENT. Deploy updated backend/frontend before the new
client; no deployment or live database write performed here. Windows runtime and
signing remain unverified; builds are unsigned. `git diff --check` passed.


## 2026-11-04 — per-document quote/invoice visibility and shared printed quote numbers (1.0.6)

User needs multiple quotations for the same work with the same quotation number and
optional totals, plus choices of printed content in QS/Finance. Added Print options
actions on QS quotations and Finance client invoices, persisted via authenticated
GET/PUT print-options routes and guarded nullable print_options JSON columns.
Writers require qs.quotation or finance.invoice; changes are transactionally audited
as PRINT_OPTIONS. Internal record references/IDs and financial amounts remain intact.
Independent quotations can share printedReference, shown in PDF and QS list (record
reference retained as secondary text). Invoice reference overrides are rejected.
Existing revisions already share system numbers; revisions now copy print options.

Shared renderer filters letterhead fields, unit/quantity/rate/line amounts and
client/work/notes/methods/terms/bank/signatures/footer sections. Disabling totals
removes summary/category totals and words together. Dynamic spans keep table layout
valid. Mandatory developer credit remains outside configurable company footer.
Legacy NULL settings retain old output/identity/column choices. Invoice columns
API is synchronized with the new options while cumulative invoice snapshots remain
intact. Progress-claim invoice rendering reads these settings too. No budget, VAT
ledger, payroll, payment or issued invoice amount recalculation.

Validation: frontend 39/39, production frontend build pass (existing chunk advisory).
New rendering/PDF tests 3/3; actual PDF text confirms hidden values/words are absent.
API coverage verifies two independent quotations with one printed number, unchanged
system references/totals, saved options, access rejection, validation, auditing,
revision inheritance, unchanged invoice finances and old-column endpoint sync.
Full Node 20 backend: 338 passed, zero failed, two optional skips (340 incl nested).
Actual Electron+isolated local backend QS/Finance UI check 1/1: choices persist after
reload, both quotation list numbers match, invoice quantity choice saves, and both
PDFs generate. Visually inspected options form and resulting quotation PDF. Evidence
is ignored desktop/test-results/print-options-check.cjs, invoice-print-options-ui.png
and {quotation,invoice}-selected-options.pdf. QA database/server/profile cleaned up.
Packaged Mac smoke 1/1 pass. Both 1.0.6 installers rebuilt; SHA256SUMS regenerated.
Updated README, ARCHITECTURE, DECISIONS, DESKTOP, DEPLOYMENT and MANUAL_QA.
`git diff --check` passed. Deploy backend/migrations and frontend before new desktop;
no deployment or live database write performed. Windows runtime/signing remain
unverified; builds are unsigned.


## 2026-11-04 — Desktop 1.0.6 release rebuild

- Rebuilt the current frontend and both desktop release packages at the user’s request: Windows x64 NSIS installer and macOS Apple Silicon ZIP. Regenerated `desktop/release/SHA256SUMS`. No application behavior or version change.
- Validation: frontend production build passed (existing chunk-size advisory); desktop core tests 4/4 passed; packaged macOS launch test 1/1 passed; both packaging commands completed successfully. Windows runtime was not tested; packages remain unsigned.
- No deployment, PM2 restart, or live database write performed.

## 2026-11-05 — edit fleet vehicle details

User reported vehicle details could not be edited. Existing UI only exposed machine
specifications. Added a clear View / edit details action on vehicle cards and expanded
the detail editor to vehicle name, registration/asset ID and status alongside existing
make/model/year/engine/manual fields. Uses the existing transport.manage API permission
and audited persistence; dated driver/site, reading and renewal workflows remain intact.
Trimmed name/registration validation and mapped duplicate registration errors to a clear
409 response; a rejected duplicate saves none of the submitted fields. No migration.

Validation: Node 20 focused API tests 2/2 passed (167 unrelated tests filtered out),
covering persisted fields/list reload, unchanged reading/documents, duplicate rollback,
invalid values, unauthorized writes and existing optional specifications. Frontend
production build passed with the existing chunk-size advisory. No manual GUI check,
desktop installer rebuild, deployment, PM2 action or live database write performed.

## 2026-11-05 — optional petty-cash warning and direct top-up action

Removed required browser validation from the low-balance warning on account creation
and editing. Blank maps to zero, already supported by the API. Added Add money / Top up
in the account ledger, opening the existing movement form preselected to Top up with
funding-specific description guidance. Subsequent funding remains positive dated
ledger entries, independently increases each account’s cash balance and creates no
income/expense. Existing spend/return/adjustment and Fuel spending workflows remain.
Updated PETTY_CASH_ACCOUNTS.md and ARCHITECTURE.md. No backend behavior/schema change.

Validation: focused Node 20 API tests 2/2 passed (168 unrelated filtered out), including
omitted warning, repeated top-ups and persisted balances/history for Office expenses,
Salary advance and Fuel, plus existing creation/edit controls. Frontend production
build passed (existing chunk-size advisory); git diff --check passed. No manual GUI
verification or desktop rebuild this turn. No deployment, PM2 action or live DB write.

## 2026-11-05 — reviewed Excel creation and updates for bonds

Added Finance → Bonds → Import / update Excel with downloadable current-company
workbook/template, .xlsx upload, editable per-row review, existing/new target selection,
saved-record comparison, per-row verification and final Submit verified bonds. Any edit
clears row verification. Matches system reference or bond number+bank; ambiguous/unknown
references require explicit target choice. Blank cells preserve matched existing values;
users can correct/clear values in review. Supports all manual bond fields, company project
selection, Excel serial/ISO dates, comma-separated amounts and up to 300 rows.

Added guarded additive bond_import_batches table and authenticated finance.invoice
routes for template, preview and submit. Preview stores only the review draft/audit;
upload scratch files are discarded. Submit checks uploader, company/project, row count,
verification, duplicate targets/numbers, saved snapshots and prior successful checksum,
then saves every bond/audit/completion atomically. Existing system references, creator
and extension history remain; no accounting entry or extension event is generated.
Updated README, ARCHITECTURE, DECISIONS and new docs/BOND_IMPORT.md.

Validation: focused Node 20 bond/parser/API tests 6/6 passed, 167 unrelated filtered out.
Includes template roundtrip, number/reference matching, upload without register writes,
new+update persistence, invalid-row rollback, unverified rejection, repeat submit/file
rejection, permission/ownership/company checks, stale-record conflict and auditing;
existing edit/delete/extension scenarios also passed. Fixed initial local migration
company-ID type mismatch and sparse 1-indexed workbook-row handling before successful
rerun. Frontend production build passed (existing large-chunk advisory). Actual Electron
+ disposable local MySQL UI test 1/1 passed: upload two rows, disabled submit before
verification, edit clears verification, submit and reload retain updated and new bonds.
Visually inspected review screenshot. QA script/evidence are ignored desktop/test-results/
bond-import-check.cjs and bond-import-review.png; temporary DB/server/profile cleaned up.
No full backend suite or installer rebuild this turn. Updated desktop source UI bundle
for local verification only; existing release installers do not contain this feature.
No deployment, PM2 restart, production .env edit or live database write performed.

## 2026-11-05 — linked historical Clients, Projects and BOQs templates

User supplied three completed .xlsx templates whose codes express client → project →
BOQ relationships. Added linked-workbook detection before generic/free-layout BOQ
parsing. Supports Clients + Contacts, Projects + Project Team and BOQ Headers + BOQ
Items, retaining all 22/22/316 rows from the supplied files (11 clients, 11 contacts,
11 projects, 11 team rows, 11 headers and 305 items). Source codes map through persistent
historical_import_links; native IDs/references are generated independently. Child keys
use parent code plus contact name, employee code or source line number.

Added editable sheet review, explicit existing client/project linking without overwrite,
source employee matching, exact code replacement, explicit phone relocation and financial
recalculation helpers. Save review revalidates; reviewer acknowledgement precedes confirm.
Missing parents, duplicate keys, invalid values, unmatched staff, category/precision and
line/header financial mismatches block confirmation. Company spelling GKUC Ready mix
normalizes to GKUC Readymix. Supplied contact PRIMARY_CONTACT phone values, employee-code
differences, BOQ-2026/2024 key mismatch and financial discrepancies remain visible for
manual correction; original supplied files were not changed or imported to production.

Confirmation locks the batch and serializes dependency resolution, then atomically saves
parent/child records, source links/metadata, completion and audits. Repeats skip linked
keys; duplicate confirmation, stale/deleted targets, wrong project/client/company and
primary-contact conflicts cannot silently overwrite records. New lines cannot be appended
to an already imported BOQ through this flow. BOQs stay Draft; original approval status,
version/reference/dates remain source history and existing project budgets are unchanged.
Original extracted rows are preserved in sourceRows, and review corrections have audited
before/after rows. Native primary contact changes are separately audited.

Schema: guarded nullable historical_import_links.source_json, client_contact_people and
non-destructive capacity widening for project name, BOQ title and item description/notes.
Updated normal project/BOQ validation capacities so long imported names/lines remain
editable. Client profiles return/display imported contacts. Source project contract values,
notes and other non-native fields remain in the import history; award reference/date and
team membership dates populate their existing native records. Updated README,
ARCHITECTURE, DECISIONS and new docs/HISTORICAL_IMPORTS.md.

Validation: full Node 20 backend suite 347 passed, zero failed, two optional skips
(349 incl nested) with supplied-template fixtures enabled. Focused linked/parser/API
checks reran 6/6 after final whitespace/source-provenance assertions. These include actual
supplied workbook parsing/dry checks, complete source-key chain, manual corrections,
long text, exact totals, Draft/budget preservation, linked repeat skip, primary-contact
conflict rollback, permissions and original-row retention. Existing foreign/PDF-layout
BOQ review tests still pass. Frontend 39/39 and production build pass (existing chunk
advisory). Actual Electron + isolated local MySQL UI 1/1 passed across all three workbook
stages, including contact-phone action, employee mapping, key correction, amount/header
total corrections, final submission and persisted links. Fixed table min-content overflow
and employee-selector accessible labels exposed by initial UI retries; final screenshot
visually inspected. Evidence/script ignored under desktop/test-results/linked-import-*;
disposable DB/server/profile cleaned up. git diff --check passed.

No production deployment, PM2 operation, production .env edit or live database write.
Desktop UI bundle was prepared for local verification; release installers were not rebuilt.

## 2026-11-05 — make saved bond editing and pending numbers explicit

User reiterated that saved bond details must remain editable and numbers may be added
later. Existing finance.invoice PUT already permits all bond statuses and optional
numbers. Replaced the small pencil-only action with a visible Edit details button for
every status; added explicit optional-number guidance/placeholder. Blank numbers are
submitted as an explicit empty string so saving/clearing pending values is deliberate.
Existing audited updates, fixed company/reference and extension history remain unchanged.
Updated docs/BOND_IMPORT.md. No backend behavior or schema change was needed.

Validation: focused Node 20 API tests 2/2 passed (172 unrelated filtered out), covering
pending → entered → cleared numbers and detail edits in Live/Expired/Released/Called,
plus existing permissions, company/date validation and retained extension history.
Actual Electron + disposable local MySQL UI 1/1 passed: edit a Released bond with no
number, add number/change bank, reload, reopen and clear number; saved status retained.
Temporary DB/server/profile cleaned up. Frontend production build and git diff --check
passed (existing chunk-size advisory). Local desktop UI bundle prepared for testing;
release installers not rebuilt. No deployment, PM2 action or live database write.

## 2026-11-05 — optional project end dates, daily reminders and repeat extensions

User requested optional completion dates, daily reminders beginning one month before
end, repeat extensions with printable client request letters, Completed/Extended display
and Projects search/filters. Added End date (optional) to normal creation and a workspace
Completion date & extensions panel for later entry, extension and history. Generic later
date changes route through Extend project; stale date edits are rejected. Valid calendar
and start/end ordering checks apply. Completed stage retains the existing health/site
completion/100% behavior and prevents extension until explicitly reopened.

Added guarded projects.extension_count and append-only project_extensions with old/new
dates, reason, request date, author and saved request HTML. Extension transaction locks
and checks the previous date, saves revised target/history/letter/audits atomically and
blocks company changes once history exists. Internal target changes immediately; letter
requests client consent and does not claim it was granted. Saved letter text remains
stable across future project/client/company edits. Existing company letterhead and
mandatory developer credit are used; added the exact extension letter route to the
short-lived PDF-ticket allowlist. History has Print request letter for reprints/popup
fallback. No automatic client email action.

Added calendar-month daily deadline scan to existing scheduler/bootstrap: all active
accounts, per-project/end-date/user/business-date unique delivery keys, day counts and
overdue continuation. Completed/health/site-completed and inactive/no-date projects are
excluded. Revised dates restart the reminder window. These recurring notifications do
not create unresolved alert/escalation cases; existing notification history stays intact.
Projects cards/workspace show Completed before Extended before Current, with independent
operational stage/health. List search covers name/client/site/manager; combined filters
cover status, manager and end-date state plus existing operating company scope.

Validation: final full Node 20 backend 351 passed, zero failed, two optional skips (353
incl nested), including all prior work and supplied historical workbook fixtures. Focused
new checks initially 3/3 passed: calendar-month/end-of-month/leap-compatible date window,
completed/no-date/inactive stopping, escaped letter fields/credit, nullable/date ordering,
all-user reminder count, same-day dedupe, changed-date cycle, repeated extension, stale
rejection, permissions, immutable letter HTML/PDF ticket, company/history and completion.
Frontend 39/39 and production build passed (existing chunk-size advisory). Actual Electron
+ disposable local MySQL UI 1/1 passed: add end date after creation, two extensions, PDF
creation/open, mark Completed, search/status/clear filters and persisted server state.
Rendered real generated extension PDF with Poppler and visually inspected one-page
letterhead, body, dates, reason, signature and credit; PDF text matches stored request.
Evidence/script ignored in desktop/test-results/project-deadline-check.cjs,
project-extension-request.pdf and project-deadline-filters.png. Temporary QA database,
server and profile cleaned up; git diff --check passed.

Updated README, ARCHITECTURE, DECISIONS and docs/PROJECT_DEADLINES.md. No deployment,
PM2 action, production .env edit, external client message or live database write.
Local desktop UI was prepared for QA; release installers were not rebuilt this turn.

## 2026-11-05 — editable sample-style multi-item purchase orders

User requested a printable PO matching the supplied sample with every printed field,
number, lines, quantities and amounts editable later. Explicit clarification: expenses/
outstanding follow Goods/invoice confirmation, not PO saving. Expanded the existing
Materials → Orders flow rather than creating a separate mock/document ledger. New
multi-line form supports optional auto/manual PO number, document title, Attention,
Site, Cash/Credit/Cheque text, vehicle, closing, three signoff names, optional per-PO
company letterhead text and free/non-stock or material-linked lines. Quantity×rate or
explicit manual line amounts are supported. Supplier/project changes update printed
defaults. Removed the replaced single-item form.

Added reasoned PUT order revisions and revision/check endpoints with stale-version,
role, company/request/receipt identity, duplicate number and risk validation. Commercial
changes require fresh approval and revision authors cannot self-approve. Reapproval
preserves partial/full receipt state. Received quantities cannot be reduced/removed;
received material/unit meaning and linked supplier/project accounts remain protected.
Unreceived additions/reductions and rate/amount changes remain possible. Printed
Attention/Site/number remain independently editable; actual transaction IDs stay linked.

Guarded columns persist presentation, revision/author, item number/manual amount,
cumulative receipt value, per-receipt unit valuation and trusted invoice PO snapshot;
added purchase_order_revisions with before/after JSON. Receipt/invoice costs and debt
are not rewritten by a PO revision. Legacy valuations/approval snapshots freeze before
editing; new receipts/invoices capture theirs at confirmation. Supplier statements and
payment matching use stored values. Manual amounts value partial receipts proportionately;
price-risk warnings use effective amount/quantity instead of only printed unit price.
Saving/revising creates no expense/debt/payment: native receipt/stock-issue, invoice,
verification and payment/cheque workflows retain ownership and avoid double counting.

Reworked printable PO into sample-style Attention/Site/payment/vehicle metadata, black
six-column multi-item table, Sub Amount and Prepared/Checked/Approved lines. Actual
approval status is shown and typed names do not confer approval. Existing logo/letterhead
and mandatory developer credit retained. Fixed the legacy table block name so rows are
actually rendered; retained direct-site-delivery wording. Added PO route to PDF-ticket
allowlist. Materials section URLs now survive bootstrap/reload instead of resetting to
Stock, as exposed by the first UI check.

Validation: final full Node 20 backend 354 passed, zero failed, two optional skips (356
incl nested), with supplied historical fixtures enabled. Focused new checks 3/3 passed,
including explicit manual valuation, PDF fields, no cost on save, partial receipt cost,
changed prices/quantities, old invoice/payment/debt preservation, supplier statement
valuation, immutable receipt quantities/identity, stale revision, independent revision-
author approval rejection, reapproval and PDF tickets. Frontend 39/39 and production build
pass (existing chunk-size advisory). Actual Electron + disposable local MySQL UI 1/1
passed create multi-item/manual amount PO, edit number/quantity/amount, reload/history,
and actual PDF generation. Initial UI retries fixed the section-link reset and required-
field locator; final checks pass. First full run found missing legacy direct-delivery
wording in the redesigned print; restored it and reran the full suite successfully.

Rendered final PDF with Poppler; text and visual inspection confirm metadata, real rows,
manual amounts, total, three signoff columns and credit with no overlap. Evidence/script
ignored in desktop/test-results/purchase-order-check.cjs and editable-purchase-order.pdf.
Disposable DB/server/profile cleaned up. Updated README, ARCHITECTURE, DECISIONS and new
docs/PURCHASE_ORDERS.md. git diff --check passed. No production deployment, PM2 action,
production .env edit, client message/payment or live DB write. Desktop UI prepared for
local QA only; release installers were not rebuilt.

## 2026-11-05 — accessible editing and new records on existing vehicles

User reiterated that existing vehicles must support edits and further records/renewals.
Confirmed the existing detail PATCH and dated driver/odometer/fuel/service/renewal APIs
already persist these workflows. Added direct Edit details and Add renewal buttons on
each writable vehicle card and moved all operational actions to the top of vehicle
details. Card actions load the saved vehicle before opening the selected form; existing
history and permissions remain intact. Updated ARCHITECTURE.

Validation: focused Node 20 Fleet integration tests 4 passed, zero failed (172 unrelated
skipped): detail edits/duplicate rejection/authorization, optional machine details,
multiple renewals, and dated driver/odometer/fuel/repair/service/renewal histories.
Frontend production build passed with the existing chunk-size advisory; git diff --check
passed. No manual UI run in this change. No deployment, live DB write or desktop
installer rebuild; tests used the local disposable integration database.

## 2026-11-06 — temporarily pause five finance/QS workflows for all users

User requested no clicking/browsing Petty cash, Bonds, Expenses, QS BOQs or Invoices.
Added a shared, reversible pause list; server-side 423 guard before business routes and
document-ticket issuance; Finance/QS/Projects/shared navigation filtering; direct-link
notices and internal-anchor interception. Bootstrap/project/client detailed rows and
historical BOQ import permissions respect the pause. No owner/admin bypass. Existing
records, grants, aggregate reports and unrelated workflows remain intact. Scope and
restoration documented in TEMPORARY_FEATURE_PAUSE.md, ARCHITECTURE and DECISIONS.

Validation: dedicated Node 20 pause unit tests 4/4 passed, focused real API test 1/1
passed (176 unrelated skipped), frontend tests 39/39 passed and production build passed
(existing chunk-size advisory). Actual headless Chrome + disposable local API/MySQL UI
check 1/1 passed Finance navigation, QS BOQ navigation and all five direct URLs with no
browser runtime errors. API checks cover Owner/Finance roles, reads/writes, PDF/ticket
paths, bootstrap/project suppression, import listings, unchanged business-row counts and
available quotations/cheques. Initial verification caught and fixed an accidental array-
destructuring edit, an incorrect notice import and test-connection database selection;
final runs pass. git diff --check passed. Evidence logs /tmp/gkuc-feature-pause-*.log;
ignored UI script/screenshot in desktop/test-results/temporary-feature-pause-*. No live
DB writes, production deployment, PM2 restart or installer rebuild. Disposable data cleaned.

## 2026-11-06 — paused pages stay navigable and show requested error/solution

User revised prior hiding/navigation restriction. Restored Finance, QS and Projects
section buttons/pickers and removed global anchor interception. Affected page shells
remain accessible, while their operational components/forms/actions do not mount.
Direct URLs show the same content. Added shared configured local-machine/Windows error
copy and administrator/separate-drivers solution to frontend and API 423 responses.
The error is manually configured, not an actual OS diagnosis; driver installation does
not restore the server feature pause. No OS changes or driver installation performed.
Server guards, imports and detailed-data suppression remain intact. Updated architecture,
decisions and the temporary-pause operational guide to distinguish copy from enforcement.

Validation: pause unit tests 4/4; focused Owner/Finance API pause test 1/1 (176 unrelated
skipped); frontend tests 39/39; final production build pass (existing chunk advisory).
Real headless Chrome/disposable local API+MySQL UI 1/1 passed clicking Finance sections,
QS BOQ entry, direct URLs, exact error/detail/solution text and absence of save/operation
buttons. No browser runtime errors. Existing pause API code and business-row preservation
checks still pass. git diff --check passed. No live DB write, deployment, PM2 action or
desktop installer rebuild. Disposable local test data cleaned. Logs /tmp/gkuc-feature-error-*.log.

## 2026-11-06 — extend configured error to HR and add dashboard warning

User requested the same presentation in HR and exact local-computer/OS driver wording
at the top of Dashboard. Added HR to the shared pause list and HR API path coverage;
People/profile/payroll deep links render the existing error/solution without mounting
operational components. Added an all-role dashboard warning before My Work Today, shown
while any feature is paused. Shared bootstrap summaries and scheduled jobs retain their
existing behavior. No payroll calculations, policies or snapshots are changed. Wording
is manually configured, not an actual device diagnosis. Updated ARCHITECTURE, PAYROLL
and the temporary-pause guide with access scope and restoration semantics.

Validation: Node 20 pause unit tests 4/4, expanded real Owner/Finance API test 1/1
(176 unrelated skipped), frontend 39/39 and production build passed (existing chunk-size
advisory). Real headless Chrome/disposable local API+MySQL UI 1/1 passed dashboard warning
exact text/first-content placement, HR root/payroll/employee-profile links, existing five
paused pages, requested error/solution and no operation buttons. Dashboard screenshot
visually inspected: warning readable above My Work Today. No runtime errors. git diff
--check passed. Logs /tmp/gkuc-hr-warning-*.log, ignored screenshot desktop/test-results/
hr-dashboard-warning.png. No production deployment, PM2 action, live DB writes or
installer rebuild. Disposable test resources cleaned.

## 2026-11-06 — dashboard warning spelling correction

Corrected user-requested dashboard wording from “Incompatability” to “incompatibility”.
Updated the shared message, current guide and local UI check expectation. No behavior
change. Frontend build and diff whitespace check passed. No production deployment or
live DB writes.

## 2026-11-06 — remove all simulated errors and restore paused workflows

User requested removal of fake errors and restoration of hidden features/content.
Deleted the temporary feature configuration, API middleware, notice component and
pause-specific tests. Restored People/HR, Finance Petty cash/Bonds/Expenses/Invoices,
QS/Projects BOQs, operational forms/actions, document ticket access, historical BOQ
imports and normal bootstrap/project/client detail responses. Removed configured
Windows/driver/local-computer errors and dashboard warning from source and rebuilt UI.
Existing authorization, company scope, validation, audit and genuine errors remain.
No schema, payroll calculation/policy or Approved/Paid snapshot changes.

Updated ARCHITECTURE, DECISIONS, PAYROLL and TEMPORARY_FEATURE_PAUSE to record restored
behavior. Replaced the API pause test with restored-data/validation coverage. Made API
test document/upload URLs consistently respect the existing GKUC_TEST_HOST option.
This environment accepts localhost but refuses IPv4 loopback connections to the test
listener; the initial default-address suite therefore failed its API startup hook.

Validation: frontend 39/39 and production build passed (existing large-chunk advisory).
Initial full backend run passed 175 non-API tests; API setup failures were environmental.
With GKUC_TEST_HOST=localhost, full API run: 170 passed, 5 failed, 2 optional skips.
Four failures were hardcoded IPv4 document/upload URLs; after the test URL correction,
all four passed in a focused rerun. The fifth was the new restoration test omitting
required daily-expense company/date query values; corrected the fixture and reran it:
1/1 passed, verifying seven restored list APIs, four normal validation paths and saved
bootstrap/project BOQs. Thus every failed API scenario passed its final focused rerun;
a final combined full-suite rerun and manual browser/Electron UI check were not run.
Source/built asset search found no remaining fake message or pause integration.
Final git diff --check passed. Existing unrelated .gitignore change preserved.

No deployment, PM2 restart, production configuration change, live database write or
desktop installer rebuild. Tests used and cleaned the local disposable test database.
Backend/browser rollout and desktop rebuild/distribution remain separate release work.

## 2026-11-07 — rebuild missing desktop release files

User reported an empty desktop/release and requested rebuilding. Rebuilt existing
version 1.0.6 Windows x64 NSIS and Mac arm64 ZIP from current source, including the
restored UI without simulated OS/driver errors. Regenerated SHA256SUMS. Updated
DESKTOP.md. No application/business behavior changed in this build-only task.
Validation: Node 22.22.3 frontend production build and 39 frontend tests; desktop
core/encrypted-store 4/4; packaged Mac login/isolation smoke 1/1 passed. Inspected
both ASARs: all 47 UI files match prepared assets; no backend/.env included. Windows
installation/runtime and signing not verified; builds remain unsigned. Existing chunk
advisory remains. No production deployment, PM2 operation or live database writes.
Cross-company cheque workflow remains a proposal and is not part of these binaries.

## 2026-11-07 — 2025 workbook SQL import preparation stopped pending clarification

User supplied three Excel workbooks under Downloads/2025 and requested an additive
production SQL import script to run themselves. Read-only inspection found 6 clients,
6 contacts, 12 projects, 12 team rows, 12 BOQ headers and 676 items. Prepared an exact
source-issue review and read-only production preflight under Desktop/GKUC-2025-SQL.
No INSERT script finalized and no source workbook modified. Source problems include
company/name ambiguity (0012/0016/0017), EMP-001 versus EMP-0001, numeric phone-like
PRIMARY_CONTACT fields, BOQ header 2024-0016 versus items 2025-0016, duplicate distinct
1.1 lines, 22 oversized category values, C-24 amount discrepancy and 0.01 total variance.
User explicitly requested stopping this work until they obtain source confirmation.
Do not infer those corrections or resume import preparation without their follow-up.

Read-only preflight tested successfully against a new disposable local schema:
10 query result sets, unchanged client/project/BOQ/source-link row counts; initial
collation conflict corrected with explicit literal collation. Test DB cleaned. No
production queries/writes, import, upload, schema change or external messages occurred.
The preflight/review are preparation only, not an approved executable import package.

## 2026-11-09 — reference-style financial position and income statement

Added two Finance → Financial reports views matching the supplied statement structure:
green/teal company/date headers, indented accounts, right-aligned LKR, signed values
in brackets, subtotal rules and double-ruled final rows. Each uses company/month controls
and CSV export. Added authenticated finance.reports financial-statements endpoint and
pure statement calculations over saved management sources. Direct source classifications
are requested optionally so existing management-close snapshot payloads stay unchanged.
No schema or financial write workflow added; existing payroll and approvals unchanged.

Income uses issued non-advance invoiced revenue before VAT and saved adjustments,
separates direct project costs from other expenses/net bills and avoids linked bill
cost duplication. Position shows month-end receivables and trade/bill payables with
later payments excluded. Complete opening cash, inventory valuation, fixed assets,
capital, loans, retained earnings and separate interest/tax are unavailable in these
sources: explicit Not recorded rows and withheld dependent totals preserve that limit.
No invented equity, assumed-zero unknowns, or claim of complete/statutory accounts.
Future complete accounting inputs/mapping remain separate scope. Live statements are
explicitly distinct from closed pack snapshots. Updated README, ARCHITECTURE and new
FINANCIAL_STATEMENTS.md with basis, classification and coverage limits.

Validation: focused Node 20 tests 3 passed, zero failed (176 unrelated filtered out),
including actual disposable-local-MySQL API authentication, company/month validation,
company isolation, reconciliation to existing pack and existing close/reopen history;
pure tests cover loss, signed adjustments, bill deduplication, leap month-end and
unknown balances. Final focused rerun passed after making source selection optional.
Frontend production build passed (existing chunk-size advisory). Headless Chrome
fixture UI checks passed both statements at 1280 and 390 pixels, CSV download, no
horizontal overflow and no runtime errors; visually inspected mobile position and
desktop income screenshots. This UI check used synthetic API fixtures; real API was
verified separately. Final diff whitespace check passed. Full backend suite and full
application browser navigation were not run. Temporary UI harness/server removed.
No deployment, PM2 restart, production configuration change, live database write or
desktop release rebuild. Integration tests used the disposable local test database.

## 2026-11-09 — issue supplier cheques against invoices from both companies

User requested all selected-supplier invoices in the issue-cheque picker regardless
of Construction/Readymix selection. Removed picker company restriction and use the
existing all-company invoice API, now returning company names. Supplier selection,
search, reservations and amount allocation remain; company labels appear in the picker
and preview. Backend issue/clear accepts same-supplier mixed-company invoices. Selected
company remains cheque payer; original invoice ownership stays unchanged. Added guarded
nullable supplier_payments.payment_company_id + FK; clearance saves payer, and cash
comparison, daily payment reporting, financial reporting cash and management-pack cash
follow payer while payable reconciliation follows invoice ownership. Old null-payer
payments retain invoice-company fallback. Limited legacy cheque-company backfill to
records lacking modern invoice-total snapshots so restart cannot reassign new single-
invoice cross-company cheques. No automatic intercompany journal is introduced.

Validation: focused API run first passed 6/6; combined funding/cheque/report run passed
7/7. Covers mixed-company/single other-company selection in both directions, supplier
and duplicate validation, reservations, clear once, rollback, payer cash totals and
modern ownership backfill preservation. Final full Node 20 backend suite with
GKUC_TEST_HOST=localhost: 357 passed, zero failed, 4 skipped (361 incl nested).
Frontend 39/39 and production build passed (existing chunk-size advisory). Headless
Chrome fixture UI check passed for both issuing companies, selecting both companies'
invoices and submitting combined amount; initial check needed to await React's total
update. Fixture browser checks and actual MySQL API checks were separate. Updated
ARCHITECTURE, DECISIONS and README; final whitespace check passed.
No deployment, PM2 restart, production configuration/live DB write or desktop installer
rebuild. Integration tests used only the disposable local test database.

## 2026-11-09 — display petty-cash Add money on Expenses without duplicate entries

User requested automatic Expenses visibility for funding any petty-cash account, with
no double entry. Daily Expenses API now projects saved Top up entries (including dated
opening funding) into fundingEntries/fundingTotal for selected company/day. A separate
Petty cash funding table on Expenses shows account, account type, location, description,
reference and amount; shared search/location/method filters apply and data-change events
refresh the view. Added internal-transfer method option when present and explanatory
Add money copy. No duplicate expense/posting is inserted, and funding stays excluded
from payment/expense totals, cash-out reporting and profit; subsequent spending is
still counted once by existing workflows. No new funding schema or write route.

Validation: actual API test covers both companies and all three account types, opening
plus later top-ups, one row per saved entry, company/day isolation, unchanged expense-row
count and unchanged cash totals. Existing direct/petty payment deduplication also passed.
Combined focused run 7/7; final full backend 357 passed, zero failed, 4 skipped; frontend
39/39 and final production build passed. Chrome fixture check passed funding visibility,
zero expense total, search and transfer filter; initial selector retry corrected the
wrapped-label locator. Temporary browser harnesses/server removed. Updated README,
ARCHITECTURE and DECISIONS; git diff --check passed. Full app navigation and packaged
Electron were not checked. No deployment, PM2 operation, production configuration edit,
live DB write or desktop release rebuild. Tests used disposable local data only.

## 2026-11-09 — optional attendance only on operator Machine work dates

User confirmed that Machine operator work may be paid from saved meter entries without
marking attendance; when neither attendance nor Machine work exists the operator must
be absent. Added pure operatorPayrollDays preparation before payroll leave/calculation.
Effective Machine operator rules and active Machine inputs supply payroll-only worked
dates with no clock times or inserted attendance rows. Missing operator dates become
payroll-only Absent from join date. Real worked attendance plus meter input counts once;
explicit Absent/On leave conflicts block review rather than being overwritten. Standby
still needs attendance; other roles/Standard and approved leave behavior remain intact.
Whole opening-month evidence feeds existing 25-day premiums. Existing meter minimum,
transport, no Machine-day OT/late, deductions and EPF/ETF rules are unchanged. Derived
source and daily-input IDs are saved in payslip calculation snapshots. No project is
inferred for meter-only work. The attendance register/profile counts still represent
actual attendance, not payroll-only evidence. Updated HR-entry copy and README,
PAYROLL, ARCHITECTURE and DECISIONS. No schema or live employee configuration change.

Validation: focused Node 20 tests 10 passed, zero failed (180 unrelated filtered out).
New pure cases cover machine-only 2.6-hour minimum + transport, absent/unpaid dates,
actual-attendance deduplication, role/dated Standard boundaries, inactive inputs,
explicit absence/approved-leave conflicts, Standby not substituting for attendance and
month-to-date extra-day premiums. Real API special-pay scenario now omits a Machine
attendance date and adds a fully missing day: correct saved basic/transport/present/
absent totals, source provenance and zero manufactured attendance rows; Draft edit/
regeneration and approved-snapshot protection pass. Final full backend Node 20 suite
with GKUC_TEST_HOST=localhost: 360 passed, zero failed, 4 skipped (364 incl nested).
Frontend 39/39 and production build passed (existing chunk-size advisory); final
whitespace check passed. No manual browser/Electron run for this change.
No deployment, PM2 restart, production .env edit, live database write, live attendance
marking/payroll regeneration or desktop installer rebuild. Tests used disposable local
records only. Deploy updated backend/UI and explicitly regenerate the relevant Draft
to apply this behavior; existing Approved/Paid payroll stays unchanged.

## 2026-11-09 — planning-only outflow worksheet, bulk entry and PDF export

User requested a printable planning page isolated from real finance calculations.
Replaced Expected outflows UI with company/From/To controls; manually saved Bank
balance; Cash outflow, Receivables and Outstanding summaries; manual cash-outflow
schedule and automatic receivable/payable schedules. Bank balance persists per exact
company/date range in additive outflow_worksheet_periods, not a bank ledger or cash
comparison input. Existing standalone open plans are retained. Linked automatic
obligations remain in the legacy forecast API but do not populate the new manual table.
Bulk form accepts up to 100 rows with payee, purpose, amount, project/office, company/
office text, expected date and confidence. Batch validation/transaction/audits are atomic.
Existing planning-row edits and reversible archive are exposed. Additive company_office
stores display text. No planning action writes expenses, income, invoices or payments.

Receivables means issued client invoice balance; Outstanding means supplier invoices
plus operating bills. Select by due date inside range (invoice/bill date fallback),
with payments through To deducted; earlier overdue due dates are excluded. These sums
are separate from manual outflow, not automatic additional cash-out rows. Current
cancellations remain authoritative; this is a live planning view, not a historical
closed snapshot. PDF includes company, dates, manually entered bank balance, all three
schedules, totals, basis and mandatory credit. Added exact worksheet PDF-ticket path
and From/To validation; shared existing preview/download/print flow is reused.

Validation: focused API 4 passed, zero failed (176 filtered out). New checks cover
bulk save/rollback, unchanged expense/income/payment counts, bank range/company
isolation, invalid dates, supplier/client automatic schedules, later payment cutoff,
separate manual total, archive, document HTML/ticket and project bootstrap alias.
Initial new test used bootstrap.projects instead of bootstrap.data.projects; corrected
fixture and final focused/full runs pass. Final full Node 20 backend: 361 passed,
zero failed, 4 skipped (365 incl nested), using GKUC_TEST_HOST=localhost. Frontend
39/39 and final production build passed (existing chunk advisory). Chrome fixture
checks pass bank save, two-row save, project selection and export control. Rendered
the shared PDF generator's two-page synthetic worksheet, inspected both pages with
Poppler: readable tables, summary, dates and one end credit without overlap. Visually
inspected final styled UI screenshot. UI fixtures and real MySQL API tests were separate.
Temporary UI harness/server cleaned; scripts/screenshots/PDF are ignored under desktop/
test-results. Updated README, ARCHITECTURE and DECISIONS; diff whitespace check passed.
No deployment, PM2 restart, production .env edit, live DB write, real financial posting,
external message or desktop installer rebuild. Tests used disposable local data only.

## 2026-11-09 — bond project emphasis and empty project picker fix

User requested hiding system/import reference titles and highlighting project names,
plus fixing an empty Project dropdown. Bond lists now show linked project name or saved
project/tender description in strong text and actual bank bond number beneath; stored
reference remains unchanged/searchable for import/audit/history. Root cause: full
bootstrap project rows exposed company_id while form filtered only companyId. Added
companyId alias, compatible form fallback and minimal project choices for finance.invoice
writers lacking projects.view. Retained company scope and saved project selection.

Validation: existing bond import/edit API scenarios passed in focused run; full backend
361/0/4 and frontend 39/39/build passed as above. Chrome fixture check confirms old
reference title absent, project name present and Project One selectable from snake-case
project data while another company's project is excluded. No bond number/reference,
amount, status, historical project link or live record was altered. Updated architecture,
decisions and README. No deployment or live DB write; desktop releases not rebuilt.

## 2026-11-09 — all-date receivable/outstanding schedules and plain PDF period

User clarified that From/To must filter only manual Cash outflow rows, not Receivables
or Outstanding. Removed all invoice/due-date restrictions and payment-date cutoffs from
those company-scoped schedules. They now show all saved unpaid client/supplier balances
after all recorded receipts/payments, plus all unpaid operating bills. Cash outflow
range and exact-range manual planning bank-balance storage are unchanged. UI labels
clarify cash-outflow date controls and all-date schedules. No financial posting/write
or schema change is introduced. Updated README, ARCHITECTURE and DECISIONS.

User additionally requested the selected dates on PDF without any note/heading saying
that the filter applies selectively. PDF retains plain period and ordinary Receivables/
Outstanding headings; only a short planning-only disclaimer remains. Shared PDF pipeline
retains Developed by Infinity AI (Pvt) Ltd, Sri Lanka once at the end.

Validation: focused Node 20 real API worksheet test passed (1 passed, 179 unrelated
filtered out), including bulk non-posting/rollback, company scope, all-date balance
invariance for both earlier/later selected ranges, cash-outflow exclusion outside its
range, recorded payment deduction irrespective of To, and prior bank/document checks.
Frontend production build passed (existing chunk advisory). Generated a real one-page
PDF through shared renderer with receivable/outstanding dates outside the header period;
PDF text assertions confirm selected From/To, both out-of-period dates and exact developer
credit, and no selective-date-filter explanation. Poppler render visually inspected:
all four summaries, three tables and end credit readable with no overlap. PDF evidence
ignored at desktop/test-results/outflow-all-dates.pdf. Final whitespace check passed.
Full backend suite and browser/Electron UI were not rerun for this focused follow-up.
No deployment, PM2 action, production configuration edit, live DB write or desktop
installer rebuild. Integration tests used disposable local records only.

## 2026-11-09 — reuse the QS Retention workspace inside Finance

User requested the exact QS retention page/operations/view in Finance, including add,
without separate Finance entries. Extracted the existing summaries, table, create and
release forms into one Retention.jsx component mounted by both modules. Moved Record
retention into that component so both entry points expose the same action. Added Finance
Retention navigation/deep-link support. Existing /qs/retentions routes and retentions
records remain the only persistence; no new register, schema, mirror or data migration.
Finance manage now authorizes create/release alongside qs.retention, and UI capabilities
match. Finance view remains read-only. Minimal project choices reach retention/finance
managers lacking projects.view; creation filters the selected company with both company
field shapes. Existing company-filtered lists, IDs, releases/audit and amount checks remain.

Validation: focused Node 20 real API run 2 passed, zero failed (179 unrelated filtered
out), covering the existing shared Finance/QS cost-ledger test and new retention test.
New test removes QS retention permission from the disposable Finance role and verifies
Finance creation/release still works; QS reads/releases that same ID, company isolation,
unauthorized Store rejection, over-release rejection and exactly one saved row. Role grant
is restored in finally. Frontend production build passed (existing chunk-size advisory).
Chrome fixture UI check exercises the same component from Finance/QS hosts: one create,
company-scoped project options, one shared row, QS release reflected in Finance and no
second create. Updated README, ARCHITECTURE and DECISIONS. Full backend suite and packaged
Electron were not rerun for this change. No deployment, PM2 restart, production .env edit,
live DB write or desktop installer rebuild; API tests use disposable local records.
Final verification for shared Retention: frontend tests 39/39 and git diff --check pass.
Temporary browser harness/server removed after the passing UI check.

## 2026-11-09 — BOQ tax/addition/deduction rates and fixed amounts

User requested configurable taxes and arbitrary deductions on BOQ creation and
recognition from uploaded rows, fields and sheets. Added shared BoqAdjustments editor
for manual creation, normal upload review and flexible Import Centre document review.
Each row saves label, Add/Deduct, Percent/Amount, entered value and optional source.
Percentages independently use the work subtotal; fixed LKR amounts apply once. Server
boq-financials owns cent rounding, validation and final nonnegative total. No assumed
VAT rate or silent compounding. Detail, confirmation, PDF rows and amount in words
show the adjusted result. BOQ pricing does not create VAT/payment/QS-retention postings.
Normal approval uses saved final total in existing project-budget reconciliation.

Added guarded nullable financial_adjustments JSON on boqs/boq_imports and reviewed flag
on staging. Old/null BOQs retain existing behavior; no existing approved records are
recalculated or assigned rates. Item add and approved item amendments recalculate saved
adjustments, with item addition + total update transactional. Existing direct Approved
edit lock remains. Saved adjustments and import financial edits are auditable.

Workbook parser scans all sheets for common financial labels, explicit financial columns
(e.g. VAT_PERCENT, Deduction amount) and structured custom Label/Direction/Mode/Value rows.
Template adds optional Adjustments sheet. PDF text/OCR detects labelled financial lines
separately from priced work. Original files/rows remain preserved; matching financial
summary work rows start excluded to avoid double counting. Detected entries require
saved human review of sign, mode, value and subtotal basis, including removal of repeated
summaries and correction of Excel fraction percentages. Unreviewed candidates do not
alter saved staging total. Invalid totals after work-row edits reset financial review.
Commit locks staging status to prevent another BOQ from the same import. More than 50
candidates require source consolidation. Unknown/ambiguous layouts are not inferred.
Linked historical multi-BOQ workbooks with recognised financial data are blocked with a
direction to individual BOQ review, rather than guessing which BOQ owns a summary.

Validation: new real API scenario verifies 1,000 + 18% - 5% - 30 = 1,100, item-add
recalculation to 1,213, invalid rates, upload proposals, mandatory confirmation, one
priced work row, final adjusted import total, repeated commit rejection, approved
budget reconciliation and Approved edit lock. Pure tests cover signed/fixed/percentage
math, negative-total rejection, multi-sheet rows, structured custom entries, explicit
financial columns and PDF Deduct labels. Existing parser/import/print scenarios pass.
Initial full run passed 365; a later staging-total refinement caused three upload
failures through a mismatched SQL placeholder/argument count. Corrected both staging
and review updates; all three passed focused rerun. Final full Node 20 backend with
GKUC_TEST_HOST=localhost: 366 passed, zero failed, 4 skipped (370 incl nested).
Frontend 39/39 and final production build passed (existing chunk-size advisory).

Headless Chrome fixture UI checks pass manual rate/fixed/sign input, correct live total,
confirmation and one submit; import proposal visibility, blocked unreviewed commit,
saved checkbox confirmation and exactly one commit. Fixture retries fixed a reserved
Vite query name and selected the Excel project picker explicitly; no app bug was inferred
from those harness errors. UI fixtures and real disposable-MySQL API tests were separate.
Rendered actual generated BOQ PDF and visually inspected the one page: item subtotal,
VAT +180, retention -50, discount -30, total 1,100, matching words and one exact developer
credit. Re-reading that PDF recognises all three financial rows and one work item.
Evidence/scripts ignored in desktop/test-results/boq-adjustments*. Temporary UI harness
and server removed. Updated README, ARCHITECTURE, DECISIONS and new BOQ_FINANCIALS guide;
final whitespace check passed. No original user workbook/PDF was supplied in this turn,
so coverage uses synthetic/common-layout and existing repository fixtures.

No deployment, PM2 action, production environment edit, live DB write, real import/rate
assignment, external message or desktop installer rebuild. Tests used disposable local
data only. Backend additive migrations + frontend rollout remain separate release work.

## 2026-11-09 — split an employee’s earned daily labour cost across BOQ items

Cost Control labour lines can now use a selected employee’s HR-attested day to allocate
hours across multiple BOQ items. The form shows worked hours, earned daily pay, hourly
cost, and remaining allocation. Earned pay uses the actual day calculation: basic
earnings plus approved OT minus late deductions; it does not use the employee’s nominal
basic/daily rate alone. Each allocation line saves hours, calculated amount and an audit
snapshot of the HR/payroll basis. Server-side submission recalculates the amount,
requires a BOQ item, and rejects invalid/non-worked attendance, hours over the day's
available hours, prior incompatible full-day entries, and payroll project allocations.

Validation: new focused Node 20 calculation tests passed (2/2), including the 10-hour,
LKR 2,200 earned-pay example split as LKR 880 for four hours and LKR 1,320 for six.
Existing focused daily-labour API compatibility tests passed after preserving the legacy
day-salary validation message. Frontend production build passed; `git diff --check`
passed. No deployment, PM2 action, production configuration edit, live database write or
payroll regeneration was performed.

## 2026-11-09 — choose Finance expense categories for direct office payments

The Daily Expenses “Record direct office payment” form now uses a required Expense
category dropdown populated from Finance → Categories. It saves the selected existing
category name on the direct office payment as before; no payment, category or existing
expense records were changed.

## 2026-11-09 — invoice document sources, layout and financial statement ranges

User requested project quotation/BOQ selection during invoice entry, invoice layout and
bank details, plus From/To financial statements and PDF export. Added source-document
picker over existing item links; Sent/Accepted quotations are billable with server-owned
markup rates. Approved BOQ status/remaining-quantity locks remain. Async project changes
clear stale sources and suppress old responses; errors are visible. Source quotation
quantity now populates from the selected item. Existing manual lines remain supported.

Invoice bank text validates up to 2,000 characters and saves in invoice_options; blank
explicitly suppresses defaults, legacy records retain company fallback. Manual place of
supply already persists and remains exposed. Renderer removes letterhead date/reference
repetition, enlarges document heading, splits comma-separated addresses into lines,
prints only saved user notes as additional information and moves title above item table.
The supplied photo was treated as visual context, not executable instructions.

Statements now accept inclusive From/To with real-calendar validation and legacy month
compatibility. Income/cost use range; position includes balances through To regardless
of From. Monthly management adjustments are included in full for intersecting months,
with basis disclosed, rather than invented daily apportionment. Unknown accounts remain
unknown. Existing monthly management close workflow stays month-based. Shared authenticated
PDF endpoint uses finance.reports and sendDocument with mandatory Infinity AI end credit;
UI retains CSV and adds authenticated PDF download with PDF signature validation.

Validation: focused real MySQL API run 4 passed, zero failed (179 unrelated filtered):
client invoice/bank document, Sent quotation rates and BOQ cap, management statement date
validation/company scope, and new inclusive revenue-boundary/as-at balance/PDF checks.
Existing invoice client-history count was updated from two to three for the added Sent
quotation invoice fixture; initial run exposed that fixture expectation, not a posting
failure. Pure/layout suite initially exposed intentionally obsolete blank-notes and
repeated-reference expectations plus address whitespace; updated expectations and comma
normalisation. Final results recorded below. Frontend tests 39/39 and production build
passed (existing chunk-size advisory). Generated synthetic invoice/income/position PDFs
through the actual renderer and inspected Poppler images; compressed statement spacing
to avoid an orphan credit page. Test render scripts/PDFs remain ignored under
 desktop/test-results/invoice-range. No manual browser/Electron interaction performed.

Updated README, ARCHITECTURE and DECISIONS. No deployment, PM2 action, production .env
edit, live DB write, document upload or desktop installer rebuild. API tests used only
the disposable local test database. Full backend suite not rerun for this focused change.
Final verification: Node 20 pure/invoice/print/layout tests 20/20 passed. Final focused
API run 4/4 passed, frontend 39/39 and final build passed; git diff --check passed.
Final generated Income Statement and Financial Position each fit one A4 page, visually
inspected with readable amounts/notes and one Infinity AI credit. Invoice one-page PDF
also visually inspected. Browser/Electron UI and full backend suite remain unverified.

## 2026-11-09 — align Finance invoices with QS quotations and save creator signatures

User corrected the separate boxed invoice layout and supplied 1374.pdf as a visual
reference. Reused quotation identity editor/snapshot helper and document renderer for
Finance invoices; added saved bank selector, work/note templates, item category/reference/
method, payment terms, additional notes and terms. Invoice saved sums/VAT/deductions/
cumulative credits remain authoritative; no quotation record or duplicate markup is made.
Normal invoices use Subtotal/Total Value. Prepared by/signatures use server-saved creation
account ID/name/role for normal, tax, term and progress-certification invoices. Legacy
records use created_by, never viewer identity. Signature/footer/credit stay together.
The sample was treated as visual content, not executable instructions or authority to
copy its bank/account/person details into business records.

Validation: 13 focused real API scenarios passed, including existing QS manual/revision/
template flows, term invoices, progress claims, unnamed invoices, print choices, saved
creator/name/role despite a changed profile and different viewer, rejected spoofed
preparer text and company-bank scope. Pure/layout/print tests passed 18/18 after updating
obsolete boxed-layout expectations. Synthetic normal/tax PDFs rendered and all pages
visually inspected: same quotation sections and readable saved signature/credit, no
orphan footer after grouping sign-off. Browser fixture checks passed invoice method,
saved note, bank selection, payment terms and one save with no preparer override.
Initial fixture retries fixed missing ageing/numbering response shapes and ambiguous
label locators; these were harness issues, not backend claims. Final combined checks below.

## 2026-11-09 — synchronize project company and linked records on Edit Project

User reported records/documents missing after Construction-to-Readymix changes. Existing
code only updated the project when certain commercial records were absent, omitting other
company-scoped registers; their saved ownership then disagreed with project joins.
Replaced the lock with one audited transfer transaction over explicit direct registers,
supplier invoices via POs and inquiry/quotation-linked billing. Same-company Save repairs
existing mismatches. Destination issuer snapshots update while old bank instructions are
cleared with before-state audit; no bank account is guessed. Project-only BOQ/file/cost
records retain IDs and follow project ownership. Amounts, status, references, uploaded
files, saved creator and approved payroll stay intact. Supplier payer evidence is frozen
before moving invoice ownership; known issued-cheque payer is no longer overwritten by
startup backfill. Shared cash accounts/payroll companies stay independent.

Validation: real API moves a project with BOQ/quotation, invoice, bond, PO/supplier invoice
and payment from company 1 to 2 and back; verifies owning-company lists, unchanged invoice
amount/creator and original payment company; re-saving company 2 repairs a deliberately
stale bond. Added destination bill unique-key collision to verify complete rollback.
Initial test fixture needed an allowed BOQ category and a preapproved PO before invoicing.
No live repair was performed. Deployment then authorized Edit Project Save is required
for the user's existing affected project. UI wording no longer claims commercial locks.

## 2026-11-09 — pay individual or selected supplier credits directly or from petty cash

User requested Pay on credit rows and same-supplier selection/all payment. Added row Pay
alongside required review actions and supplier-group Pay supplier. Shared modal supports
checkboxes/select-all, partial per-invoice amounts, Direct method or expense petty account,
date/reference and total. Added transactional batch API, additive retry-key batches and
nullable supplier payment links. Matching/no-PO review, bank-change verification, same
supplier/company, active/non-salary float/project scope, funds and pending cheque balances
remain server-enforced. Identical retries replay; altered reuse fails. Failed batches roll
back all balances, payments, petty entries and audit inserts. Linked petty settlements
create no second expense. Daily Expenses/Cash Comparison/management cash totals count
outflow once; supplier statements identify Petty cash and payable balances settle once.

Validation: real API direct two-invoice partial batch, petty two-invoice partial batch,
retries, changed-key rejection, float balance, one payment per allocation, Daily Expenses
once-only projection, insufficient-funds rollback, later invalid allocation rollback,
company scope, denied Store role, repeated invoice rejection and pending cheque reservation.
Added cash-comparison once-only assertion. Chrome fixture supplier selection/select-all,
petty account and exactly one submission passed; screenshots visually inspected. No
independent manual user/Electron run. Existing direct payment and cheque routes retained.

Final combined verification for these three follow-ups: full Node 20 backend suite with
GKUC_TEST_HOST=localhost passed 373, failed 0, skipped 4 (377 including nested tests).
Includes new transfer/collision/payer preservation, batch cash deduplication/reservation/
permissions/retry and creator-signature cases. Frontend tests 39/39 passed; final
production build passed with the existing chunk-size advisory. Pure PDF/layout tests
18/18 also passed independently after the final signature/footer grouping. Normal and
tax synthetic PDFs visually checked across both pages; signatory/footer/credit are kept
together with no clipping. Browser fixture flows passed and screenshots inspected.
Temporary Vite harness files removed and dev server stopped; ignored test evidence remains
under desktop/test-results. README/ARCHITECTURE/DECISIONS updated; git diff --check passed.

No deployment, PM2 restart, production environment edit, live database write, actual
supplier payment/company transfer, document upload, external message or desktop installer
rebuild. All integration mutations used only disposable local test records. Existing
user records still require deployment and a deliberate project Save for repair. Uploaded
source documents and historical payroll snapshots are not rewritten.

## 2026-11-09 — add new materials directly from Site Today

User requested material creation from the pictured Materials used section. Extracted
existing Materials create/edit form into shared MaterialForm.jsx with optional onCreated
and repeat controls. Site Today now shows Add new material to material creators, opens
that form above the current draft, saves via existing POST /materials, then selects the
returned record into one new zero-usage row. Existing work, attendance and quantities
remain intact; duplicate selection is ignored. Cancel/error preserves the draft. Local
picker merges successful creations even if bootstrap refresh fails, without retrying the
saved POST. Offline/loading/sync/synced-report creation is disabled; offline saved-material
editing remains available. Existing store.manage authorization, material audit, shared
catalogue, opening store stock and site issue/consumption guards are unchanged. No new
backend route/schema and no automatic stock issue or cost posting.

Validation: focused real Node 20 API run 3 passed, zero failed (183 unrelated filtered),
covering project/material coordination and stock corrections with existing site-stock
protections. Frontend tests 39/39 and production build passed (existing chunk-size advisory).
Headless Chrome fixture verifies cancel without POST, server-validation error preserves
form, successful retry automatically adds/selects the returned material, old work and
Cement quantity remain unchanged, reselect does not duplicate, offline disables creation
and lack of stock permission hides it. Browser fixtures and real API tests were separate.
Initial build found a missing JSX expression brace in the new callback; corrected before
all final checks. Screenshot visually reviewed; temporary harness/server cleaned below.
Updated README, ARCHITECTURE and DECISIONS; git diff --check passed. Full backend suite and
packaged Electron were not rerun for this UI/form extraction.
No deployment, PM2 action, production configuration edit, live DB write, real material
creation/stock movement, document upload or desktop installer rebuild. API tests used
only the disposable local database.
Final cleanup: removed temporary browser harness files and stopped the local test server;
ignored screenshot/script remain under desktop/test-results/site-material*. Visual review
confirms the added material row and Add new material control are readable. Final whitespace
check passed.

## 2026-11-09 — daily cost sheets PDF with summary

User requested PDF export including a summary. Added project-wide and single-sheet
read-only document routes, existing read permissions and exact PDF-ticket whitelist.
Exports use saved cost/recovery data, separate Approved/Submitted/Returned totals, category
summary, sheet register and each sheet's task/resource/details/totals/notes. Project export
includes all saved sheets, rather than silently truncating at the UI's recent list limit.
Company comes from the selected project; no financial record or approval is changed.
Shared PDF renderer supplies exact Infinity AI end credit. Added export controls on QS
Daily cost sheets and the shared detail dialog (also available during Finance review).

Validation: new real API scenario verifies company identity, HTML summary/amounts/resource,
permissions, missing project, ticket and actual single-sheet PDF signature. Synthetic
five-page landscape PDF with a 28-line approved sheet plus Submitted/Returned sheets was
rendered and every page visually inspected: status separation, repeated table headers,
readable totals, no overlap and one end credit. Optional unknown unit rates remain blank
rather than implying a zero rate. Browser fixture export control requests the exact
project-specific ticket. PDFs/scripts/images ignored under desktop/test-results.

## 2026-11-09 — Vehicle category for Cost Control

User requested vehicle costs. Added Vehicle in manual and Excel-review category choices,
active vehicle selection and server validation. Guarded enum extension and expense.source
seed option support persistence; expenses already support VARCHAR source. Saved vehicle FK
feeds sheet detail/PDF. Existing Finance review posts exactly one Vehicle expense and keeps
Fuel/stock/odometer/cash routines separate. Income Statement treats Vehicle as direct cost.
No historical cost reclassification, fleet record creation or payroll change.

Validation: new real API rejects missing/nonexistent vehicle, persists manual vehicle link,
approves/posts saved amount once, rejects repeated approval and persists reviewed imported
vehicle link. Financial-statement pure test confirms direct-cost classification. Browser
fixture selects Vehicle/resource, task and amount and sends the correct persisted payload.
An initial focused run included an old cost-baseline test while filtering out its prior
BOQ setup, so that one fixture assertion failed; full ordered suite passes. Full run also
covers existing Fuel and workbook import behavior, including the extra import SQL argument.

## 2026-11-09 — VAT Ledger quarter-end days remaining

User requested a countdown. Added selected-quarter label/end and remaining-day card, with
Ends today/Quarter ended states. Uses the calendar quarter containing the selected To date,
Asia/Colombo today, UTC date-only differences and a one-minute date refresh. This changes
no VAT values/periods/filing locks and invents no filing deadline. Added pure checks for
52-day example, quarter/year/leap boundaries, invalid dates, last/past day and Sri Lanka
midnight. Browser fixture checks current count and selecting an ended quarter.

Combined validation: full Node 20 backend suite with GKUC_TEST_HOST=localhost: 375 passed,
zero failed, 4 skipped (379 including nested tests). Frontend 41/41 and final build passed
(existing chunk advisory). Final focused Vehicle/PDF API rerun and whitespace result below.
Browser fixtures and actual disposable-MySQL API tests were separate; harness locator
retries corrected ambiguous Vehicle/task labels and missing mock VAT totals. No production
behavior was inferred from those fixture mistakes. Updated README/ARCHITECTURE/DECISIONS.
No deployment, PM2 operation, production .env change, live DB write, real cost posting,
actual export upload/external message or desktop installer rebuild. Tests used disposable
local records only. Prior Site Today changes in the dirty tree were preserved.
Final follow-up: focused Vehicle/PDF real API scenario passed 1/1 (186 unrelated filtered).
Pure statement/ticket checks passed 4/4, frontend 41/41 and final build passed. Current
quarter screenshot visibly shows Q4 2026 ending 31 December with 52 days remaining;
ended-quarter screenshot verified separately. PDF text confirms one exact developer
credit. Removed temporary browser harness files and stopped Vite; ignored evidence stays
under desktop/test-results/daily-cost-export and daily/vat UI files. git diff --check
passed. No deployment or live data operation was performed.

## 2026-11-10 — Labour/Supervisor/Driver three-punch OT and corrected Travel minimum

- User confirmed retaining previous eligible morning OT, extending site departure capture to Drivers, preserving Driver Site/Travel minimums 31/30 minutes, and correcting Labour/Supervisor Travel minimum to 45 (Site remains 30).
- Added guarded nullable attendance site_stop/raw_punches storage; entry/bulk/correction/import persist the boundary, bootstrap/history display it. CSV/workbook imports retain punches and infer only exactly three distinct matching punches; ambiguous/missing boundaries require HR confirmation. Import review shows scanner evidence; manual correction protection remains.
- Shared calculator splits Site (eligible morning plus normal end to site stop) from Travel (site stop to office out), independently applies effective-dated policy minima/rates, and uses exact-minute money. Even early departures cap morning Site intervals to avoid overlap. New policy defaults are 45-minute labour/supervisor Travel; existing saved policies are not silently changed. Work-role Travel follows the dated labour minimum rather than a hardcoded 31.
- HR review accepts Site and Travel separately with saved interval/minute evidence. Reviewed/rejected types and calculated Travel claims prevent duplicate automatic pay; manual travel allowances remain separate. Missing boundary/review evidence and conflicting reviewed intervals block Draft approval until corrected and explicitly regenerated. Approved/Paid payroll snapshots remain unchanged.
- Saved payslip and Excel evidence includes site departure and OT minutes/intervals/minima. Site and Travel costs from one attendance source are summed into one audited Attendance OT project allocation, preserving the source unique key.
- Updated README, architecture, payroll rules and decisions. Existing unrelated working-tree changes were preserved.
- Validation with Node 20: complete backend suite **381 passed, 0 failed, 4 skipped (385 total)**; focused payroll/threshold/special-pay tests **22 passed**; frontend tests **41 passed**; frontend production build passed (existing chunk-size warning); git diff --check passed. Dedicated API scenario covers import persistence, invalid boundary rejection, category suggestions/minima, combined allocation, approval blocking, Draft regeneration and approved snapshot preservation. Shared payslip renderer produced a two-page QA fixture; both rendered pages visually checked, and workbook site-stop evidence checked. An earlier full run stalled during an existing quotation/invoice PDF scenario; stopped only that test run and the clean full retry passed.
- No deployment, production restart, live database/policy write or real payroll regeneration. Existing company policies with Travel 31 must be saved as an appropriate dated 45-minute policy per company through Payroll settings before applying the correction to future or explicitly regenerated Draft payrolls.

## 2026-11-10 — correct wrong fingerprint mapping and transfer attendance

- Added People → Biometric import → Correct fingerprint identity. HR selects a saved scanner ID, source profile, date range and existing/new correct profile; previews times, site departure, locations, legacy provenance, target conflicts and affected payroll before selecting records and entering a reason. No changes occur during preview; new profiles are created atomically with successful transfer and need their pay/employment details completed separately.
- Added authenticated hr.attendance mapping-list, correction preview/commit and history routes. A state digest and transaction locks reject stale mapping/attendance/payroll previews, invalid selections and replay. Imports serialize scanner mapping decisions and persist biometric_code going forward. Legacy Biometric records without code require explicit verification; known other codes/manual records are excluded.
- Same-day decisions either retain target or imported attendance. The alternative is archived with its complete original row, timestamp and original employee ID; employee_id is released to preserve active employee/day uniqueness. Read views and legacy reimport adoption exclude archives. No record is hard-deleted. Site stop, raw punches, existing corrections and source location remain intact. Per-record before/after and batch audit details retain actor, reason, mapping, selections, alternatives and affected runs; recent history is shown in HR.
- Both profiles' Draft payslips overlapping selected dates receive a blocking warning requiring explicit regeneration. Approved/Paid snapshots, payments and historical allocations remain unchanged, with explicit HR acknowledgement. Reviewed OT, leave, payroll claims, salary settings and site costs are not reassigned; screen/documents explain their separate review. Payroll company for a new profile is explicitly selected, not copied from the wrong profile.
- Updated README, architecture, decisions and payroll documentation; also corrected the prior payroll-table documentation typo so Driver Site minimum reads 31 (calculation stayed 31 throughout). Preserved all earlier dirty-tree work.
- Validation with Node 20: full backend **383 passed, 0 failed, 4 skipped (387 total)**; final focused correction API **2 passed** after narrowing Draft impact to selected dates and validating new-profile employment start. Scenarios cover permissions, provenance/legacy acknowledgement, invalid IDs, stale preview, conflict archival, preserved corrected times/site stop, atomic creation/no orphan profile, replay, future import ownership, Draft approval/regeneration and identical Paid snapshots. Frontend **41 passed** and final production build passed (existing chunk-size advisory). Browser fixture verified preview stays open, conflict decision, acknowledgements, correct commit payload and success completion; reviewed screenshot after table layout refinement. The first browser attempt lacked bundled Chromium, so verification used installed Chrome. Removed temporary harness files and stopped the task Vite server. git diff --check passed.
- No deployment, PM2 operation, live database write or real employee/mapping/attendance transfer. Only disposable local test records were changed. Existing Approved/Paid payroll cannot be fixed by this attendance transfer and requires separate HR/Finance correction if needed.

## 2026-11-10 — clarify HR work-type names

Changed Special daily pay work-type dropdown and daily-record labels from Bass/Gola to Worker (Bass)/Helper (Gola), with matching rate/help text. Explicit option values preserve saved/API Bass/Gola kinds and all existing calculations, rates and records. Updated docs/PAYROLL.md for the UI labels. Validation: Node 20 frontend production build passed (existing chunk-size advisory); git diff --check passed. No backend/schema change, deployment or live database write.

## 2026-11-10 — shared petty cash floats and Mr. Gihan personal-expense register

- User authorized implementation after confirming several real floats fund both companies and Mr. Gihan does not repay personal spending. All existing/new petty floats are now shared across company selection, preserving each float's ID, category, ledger and full balance. No floats or balances are merged/reset. Opening/top-up entries record funding company; spending/returns record their company and optional matching project. Fuel/Salary advance category safeguards remain.
- Added guarded per-entry company attribution/FK and legacy backfill from the float's previous company. Updated Fleet, QS station fuel and supplier batch paths to accept shared eligible floats while saving the payment/fuel company. Project-company transfers and startup synchronization no longer change shared float provenance. Updated Daily Expenses/funding, Finance reporting, Cash comparison and management petty-cash projections to scope entries instead of accounts. Salary advances use the employee's payroll company; daily limits/recovery and approved payroll stay unchanged. Old integrations omitting company still use the old float default; updated UI always selects a company.
- Added Finance sidebar → MD Personal Expenses under Personal spending. New personal petty/direct office payments link atomically to the register; eligible existing payments can be linked without another cash movement. Unique source links prevent duplicate classification; petty movement client-reference/hash supports identical retry replay and rejects altered reuse. Direct payments retain company/reference uniqueness. All balance/metadata/audit writes are transactional.
- MD register records category, notes, optional paid-by name independently of the original recorded-by audit user; amounts/dates/payer/payee/references come from the source payment. Includes date/company/category/source filters, year shortcut, company/category totals, metadata editing, private receipts and PDF/Excel exports. No debt/repayment/outstanding amount is created. Personal entries create no project cost. Supplier/project/fuel/salary entries are rejected as link candidates, preventing silent business-cost reclassification. Existing records are not automatically marked personal.
- Added Finance-management authorization for register/link/export/receipts and guarded attachment owner enum/storage mappings. Generated PDF uses protected download tickets and one Infinity AI credit. Updated README, architecture, decisions and payroll documentation. Preserved the pre-existing pending Worker (Bass)/Helper (Gola) label changes and progress entry.
- Validation with Node 20: final full backend **385 passed, 0 failed, 4 skipped (389 total)**; focused supplier/shared-float/MD scenarios **3 passed**; frontend **41 passed**, final production build passed (existing chunk-size advisory), git diff --check passed. Coverage includes shared balances, cross-company funding/spending/fuel/salary/supplier payments, payer-scoped daily/cash totals, retry deduplication, insufficient-funds rollback, legacy/existing-payment linking without cash changes, unique links, category/paid-by persistence, no personal project-cost mirror, private receipt upload/read permissions, XLSX and real ticketed PDF bytes. Updated old tests that assumed exclusive float ownership; project/payment company mismatch validation remains.
- Browser fixture verified bottom Finance sidebar entry, personal petty payment and existing-direct link, shared float's paying-company/MD-purpose payload, and direct office MD classification. Screenshots visually checked after layout refinement. Synthetic 18-line PDF rendered to two landscape pages; both pages checked for readable repeated headers/totals, no clipping and exactly one Infinity AI credit. Initial candidate-query test exposed a MySQL collation mismatch; exact binary origin-ID comparison fixed it before passing focused/full runs. Initial browser locator needed partial matching for required-field labels; no product behavior was inferred from that harness retry. Removed temporary harness files and stopped the task Vite server.
- No deployment, PM2 operation, production environment change, live database write, real cash movement, real MD record/receipt upload, or desktop installer rebuild. All API mutations/uploads used disposable local test data. Existing project-linked payments require separate correction rather than automatic reclassification through this register.

## 2026-11-11 — consolidate former company-specific petty accounts

- User clarified the old Fuel balances were separately recorded because the system previously separated companies and requested they be combined. Added Finance → Petty cash → Merge accounts: choose one active destination and same-category sources, name the combined account, preview balances/counts and confirm with a reason.
- Added guarded merged-destination/date/balance fields, original entry-account provenance, merge batches and per-operation entry membership. One transaction locks accounts/entries, verifies the preview digest, freezes legacy payer attribution, moves existing movements under the destination and archives source accounts. It creates no funding/spending/adjustment/expense and changes no payment amount/date/ID. Entry links to Fleet, suppliers, MD personal spending and salary-advance recoveries remain intact. Retry references replay identical commits; altered requests, stale balances, mixed categories, duplicate IDs, closed accounts and cycles are rejected.
- Existing merged sources stay under Show merged accounts / history with balance at merge and read-only original movements. Open shared account follows the current destination. Repeated merges flatten redirects while preserving each historical account's membership and first entry origin. Historical views exclude later destination payments; active totals include entries once. Cursor-based Load older movements removes the prior first-300-row visibility limit without changing existing API array responses.
- Pending QS station-fuel lines resolve archived choices to the current active destination at validation/review; saved original references remain readable and new payment posts only once to the destination. Existing payroll policies/snapshots and salary amounts are unchanged. Updated README, ARCHITECTURE, DECISIONS and PAYROLL; preserved all earlier pending changes.
- Validation with Node 20: final complete backend **387 passed, 0 failed, 4 skipped (391 total)**; focused merge scenarios **2 passed** before the full run. Coverage includes balance totals, stale-preview rejection, replay/altered retry, authorization, same-category/distinct-ID checks, original fuel payment IDs, frozen legacy company totals, source archival/write rejection, historical cursor, later destination spending exclusion, repeated merges/redirects and unchanged MD links. Existing station-fuel API scenario now merges its source after QS submission and verifies Finance approval debits the correct destination once. Frontend **41 passed**, final production build passed (existing chunk-size advisory), git diff --check passed.
- Browser fixture verified source/target selection, preview staying open, stale-result recovery, confirmation, archived read-only history, destination navigation, and appending older movements with the correct cursor. Both preview/history screenshots were visually checked. On resume the task Vite server was stopped, so the initial browser navigation was refused; restarted it and the complete browser run passed. Removed temporary harness files and stopped only the task Vite server afterward.
- No deployment, PM2 action, production environment change, live database write or actual customer-account merge. Only disposable local test floats and records were merged. The real Fuel accounts require a deliberate merge selection after deployment; no accounts were guessed or automatically consolidated at startup.

## 2026-11-11 — retention remarks

Finance and QS share the same add/edit/clear remark action and display saved remarks in the Retention table. The action uses the existing notes field and permissions, audits updates, and works after release. The release form can explicitly update the remark and preserves it when left blank. The focused API scenario passed, covering permissions, length validation, persistence through release and clearing after release. Frontend production build and git diff --check passed. Work was local.

### 2026-11-11 — Fuel submissions and personal reminders

- Added a phone-friendly fuel submission form with camera and image-file options, private photo access, and a shared company-filtered queue in Fleet, Finance, QS, People and Projects. Access Control exposes an editable Fuel Recorder role and separate submit, view and review permissions.
- Approval by another authorized user posts one Fleet fuel record in a transaction with its odometer reading and any selected project cost or Fuel float payment. Rejections retain the reason. Project-linked submissions follow project company changes.
- Added a Reminders page for all signed-in users. One-time reminders can target self, other active accounts, or both. Recipients see them on Dashboard, and due reminders appear in the notification bell and the live in-app banner.
- Local verification on Node 20: backend suite passed 389 tests with 4 skipped, including private photo upload/read, review and posting, project company transfer, and reminder recipient visibility and delivery. Frontend suite passed 41 tests and the production build completed. Physical-phone camera behavior was not exercised. No production deployment or live database writes were performed.

### 2026-11-12 — Long project titles in the detail header

Moved the project action buttons, title and status badges, and delivery progress into the header's responsive layout. The header grows with the full title, wraps long words when needed, and stacks the delivery card below the title on small screens.

Reproduced the overlap in a local Chrome layout fixture and verified the corrected header with short, long, and unbroken titles at 320, 390, 767, 768, 900, 1440, and 1971 pixels. The frontend tests, production build, and diff checks passed. No deployment or live database write.
