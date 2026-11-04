# Production rollout — browser/API and Electron

Prepared 2026-11-03. These are operator instructions; **they have not been executed
against production**. Target public origin: **https://staff.gkucconstruction.com**.
The repository's PM2 definition assumes `/www/wwwroot/siteops/backend`, process name
`gkuc-siteops`, port 4400. Verify the actual host paths before using those commands.

## Release gate

Read [MANUAL_QA.md](MANUAL_QA.md) and [DESKTOP.md](DESKTOP.md) first. The latest
full Node 20 backend regression run passes 333 tests, with zero failures and two
optional skips. Earlier seven failures were stale expectations/test-fixture coupling;
no payroll calculation change was needed. The follow-up was not rerun on Node 22.
Windows runtime/signing, client hardware and production integration remain unverified.
Local test success is not production acceptance. Verify the intended production runtime
and the representative workflows below before rollout.

## 1. Prepare and validate a release outside production

Use a maintained Node LTS, with Node 22 as this pass's compatibility-check target.
Desktop tools need Node 22.12+. Node 20 remains the repository's historical regression
baseline, but is now EOL: do not introduce a new production runtime based on that old
baseline alone. Use a current patched LTS and repeat staging validation when changing
runtime. See the [official Node release table](https://nodejs.org/en/about/previous-releases).

On a workstation/staging machine with its **own local test MySQL**:

```sh
npm ci --prefix backend
npm ci --prefix frontend --include=dev
npm ci --prefix desktop --include=dev
npm test --prefix backend
npm test --prefix frontend
npm run desktop:prepare
npm run desktop:test
npm run desktop:test:e2e
SITEOPS_TEST_MYSQL=1 npm run test:backend --prefix desktop
git diff --check
```

Backend integration tests create/drop their fixed test database. Never run these tests,
the manual QA helper or demonstration seed commands on the production server/database.
Use a private/sanitized staging dataset, local file storage and disabled notification
credentials. Validate imports, saved documents, payroll and authorization there first.

## 2. Back up before changing the server

Record the current release/commit, PM2 process definition and Node executable. Take a
database backup using a dedicated operator credential stored securely, plus the current
code/build and server `.env`. Do not paste passwords into shell arguments, chat or logs.
Keep a backup of local uploads, or the existing private object-store backup/versioning
policy if S3/R2 is used. Test restoring the database in an isolated environment.

Use a short maintenance window for deployment/startup migrations. This application runs
guarded schema changes at startup. Keep the existing database, storage driver, bucket,
document keys and environment; an application update is not a storage-provider migration.
Do not replace `.env` with `.env.example`, copy the workstation's `.env`, run seed/reset
commands or create a second production database for desktop users.

## 3. Install the approved API/browser release

Copy/check out the **reviewed release**, preserving the server's private configuration
and uploads. From the real project root (example below):

```sh
cd /www/wwwroot/siteops
npm ci --prefix backend --omit=dev
npm ci --prefix frontend --include=dev
npm run build --prefix frontend
```

Express serves `frontend/dist`; do not run the Vite development server in production.
Frontend build tools are explicitly installed because `NODE_ENV=production` otherwise
omits them. The server does not need Electron, desktop dependencies or installer output.

Confirm `backend/.env` retains the real database and private storage settings. Confirm
`TZ=Asia/Colombo`, matching `DB_TIME_ZONE=+05:30`, `NODE_ENV=production`, port 4400 and
the proxy configuration. Run under a dedicated service user with access only to its
database/uploads/scratch folders. Keep MySQL and port 4400 off the public internet.

Generated PDFs require Chrome/Chromium on the server and a valid
`DOCUMENT_PDF_BROWSER_BIN` if autodetection fails. OCR additionally needs Tesseract and
Poppler; see README. Validate those executables under the service user in staging.

The existing ecosystem file deliberately uses **one fork worker**: SSE, alert scheduling
and rate-limit state are process-local. Do not increase `instances` for this release.
Make sure PM2 uses the validated Node executable; restarting an existing daemon does
not by itself prove it changed Node versions.

For an existing PM2 process, after backup and release approval:

```sh
pm2 restart ecosystem.config.cjs --only gkuc-siteops --env production --update-env
pm2 status gkuc-siteops
```

For a first installation, use `pm2 start ecosystem.config.cjs --only gkuc-siteops
--env production` instead. Set up PM2 persistence using the host's service account;
do not start an additional duplicate instance. Read the scoped application logs for
startup/migration failures without exporting environment values or tokens. PM2's
[ecosystem](https://pm2.keymetrics.io/docs/usage/application-declaration/) and
[environment update](https://pm2.keymetrics.io/docs/usage/process-management/) docs
describe these switches.

## 4. Preserve HTTPS and streaming through the proxy

Keep the existing valid TLS certificate for `staff.gkucconstruction.com`. Within its
existing HTTPS server block, the SSE endpoint needs streaming rather than buffering:

```nginx
location = /api/events {
    proxy_pass http://127.0.0.1:4400;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 90s;
}

location / {
    proxy_pass http://127.0.0.1:4400;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
}
```

These are fragments, not a replacement for the host's whole Nginx/aaPanel configuration.
Match `client_max_body_size` to the approved application's `MAX_UPLOAD_MB` (Nginx `0`
means unlimited). Preserve enough real disk for upload/OCR scratch space. Do not expose
private uploads with an unauthenticated Nginx alias or public bucket. The app owns file
authorization. Test Nginx configuration before reloading only that service. Refer to
the [official proxy module docs](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

## 5. Verify the deployed browser/API before distributing desktop

- Check `/api/health` locally and over the HTTPS public origin; confirm the intended
  release loaded and no migration errors appeared.
- Sign in with authorized test accounts. Check each role's menus and company selection.
- Open two sessions: save an authorized test record in one and verify live refresh in
  the other. Restart/reconnect behavior needs verification through the actual proxy.
- Check one authorized upload/download, an actual generated invoice/quotation/payslip
  PDF and a salary-details XLSX. Browser success alone does not verify storage migration.
- Verify anonymous invoice behavior, inline client creation and volume units using
  designated test data. Do not use real financial records as disposable test fixtures.
- HR must save the agreed **2026-01-01** policy separately for each company, then explicitly
  assign the actual employees' special pay methods and daily evidence. See PAYROLL.md.
  No source-code deployment assigns employees or silently writes live policies.
- Verify a Draft payroll using authorized inputs and saved breakdown. Do not regenerate
  Approved/Paid payroll or mark real payroll paid as a deployment smoke test.

## 6. Build and distribute desktop clients

Build on the workstation/build runner, after the approved frontend is finalized:

```sh
npm run desktop:dist:win
npm run desktop:dist:mac
npm run test:packaged --prefix desktop
```

Outputs are `desktop/release/GKUC-Construction-1.0.4-win-x64.exe` and
`desktop/release/GKUC-Construction-1.0.4-mac-arm64.zip` for the current version. Version each
subsequent release in desktop/package.json and keep its lockfile/release notes aligned.
The Mac packaged smoke test applies to macOS only. A Windows installer build produced
on a Mac still needs installation/runtime testing on an actual Windows machine.

Configure platform code signing (and macOS notarization) on the release runner. Current
local builds are unsigned pilot artifacts; do not present them as signed trusted releases
or ask staff to disable OS protection. Signing identities/certificates belong in the
secure build environment, never this repository. macOS packaging explicitly disables signing; Windows resource editing is enabled
for branding but no signing certificate is configured. Review the build configuration
and supply secure signing credentials as part of the signed-release task.

Distribute only the final installers through an approved private download location;
staff do not install Node/MySQL or receive database credentials. Install the correct
OS/architecture build, open it, confirm the title/Connection settings show
`https://staff.gkucconstruction.com`, and sign in with the existing account. The browser
and desktop must show the same company records. Test printing and import/export on
client hardware, then expand beyond the pilot. Recommend the browser for low-spec PCs.

Desktop updates are manual reinstall releases; there is no auto-updater. Rebuild the
client when bundled UI changes, and keep API contracts compatible during a mixed-version
rollout. Do not distribute a client requiring server routes before that server release.

## 7. Rollback

Keep the previous compatible server build and desktop installer available. If smoke
tests fail, stop rollout and restore the previous code/build under the maintenance
procedure, preserving `.env`, uploads and business data. Restart the same single PM2
process and repeat health/login checks. Additive schema must be checked for backward
compatibility; do not drop new tables/columns as an automatic rollback.

A database restore can discard new business entries. Treat it as a separate planned
recovery operation with an agreed cutoff/reconciliation, not a routine code rollback.
Use the browser version while a desktop issue is corrected; that does not require a
second database or rewriting business logic.

## 1.0.2 follow-up — remembered desktop login and PDF footer

Deploy the updated backend and browser build first, then distribute 1.0.2 desktop.
Remembered desktop sessions use the existing sessions table and 30-day expiry;
browser logins keep 12 hours. A fresh desktop sign-in creates the OS-encrypted local
session. Check process quit/reopen, manual sign-out/reopen and server expiry; verify
PDF credit at an invoice's end and on every payslip page. Old installers cannot gain
the new local session behavior from a server update alone. No database reset, policy
recalculation, storage migration or live test payroll payment is needed.
