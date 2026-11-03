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
