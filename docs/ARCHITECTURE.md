# GKUC SiteOps architecture

## Runtime

The product is one persistent MySQL-backed application. The frontend is React 19/Vite and calls the Express API. In production Express serves the finished frontend bundle. The backend uses ESM, `mysql2`, Zod validation and the AWS S3 SDK for compatible object storage.

```mermaid
flowchart LR
  Browser[React / Vite UI] --> API[Express routes]
  API --> Auth[auth + permissions]
  API --> Lib[domain libraries]
  Lib --> DB[(MySQL)]
  API --> Storage[Local / R2 / S3 storage]
  API --> Docs[PDF / XLSX generation]
```

## Backend design

- `backend/src/index.js` composes routers, middleware, static serving and scheduled work.
- `backend/src/db.js` owns pooled connections, transactions, password functions and audit logging.
- `backend/src/schema.js` creates tables and performs idempotent additive migrations at startup. Do not add a non-idempotent DDL statement.
- Each `backend/src/routes/*.js` file owns one domain's API. Writes must validate payloads, scope records, enforce permissions and audit before/after data where applicable.
- `backend/src/lib/` contains pure or shared domain logic. Keep calculation logic here, not inside JSX or SQL strings.

## Frontend design

- `frontend/src/main.jsx` is the application shell, navigation and permission-aware routing.
- Pages live in `frontend/src/pages/`; most forms use shared primitives from `frontend/src/ui.jsx`.
- `frontend/src/api.js` is the fetch/session wrapper. Do not bypass it for ordinary API requests.
- Styling is shared in `frontend/src/workspace.css` and page-specific CSS. Keep spacing, cards and button classes consistent with the existing visual language.

## Persistence and audit principles

Business records use MySQL as the source of truth. Payroll, inventory, finance and workflow changes often require transactions because derived totals, allocations and audit records must commit together.

`payroll_policies` are effective-dated and company-scoped. A policy can be archived (`archive_key != 0`) without invalidating foreign keys held by payroll runs, overtime records or claims. The active calculation queries only select `archive_key=0`; history queries may intentionally include archived records.

Saved payslips retain a calculation snapshot. PDF payslips and XLSX exports read that snapshot rather than recalculating from mutable attendance, policy or employee data.

## Authorization

Routes must use the helpers in `backend/src/lib/http.js`:

- `auth` authenticates the session.
- `permit(...)` enforces the server-side permission.
- `validate(...)` validates Zod input.
- `wrap(...)` sends operational errors through the shared error path.

Company selection in the UI is never sufficient authorization. Query and mutation scope must be checked in the route.

## Operational commands

From the repository root:

```bash
npm run build
npm run dev
```

From `backend/`:

```bash
PATH=/Users/thinuladamsith/.nvm/versions/node/v20.12.2/bin:$PATH node --test test/<file>.test.js
npm run payroll:diagnose -- EMPLOYEE_CODE
npm run storage:diagnose:s3
```

Do not use a source change or a local test as evidence that production was deployed. Production changes need an explicit deployment request and a separate before/after verification.

## Fleet asset renewal creation

The Add fleet asset form accepts multiple renewal rows, each with its own type and expiry date. `POST /fleet` accepts an optional non-empty `renewals: [{docType, expiryDate}]` array of distinct supported document types, alongside the legacy `renewal`/`dueDate` fields. The server selects the earliest submitted expiry for the fleet summary and inserts every current document and dated renewal-history record within the asset-creation transaction. Existing single-renewal clients remain supported; no schema migration is needed. Creation audit data includes all submitted renewals. Subsequent changes still use the dated `/fleet/:id/documents` workflow; generic asset PATCH rejects renewal arrays. Existing compliance lists and alerts read the saved document records.

## Optional fuel float and quantity

`POST /fleet/:id/fuel` accepts omitted/null `fuelFloatId` and `litres`. The UI sends the selected operating `companyId`; the API validates it against the selected project and float, if present. Without a float, fuel and odometer records and any project expense still save transactionally, but no petty cash movement/payment is fabricated. With a float, existing balance, locking and company checks remain in force. Records without a float do not appear as petty cash payments in the daily payment report. Company fleet cost reports still include them.

An idempotent startup migration permits NULL in `fuel_records.litres`, preserving existing values and the positive-quantity constraint for supplied values. Unknown quantities display as a dash; vehicle fuel efficiency is unavailable when the measured interval contains an unknown quantity. Aggregate litres represent known quantities only.

## Reference-style client invoice print layout

Invoice preview and PDF share `invoiceDocument` in `backend/src/lib/documents.js`. They retain the saved system letterhead, explicitly show its company-details element when a saved address exists, and use the selected company's existing address from `documentContext`. The invoice body uses boxed date/reference, supplier/purchaser, delivery/place-of-supply and additional-information sections. Missing purchaser TIN is rendered as a dotted write-in space without inventing a tax identifier or changing the database. Saved TINs are printed when present. The bottom includes amount in words and payment mode; net payable is shown separately when it differs from the VAT-inclusive total (deductions, cumulative credits or suspended VAT).

New invoice forms and creation/preview requests default to Reference, Description and Amount columns (Unit, Quantity and Rate off). Existing per-invoice column controls persist choices; legacy records without saved options retain their previous all-column fallback. Column visibility does not change stored quantities, rates or accounting. Hidden Quantity and Rate allow the existing manual lump-sum input workflow. No schema or business-record update is required for this presentation change.

## Client creation from invoices

The client selector in `frontend/src/Receivables.jsx` opens the shared exported `ClientForm` from Client Directory in a modal above the still-mounted invoice workflow. Saving persists through `POST /clients`, adds the returned record to the selector and selects it immediately. Cancelling preserves the invoice and its prior client. Other invoice fields and manual lines remain; selecting the new client resets the old project, paid-invoice credits and project-linked source lines so another client's work is not billed accidentally. Initial client-list loading merges newly created clients to avoid losing a saved selection.

`GET /clients` and `POST /clients` also accept `finance.invoice`, enabling invoice writers to list and create real client records with the same validation, duplicate handling and audit as Client Directory. Editing, archiving and deletion retain `clients.manage`; detailed client-history access is unchanged. No schema change is required.

## Invoices without a named purchaser

The invoice client selector is optional. `POST /receivables/invoices` accepts omitted or null `clientId` for company-level manual invoices and persists `client_id=NULL`, an empty historical `client` name, and null purchaser snapshot fields. No placeholder client is created and no schema change is needed. The operating company remains required; an explicitly supplied invalid client still fails validation. Existing project/quotation billing derives and validates its client as before.

Invoice print/preview renders a dotted purchaser-name space when no name is saved, alongside the existing dotted TIN/address/phone placeholders. Such invoices can be issued and receive payments normally. Previous-invoice credits require an identified saved client in both calculation preview and creation, avoiding accidental pooling of unrelated unnamed purchasers. The ageing table labels empty names as “No client specified”; invoice references remain the record identity.

## Volume units in quotations and invoices

`frontend/src/MeasurementUnit.jsx` supplies common unit suggestions, including Litres and Barrels, while allowing existing/custom unit text. Manual client quotation creation and editing use it, as do invoice lines. Selecting Litres or Barrels on an invoice enables its Unit, Quantity and Rate print columns; the Use quantity × rate action enables them for other units. Existing lump-sum defaults remain available.

Both APIs already persist a string unit and decimal quantity/rate on each line. Amounts continue to use the existing quantity-times-rate calculations, with quotation markup/taxes and invoice taxes/deductions applied normally. A barrel is an independent billing unit: no assumed litre capacity or automatic conversion is introduced. Saved line units and amounts feed previews, printed documents and PDFs; no schema or production data migration is required.

## Remembered scanner names in attendance imports

`employee_biometric_ids.scanner_name` is an optional internal name attached to the employee's existing scanner-number mapping. A guarded additive startup migration adds it without changing existing mappings. The existing manual Match action sends the imported scanner name to `POST /biometric/mappings`; that route saves it in the same audited transaction as the number/employee link. Creating a profile from the scanner also saves its source name. No new fields, screens, confirmation steps or employee display-name changes are introduced.

`backend/src/lib/biometric-identities.js` resolves both preview and commit. Approved scanner numbers still work for older mappings with no saved name. For an unknown number, a previously approved scanner name can identify an employee after case/whitespace normalization; ordinary profile names are not automatically treated as aliases. Duplicate saved names belonging to different employees, conflicting number/name ownership and a name occurring under multiple numbers in the same file require manual decisions rather than guessed name matches. Known approved numbers distinguish employees with the same scanner name. Deactivated scanner codes remain excluded, and deactivated/Left profiles cannot be matched by name. Hidden/Left owners also count toward name ambiguity.

Aliases stay in the employee-linked identity register and audit trail, outside profile display/API data. A deliberate reassignment updates the scanner name with the identity decision (or clears the old name if no replacement is supplied). No import preview writes aliases; normal HR matching remains the approval event. Existing attendance corrections, saved payroll snapshots and calculation policies are unchanged.

## HR special daily pay

`/api/payroll/special-pay` is an authenticated `hr.payroll` module. GET requires a company ID and lists only employees currently in that payroll company. POST `/rules` upserts an employee/effective-date method and fixed agreed rate snapshot; POST `/days` upserts a dated Bass/Gola/Machine/Standby record with source reason. POST `/days/:id/archive` reversibly archives a daily record. Employee visibility/status, work-kind compatibility, real dates and meter/hour validation are enforced server-side. All writes are audited; no supervisor approval is inserted into this workflow.

Two additive, guarded tables hold `employee_special_pay_rules` and `employee_special_pay_days`; they link to existing employees/users and preserve earlier rate/input history in audit logs. No employee is automatically assigned a special method. `frontend/src/pages/SpecialDailyPay.jsx` appears within Payroll Inputs and keeps the existing attendance/import and regular claims workflows intact.

`backend/src/lib/special-pay.js` selects the employee's effective method per work date and produces saved per-day calculation evidence. `attendance-payroll.js` combines it with company-dated policies, month-to-date work counts, ordinary OT/late and the operator exclusions. Payroll generation validates required/orphan inputs, applies the special EPF exception without changing profile data (ETF stays governed by the existing profile/policy), saves operator transport as dated payslip components and allocates special earned basic to project costs. Paid leave snapshots its selected rate. Original/approved payslips remain immutable; exports use saved details via `payslip-detail.js`, including variable/premium daily earnings and machine readings. See `docs/PAYROLL.md` for the exact business rules.

Operator OT eligibility is resolved from the saved, active daily work record in calculation, HR suggestion review and manual OT entry. Standby maps to labour Site OT at the company policy's effective rate with a 30-minute minimum; Machine and missing daily choices cannot enable OT. The pure employee context carries the selected day's input alongside its effective rule. Operator late exclusion remains independent of this day-specific OT eligibility. No schema change is required for the Standby clarification.


## 2026-11-03 — Electron online desktop client

`desktop/` packages the existing React build with Electron 45.2.1. A secure custom
protocol serves local assets and streams same-origin API/upload/share requests to the
configured HTTPS server (default https://staff.gkucconstruction.com). Existing bearer
sessions, server authorization, persistence and SSE remain authoritative; there is no
local database or backend. Sandbox/context isolation remain enabled. The small preload
only exposes connection settings, with writes restricted to the settings page.
Successful live connections resync bootstrap; transient bootstrap failures preserve
authentication. Windows x64 NSIS and macOS arm64 ZIP packaging use electron-builder;
releases are currently unsigned, manually updated and online-only. See
[DESKTOP.md](DESKTOP.md) for build commands, test evidence and rollout limits.

## 2026-11-03 — manual desktop QA corrections

Document previews use a short-lived ticket on the configured network server origin in
an isolated PDF-enabled Electron window. This avoids blank/custom-protocol PDF rendering;
no bearer token is embedded in a URL. QR and Drive public URLs resolve through
`publicAppOrigin` / `usePublicAppOrigin`, so a desktop asset origin is never handed to
another device. The configured HTTPS origin remains authoritative in packaged builds.

`askText` in shared UI replaces native prompt calls with a queued asynchronous in-app
dialog. Drive folder naming, saved finance views, purchasing risk reasons, gallery
withdrawal and subcontractor decisions share this behavior in browser and desktop.
Existing server validation still applies; Cancel does not submit a subcontractor decision.
Optional fuel project, expense category and equipment-service status fields now permit
their existing empty/default options. No backend route, calculation or schema changed.
See MANUAL_QA.md for coverage and DEPLOYMENT.md for rollout/rollback instructions.

### Desktop product identity (2026-11-03)

Electron is branded GKUC Construction with a white-background rings-only native icon.
The application ID and legacy packaged user-data directory remain stable across the
rename. Packaging and regeneration details are in DESKTOP.md. Browser/API branding,
server selection and shared database behavior are unchanged.

### Remembered desktop sessions and document credit (2026-11-04)

`POST /api/auth/login` accepts optional boolean rememberDevice (default false). Existing
hashed sessions/expiry/revocation remain authoritative: remembered sessions expire in
30 days; normal sessions in 12 hours. No new database columns or silent policy writes.
Electron stores only the opaque token+server origin, encrypted through safeStorage,
with atomic queued writes and file mode 0600. Its three session IPC handlers require
the main local top frame; remote PDF/pop-up frames cannot read/write them. Connection
changes clear the encrypted token. Frontend restores it before bootstrap; invalid
sessions/logouts remove both the in-window copy and encrypted copy. Browser behavior
is unchanged. Plaintext OS storage backends are refused.

`developer-credit.js` is the shared mandatory print attribution decorator, used by
common documents, employee letters, payslips and the send/render-PDF fallback. It is
idempotent and independent of configurable company footers. Ordinary documents show
one end credit; payslips use a bottom-centre @page margin credit on every printed page
with existing confidentiality/page-number margins retained. Saved financial payroll
calculations and approved/paid records are not changed. Existing uploaded PDF files
are not rewritten; the rule applies to system-generated documents.

### Task-list status updates (2026-11-04)

Tasks rows expose permitted next statuses directly in their Status column. A short
confirmation form calls the existing PATCH /api/tasks/:id, then reloads shared data.
Blocked/Rejected require a reason; Completed requires management for Approved/Rejected;
Approved status changes require management and a reason (2026-11-04 clarification). Read-only users retain badges. Office and project task groups
share the same control, persisted record, audit history and live update flow as the
detail dialog. No route/schema or permission changes.

### Navigation scroll containment (2026-11-04)

Global root width containment uses overflow-x:clip so sticky desktop navigation and
mobile/tablet header track the viewport. Module layouts no longer disable global
navbar stickiness. A shared workspace-nav-offset clears the global bar for module
and QS section navigation while preserving bounded section-menu scrolling.

### Approved task corrections (2026-11-04)

Management with site.tasks and projects.manage may change Approved tasks to any
non-Approved status through the list or reopen from detail. A reason is mandatory.
PATCH clears approved_by, adds a reason comment and preserves prior approval/change
audit history. Reapproval still requires Completed. Updates compare the previously
read status and reject stale status changes with 409. Other users cannot reopen
approved tasks. This supersedes the earlier Approved-task lock only; payroll approval
locks and financial records are unaffected.

### Per-document quotation/invoice print options (2026-11-04)

Guarded additive JSON print_options columns on quotations_client and client_invoices
store per-record presentation. Shared GET/PUT /api/qs/quotations/:id/print-options
(qs.view/qs.quotation) and /api/receivables/invoices/:id/print-options
(finance.view/finance.invoice) expose authenticated options; writes require the
respective create/edit permission and are transactionally audited as PRINT_OPTIONS.
No prices, totals, payment history or business status is changed.

Quotations may share printedReference across separate work alternatives; original
system references/IDs remain available for record tracing and finance links. The
QS list shows the printed reference plus the record reference when they differ.
Existing quotation revisions already share their system reference; new revisions
also copy print options. Invoice printed-reference overrides are rejected.

Shared rendering removes selected cells/sections, corrects column spans and hides
all total summaries/category totals/amount-in-words when totals are off. Choices
include letterhead fields, unit/quantity/rate/line amounts, parties/work details,
notes/methods/terms/bank/signatures/company footer. Mandatory developer credit is
independent. Existing NULL settings retain legacy output/identity/column choices.
Invoice options and the older columns endpoint are synchronized; previous-invoice
credit snapshots are preserved. Progress-claim invoice PDFs read the same options.

### Fleet vehicle details editing (2026-11-05)

Fleet vehicle cards expose View / edit details. Transport managers can use Edit vehicle
details to update name, registration/asset ID, status, make, model, year, engine code
and manual/service notes through the existing audited `PATCH /fleet/:id` route.
Vehicle names and registrations are trimmed and validated; duplicate registrations
return 409 without saving other edits. Driver/site assignments, odometer readings
and renewal dates retain their dated, history-preserving workflows. No schema change.

### Petty cash funding affordance (2026-11-05)

Account create/edit no longer requires the warning threshold in the browser; blank
maps to the existing lowAt=0 API default. Account ledgers expose Add money / Top up,
preselecting the existing Top up movement kind. The same persisted entries endpoint
and ledger-derived balance are used for all account categories; no schema, permission
or accounting rule change.

### Reviewed bond workbook import (2026-11-05)

Finance Bonds uses `GET /receivables/bonds/import/template`, multipart `POST
/receivables/bonds/import/preview` and `POST /receivables/bonds/import/:id/submit`.
All require finance.invoice. The additive bond_import_batches table stores uploader,
company, source checksum, review JSON and completion status. Preview changes no bonds;
submit validates reviewed rows and saves all register changes/audit entries atomically.
Uploader ownership, company/project checks, snapshot conflicts, duplicate target/number
checks and completed-batch/checksum checks prevent stale and repeated imports. Existing
reference and extension history are preserved. See [bond import](BOND_IMPORT.md).

### Linked historical workbook imports (2026-11-05)

Import centre detects controlled Clients/Contacts, Projects/Project Team and BOQ
Headers/Items .xlsx workbooks before the generic/free-layout import path. Source IDs
resolve through historical_import_links across files; child rows have composite source
keys. Review mode linked-workbook supports corrections, explicit existing client/project
links and source employee mapping through PATCH /import-centre/batches/:id/linked-review.
Confirmation rechecks under transactional batch/dependency locks, persists parent/child
records, source_json and audits atomically, and skips already imported source keys.
BOQs stay Draft and never implicitly change approved budgets. Contact records persist
in client_contact_people and are returned by the client detail API/profile. Guarded
column widening preserves long project/BOQ names and descriptions. See
[Historical imports](HISTORICAL_IMPORTS.md) for validation, ordering and source caveats.

### Project deadlines and extension request letters (2026-11-05)

Project creation/editing accepts a nullable end date. Optional dates can be added later;
later changes to an existing end date use the audited extension workflow. Guarded
project_extensions and projects.extension_count persist repeat extensions and immutable
letter HTML. Project view/manage routes expose history and saved letter/PDF, with explicit
PDF-ticket path authorization. POST extension locks/checks the current date and atomically
saves dates, letter and audits. Company changes are blocked once extensions exist.
Project cards/workspace derive Completed > Extended > Current and offer search/status/
manager/date filters. The existing scheduler/bootstrap run a calendar-month deadline
scan for all active users; delivery keys dedupe per project/end-date/user/day and stop
for Completed/inactive records. Recurring reminders create no escalation cases. See
[Project deadlines](PROJECT_DEADLINES.md) for operational and client-request semantics.

### Editable PO documents and commercial revisions (2026-11-05)

Existing purchasing orders now support manual/generated editable numbers, per-document
presentation and multi-line calculated/manual amounts. PUT /purchasing/orders/:id saves
reasoned optimistic revisions transactionally; /check and /revisions support review/history.
Existing receive/invoice/payment endpoints remain the financial owners. Receipt unit rates
and cumulative received value prevent retroactive valuation when current PO prices change;
supplier invoices retain approved-PO snapshots for their original obligations. Supplier
statements and payment matching read these values. Commercial revisions reset approvals,
including preventing self-approval by the revision author. Guarded schema additions and
append-only revision records preserve auditability; received quantity/identity and linked
supplier/project accounts remain protected. PO PDF tickets and Materials deep links are
explicitly supported. See [Purchase orders](PURCHASE_ORDERS.md).

### Existing vehicle record actions (2026-11-05)

Fleet vehicle cards expose direct Edit details and Add renewal actions. The detail
modal places editing, driver, odometer, fuel, service/repair, schedule and renewal
controls before its summaries and history. These use the existing authorized,
persistent Fleet endpoints for both existing and newly created vehicles. Identity
edits remain separate from dated operational and renewal history.

### Temporary feature access pause (2026-11-06)

A pure shared pause list in backend/src/lib/temporary-features.mjs drives the built
frontend and an API middleware before business routes/document tickets. All roles receive
423 FEATURE_TEMPORARILY_DISABLED for the five paused workflows; detailed bootstrap/
project/client payloads and historical BOQ import access also respect the pause. Finance,
QS and project navigation omit paused sections and deep links render a notice. Existing
business records and ordinary role grants remain unchanged. See TEMPORARY_FEATURE_PAUSE.md
for precise scope, restoration, desktop bundle and deployment requirements.

### Paused-page presentation revision (2026-11-06)

Affected navigation remains visible and permits page entry. Finance/QS/Projects shells
render TemporaryFeatureNotice instead of operational content/forms. Direct URLs resolve
to the same page presentation. The manually configured machine/Windows error and driver
solution are shared with API refusals; no OS/driver diagnosis or installation is performed.
Server-side 423 restrictions, suppressed details and import guards remain in force.
