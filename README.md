# GKUC SiteOps

Construction Operations Management System for GKUC Construction, built to the approved
Project Identification Document. A React client and a secured Node API are served as one
application over a persistent MySQL database.

The product goal from the PID is to remove the recurring human error in manual coordination:
forgotten tasks, lapsed vehicle licences, untracked stock, and budget overruns found too late.
Every deadline and threshold in the system is therefore converted into a proactive alert
rather than something a person has to remember to check.

## Structure

```text
gkuc-construction/
├── frontend/
│   ├── src/
│   │   ├── pages/          One file per module in the navigation
│   │   ├── api.js          Fetch wrapper, session token, shared formatting
│   │   ├── ui.jsx          Shared page, table, badge and form components
│   │   ├── main.jsx        App shell, navigation, sign-in, permissions
│   │   └── *.css           Styles (unchanged visual system)
│   ├── vite.config.js      Development API proxy
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── routes/         One router per module
│   │   ├── lib/http.js     Auth, role permissions, validation helpers
│   │   ├── schema.js       Tables and idempotent migrations
│   │   ├── seed.js         First-run demonstration data
│   │   ├── alerts.js       Deadline and threshold scanner
│   │   ├── db.js           Pool, transactions, password hashing, audit
│   │   └── index.js        Application composition
│   ├── test/               MySQL integration tests
│   └── package.json
├── package.json            Workspace commands
└── pnpm-workspace.yaml
```

## Run locally

MySQL must be running first. The app expects it on `127.0.0.1:8889` (MAMP's default);
change `DB_PORT` in `backend/.env` if yours is on 3306.

First time only:

```bash
npm run setup
```

```bash
mysql -h127.0.0.1 -P8889 -uroot -proot -e "CREATE DATABASE IF NOT EXISTS gkuc_siteops"
```

```bash
npm run seed
```

The seed is safe to re-run: migrations are idempotent, and it never overwrites role
permissions the Managing Director has changed.

Then, for development (backend on 4400, frontend on 3400):

```bash
npm run dev
```

Open `http://127.0.0.1:3400/`.

To serve the built frontend from the backend on a single port instead:

```bash
npm run build && npm start
```

Open `http://127.0.0.1:4400/`.

`npm` is used rather than `pnpm` throughout: the workspace file remains for reference,
but the scripts run through `npm --prefix` so no extra package manager is required.

Client review accounts use the temporary password `GKUC@2026`:

| Role | Email |
| --- | --- |
| Managing Director | `owner@gkuc.lk` |
| Administrator | `admin@gkuc.lk` |
| Project Manager | `manager@gkuc.lk` |
| Site Supervisor | `supervisor@gkuc.lk` |
| Storekeeper | `store@gkuc.lk` |
| Finance / Accounts | `finance@gkuc.lk` |
| HR | `hr@gkuc.lk` |
| QS / Estimator | `qs@gkuc.lk` |
| Transport Officer | `transport@gkuc.lk` |

Change all passwords before live use.

## Modules

| PID module | Where it lives | Notes |
| --- | --- | --- |
| 2.1 Dashboard | Dashboard | Live counts, real seven-day site activity, delayed projects, revenue against cost, open alerts |
| 2.2 Employee Management | People | Profiles, departments, attendance, leave, overtime, payroll, performance reviews, documents |
| 2.3 Task Management | Tasks | Deadlines, priorities, comments, file and photo attachments, completion approval |
| 2.4 Project Management | Projects → open any project | Timeline, milestones, documents, team, and a generated completion report |
| 2.5 BOQ & Estimation | Projects → BOQ, Variations | Priced lines, approval, variation orders, estimate against actual |
| 2.6 Material & Inventory | Materials → Stock, Movements | Transactional receipts, issues, returns, transfers, low-stock alerts |
| 2.7 Purchase Management | Materials → Requests, Orders, Suppliers | Request, approval, quotations, orders, goods received, invoices |
| 2.8 Fleet Management | Fleet → Vehicles, Compliance, Fuel | Insurance, licence, emission tracking, driver records, service schedule |
| 2.9 Equipment Management | Fleet → Equipment | Assignment, return, maintenance history, printable QR labels |
| 2.10 Finance Management | Finance | Expenses, income, budget monitoring, profitability, payables, categories |
| 2.11 Daily Site Reports | Daily reports | Workforce, work done, material and equipment usage, delays, issues, site photos |
| 2.12 Reports | Reports | Eleven generated reports with a date range and CSV export |
| 2.13 Notification Center | Administration → Notifications | The alert scanner, its history, and WhatsApp/SMS/email dispatch |
| 2.14 User Management | Administration → Users | Ten roles with role-based write permissions |

The project lifecycle in PID section 3 is covered end to end: a customer inquiry
(**Projects → Inquiries**) converts into a registered project, which carries its BOQ,
approvals, resourcing, purchasing, site operations and cost tracking through to the
completion report.

## How error prevention is enforced

- **Alerts, not reminders.** `backend/src/alerts.js` scans vehicle and employee document
  expiry, low stock, budget usage, overdue tasks, delayed milestones, unpaid supplier
  invoices, and pending approvals. It runs hourly and on every sign-in. Each condition
  raises exactly one notification per day, keyed by a deduplication key.
- **Figures cannot drift.** Stock movements, goods receipts and supplier payments run
  inside database transactions, so the balance, its history and the audit entry commit
  together or not at all.
- **Estimates and actuals share one system.** Approving a BOQ or a variation order sets
  the project's approved budget; receiving goods, issuing material to a site, and fuelling
  a vehicle post project costs automatically. Budget monitoring compares the two
  continuously instead of at project close.
- **Nothing is silently editable.** Every write records who did it, from where, with the
  before and after state, in an append-only audit log. Attendance corrections require a
  reason.
- **Permissions match the role table.** The API refuses writes outside a role's remit; the
  interface simply hides those actions.

## File storage

Uploads run through one driver interface, so where files live is an environment setting
rather than a code change.

- `STORAGE_DRIVER=local` (default) writes to `uploads/` at the repository root and serves
  it from `/uploads`. The folder is git-ignored.
- `STORAGE_DRIVER=r2` targets Cloudflare R2 over its S3-compatible API using the `R2_*`
  variables. Uploads use multipart streaming, so large files are not loaded into server
  memory. Private downloads remain behind the application's permission checks and use
  short-lived signed links.

For Contabo Singapore, create a **private** bucket and set these backend environment values:

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=https://sin1.contabostorage.com
S3_REGION=default
S3_BUCKET=YOUR_BUCKET_NAME
S3_ACCESS_KEY_ID=YOUR_CONTABO_ACCESS_KEY
S3_SECRET_ACCESS_KEY=YOUR_CONTABO_SECRET_KEY
S3_FORCE_PATH_STYLE=true
```

The S3 option preserves application permission checks and streams protected downloads
through SiteOps; public bucket access and browser CORS configuration are unnecessary.
Local scratch space is still required for uploads and OCR. R2 settings remain supported
when `STORAGE_DRIVER=r2`; S3 uses only the `S3_*` connection settings.

From `backend/`, run `npm run storage:diagnose:s3` to write, read, verify and delete a
small temporary object. To copy existing local uploads, first run
`npm run storage:migrate:s3` (dry run), then `npm run storage:migrate:s3:apply`.
The migration preserves keys and local originals; matching sizes are skipped, so verify
important file contents separately. Pause uploads during the final migration and switch
the live backend only after copying and verifying the existing files. There is no automatic
fallback to local files after switching. Restart the backend after changing its environment.

Storage keys are random UUIDs, matching how a public R2 bucket behaves: a URL cannot be
guessed or walked. Accepted types are images, PDF, Word, Excel and CSV, capped by
`MAX_UPLOAD_MB`; anything executable is refused. Multipart bodies are parsed by Node
itself, so the product carries no third-party upload dependency.

## Notification channels

`NOTIFY_CHANNELS` decides which of WhatsApp, SMS and email an alert is pushed to, and
`NOTIFY_MIN_SEVERITY` keeps low-value alerts in-app. Each channel is a thin adapter
(Meta WhatsApp Cloud API, Twilio, Resend) selected by whichever credentials are present.
With nothing configured, delivery is recorded as *Skipped* rather than dropped silently,
so the notification history stays honest about what actually left the building.

## Configuration

Copy `backend/.env.example` to `backend/.env` and set the MySQL connection values. The
application creates and migrates its tables inside the existing database at startup, and
seeds demonstration data only when the user table is empty. The database itself must exist
before first start.

```sql
CREATE DATABASE gkuc_siteops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALERT_INTERVAL_MINUTES` | `60` | How often the deadline scanner runs |
| `ALERT_WINDOW_DAYS` | `30` | How far ahead expiries are alerted |
| `ATTENDANCE_LATE_AFTER` | `08:00:00` | Check-in time after which a worker is marked late |
| `STORAGE_DRIVER` | `local` | `local`, `r2` or `s3` |
| `R2_S3_ENDPOINT` | *(empty)* | Complete Cloudflare R2 S3 API endpoint |
| `R2_BUCKET` | *(empty)* | R2 bucket name |
| `R2_ACCESS_KEY_ID` | *(empty)* | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | *(empty)* | R2 API token secret; keep only in the server environment |
| `R2_PUBLIC_BASE_URL` | *(empty)* | Optional public/Worker-protected domain; leave empty for confidential SiteOps files |
| `MAX_UPLOAD_MB` | `15` | Largest accepted upload |
| `NOTIFY_CHANNELS` | *(empty)* | Any of `WhatsApp,SMS,Email` |
| `NOTIFY_MIN_SEVERITY` | `Warning` | Minimum severity pushed off-platform |
| `SEED_PASSWORD` | `GKUC@2026` | Password given to the seeded review accounts |
| `SERVICE_SUSPENSION_MESSAGE` | standard overdue-payment wording | Optional replacement text shown while access is suspended |

For production, create a dedicated MySQL user restricted to `gkuc_siteops`; do not deploy
with the MySQL `root` account. Use scheduled `mysqldump --single-transaction` backups and
test restoration regularly.

### Production update

The frontend is compiled by Vite. Vite is intentionally a development dependency because
the running Express server only serves the finished `frontend/dist` files. A server with
`NODE_ENV=production` skips development dependencies during a plain `npm install`, so use
the production build command below rather than installing the frontend normally:

```bash
npm install --prefix backend --omit=dev
npm run build:production
pm2 restart gkuc-siteops --update-env
```

`build:production` explicitly installs the frontend build tools and then creates the
production bundle. This avoids `vite: command not found` without moving Vite into the
application's runtime dependencies.

### Temporarily suspend or restore service access

The payment lock is controlled from the server and does not need a separate SiteOps user.
It preserves every account, session, record and uploaded file while refusing business-data
requests. Run these commands from the project root on the server:

```bash
npm run access:suspend
npm run access:restore
```

The running application notices the database change automatically; a PM2 restart is not
required. Open users are moved to the payment-overdue screen within 30 seconds, or on their
next action. The **Check again** button restores the normal interface immediately after the
restore command has been run.

## Tests

```bash
npm test
```

Twenty-one backend tests start the real application against a temporary
`gkuc_siteops_test` database and cover authentication, role permissions, the
purchase-to-stock chain, BOQ approval and budget effects, equipment assignment and QR
resolution, payment limits, the alert scanner, attendance integrity, daily reports,
uploads (type, permission, serving and deletion), inquiry conversion, payroll
calculation, the vehicle service schedule, the completion report, and every generated
report.

The frontend suite pins the QR encoder to the ISO/IEC 18004 worked example and to the
structural rules a decoder depends on. Its rendered output was additionally confirmed to
decode with a real barcode reader.

## Not included

Accounting-package integration and public hosting are outside this build. WhatsApp, SMS
and email adapters ship ready to use but need GKUC's own provider accounts — set the
credentials in `.env` and list the channels in `NOTIFY_CHANNELS`. Object storage runs
locally until the Cloudflare R2 bucket exists, at which point only environment variables
change.

### Payroll migration on restart

Payroll periods are unique per company, date range and pay frequency. Startup must not
recreate the obsolete cross-company `uq_payroll_period_frequency` index: different
companies can have runs for the same period. The migration keeps payroll records intact
and installs `uq_payroll_company_period_frequency` after adding `company_id`. If startup
fails naming the obsolete index, deploy the updated `backend/src/schema.js` and restart;
do not delete payroll runs or payslips to work around the error.

### Diagnosing uploads after changing storage provider

When `backend/.env` explicitly contains `STORAGE_DRIVER`, that file is authoritative
for all `S3_*` and `R2_*` connection values. Retained PM2 storage variables are removed
before loading those values; missing keys do not fall back to old credentials. Without
an explicit file driver, process environment configuration remains supported. The file
is resolved relative to the backend code, independent of the shell working directory.
This precedence applies only to the storage connection, not database or other settings.

Startup prints `File storage configuration` with driver, source, endpoint, bucket,
region and addressing style, excluding access keys and secrets. For Contabo the driver
must be `s3` and the endpoint must be `https://sin1.contabostorage.com`.

`npm run storage:diagnose:s3` now uses the application's actual streamed upload path
and scratch directory. It checks small and 6 MiB multipart uploads, downloads both,
compares SHA-256 hashes, and deletes the test objects. **Only `RESULT: PASS` means the
complete check succeeded**; bucket access alone does not verify write permissions.
The diagnostic creates temporary project objects without database attachment records;
cleanup failures identify the exact object keys to remove manually. Allow at least 6 MiB
in `MAX_UPLOAD_MB` when running the full multipart diagnostic. S3 network operations
have connection/socket/request timeouts and at most two attempts rather than unbounded
waits. A prolonged failure may therefore take several minutes across multipart requests.

After deploying backend and frontend changes, rebuild the frontend, restart PM2 with
`--update-env`, and refresh the browser. Storage failures now show the safe storage
message instead of the generic server error. A `403 AccessDenied` after the complete
configuration is verified still requires correcting storage credentials or bucket
permissions; making the bucket public is not required.
