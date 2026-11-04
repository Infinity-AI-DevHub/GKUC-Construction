# Desktop client

Latest follow-up: [manual UI findings and corrected desktop issues](MANUAL_QA.md),
including network-origin PDF previews, public QR/share links and in-app text prompts.
Use [DEPLOYMENT.md](DEPLOYMENT.md) for the server/client rollout procedure.

The Electron client in `desktop/` bundles the existing React production UI. Its default
server is **https://staff.gkucconstruction.com**, as supplied by the user. Browser and
desktop use the same API, permissions, business calculations and database. No backend,
database credentials or separate business logic are packaged. Internet is required;
there is no offline write queue. Installing this client does not update the server.

## Connection and security

Assets load locally through secure `siteops://app`. `/api`, `/uploads` and `/s` requests
stream to the selected HTTPS server, preserving bearer headers, multipart bodies and
SSE responses. Cross-server redirects are refused and TLS verification remains on.
The renderer uses sandboxing, context isolation and no Node integration. Its preload
exposes connection read/save and narrowly scoped saved-session operations. Connection
saving is accepted from the dedicated settings page; session operations are restricted
to the main local application frame.
Settings persist in the OS user-data folder and changing them restarts the app.
Desktop sign-in is encrypted with Electron safeStorage in `session.enc` under the OS
user-data folder and restored before React/bootstrap starts. Passwords are never saved.
The encrypted token is bound to the selected server. Logout, expired/revoked sessions
and server-address changes remove the saved token. OS encryption must be available;
there is no plaintext/basic_text fallback. Browser sign-in remains sessionStorage-only.

**GKUC Construction → Connection settings** changes the server; **Open browser version** opens
the browser alternative for low-spec computers. The hostname appears in the window
title. UI updates require a new desktop release; there is no auto-updater yet. Verify
server API compatibility before distributing an update.

## Live updates and performance

The existing authenticated SSE stream is forwarded without buffering. Its connection
indicator, heartbeat/watchdog, reconnect backoff and 250 ms refresh coalescing remain.
Successful connections now refresh bootstrap to recover missed changes. Temporary
bootstrap failures preserve the token; a 401 signs out. These shared frontend changes
also apply to the browser when that frontend is deployed.

Pages keep existing lazy loading and their assets are local. Changes still reload the
permission-filtered bootstrap and notify independently fetched panels. There is no
guarantee of zero lag: network, server load, dataset and hardware still matter. Backend
events are process-local; multiple workers need shared event distribution to deliver
cross-worker live changes. Low-spec hardware benchmarking remains outstanding.

## Build and run

Electron tooling requires Node **22.12+**; prefer Node 20 for backend checks.

```sh
npm run desktop:setup
npm run desktop:prepare
npm run desktop:start
npm run desktop:test
npm run desktop:test:e2e
npm run desktop:dist:win
npm run desktop:dist:mac
```

Outputs in `desktop/release/` are ignored by Git: Windows x64 NSIS installer and
Apple Silicon macOS ZIP. `desktop:pack` creates an unpacked app. Releases are currently
**unsigned**, with no notarization or auto-update service. Obtain signing credentials
before broad distribution. Building Windows on macOS does not verify Windows runtime.
Intel Mac and Windows ARM are not current targets.

Only unpackaged development clients accept HTTP loopback with
`SITEOPS_ALLOW_LOCAL_HTTP=1` and `SITEOPS_SERVER_URL=http://127.0.0.1:PORT`.
Packaged clients require HTTPS. `SITEOPS_DESKTOP_USER_DATA` isolates test profiles.

## Verification — 2026-11-03

- Frontend build succeeded (existing large Three.js chunk warning); 34 frontend tests
  and 3 desktop core tests passed.
- Real Electron transport test passed on macOS arm64: bundled login UI, renderer Node
  isolation, bearer headers, multipart upload, incremental SSE, popup document access,
  PDF response bytes, saved attachment download and native `printToPDF`. Its server
  is explicitly a local fixture. The packaged macOS app also opened its bundled login
  successfully with an unreachable test server (`npm run test:packaged --prefix desktop`).
- Separate actual-backend desktop test passed: real UI login, authenticated bootstrap,
  live connection and a second API client's client creation triggering a refresh.
  A simulated bootstrap 503 preserved the signed-in session. Stopping/restarting the
  actual local backend restored SSE and triggered a successful bootstrap resync.
  It creates and removes only a new disposable loopback MySQL database on port 43973.
  Opt in with `SITEOPS_TEST_MYSQL=1 npm run test:backend --prefix desktop`.
  Set `SITEOPS_BACKEND_NODE` to a Node 20 executable if the runner uses another version.
  Do not run fixed-port integration suites concurrently.
- Latest full Node 20 backend suite: **333 passed, 0 failed, 2 skipped** (335 including
  nested tests). The earlier seven counted failures were resolved by aligning stale
  expectations with exact minutes, per-date rates, Driver Site/Travel rules, rendered
  invoice text and an isolated missing-threshold transport fixture. Added coverage
  preserves manually approved variable amounts. No backend runtime/calculation code
  changed, so this follow-up does not require new desktop binaries. Node 22 was not
  rerun in this reconciliation pass.
- No production writes, migration or deployment. Production account workflows,
  actual printers, Windows runtime, low-spec hardware, long outages and proxy-specific
  network failures remain unverified. Print-to-PDF is not a physical-printer test.

Before client rollout, verify tests on the intended production runtime,
test a signed Windows installer on client hardware, and check representative payroll,
import, invoice and printing flows against the deployed API using authorized accounts.
Keep the browser version available.

## Manual UI follow-up — 2026-11-03

The later manual pass corrected PDF windows (native viewer on configured network-origin
ticket URLs), online QR/share links, optional default selections and unsupported text
prompts. Actual invoice, quotation and payslip PDFs were opened through the UI. Shared
text/reason prompts now use async in-app dialogs, with cancellation and keyboard focus.
Final frontend suite is 38 passed; desktop core/transport/backend/packaged-Mac checks
passed. Both unsigned installers were rebuilt and have SHA256SUMS. See MANUAL_QA.md for
exact submitted flows and exclusions. The backend reconciliation result above supersedes
the earlier seven-failure count.

## Desktop branding — 2026-11-03

The desktop product name, window title, connection screen and installer/shortcut name
are **GKUC Construction**. The icon uses only the existing GKUC blue rings, centred
on an opaque white square; the red/black wordmark is excluded. Native PNG/ICO/ICNS
assets live in `desktop/resources/`. Regenerate with `npm run generate:icons --prefix
desktop` on macOS with Chrome installed (or set `ICON_BROWSER_BIN`). This renders the
unchanged brand mark on a white SVG canvas, then packages Windows/macOS icon sizes.
App ID remains `com.gkuc.siteops`; existing packaged connection profiles continue using
the `GKUC SiteOps` user-data directory, preventing a rename from resetting settings.
The app is still an unsigned pilot build. Windows executable resource editing is
enabled so the application file itself receives the icon and product metadata; this
is separate from certificate-based signing.

### Icon rasterization fix — 2026-11-04 (1.0.1)

The 1.0.0 multi-size screenshot generator captured stale compositor tiles at some
viewport sizes, producing the clipped/repeated rings shown in the user's screenshot.
The generator now renders the SVG directly to a fresh canvas per size, with opaque
white-border/nonblank guards. ICNS uses PNG-backed standard/Retina representations
instead of the malformed legacy small representations emitted by the local iconutil
encoder. Native PNG/ICO/ICNS representations were extracted and checked individually.
Both platform artifacts are version 1.0.1 so the corrected release is distinguishable
from the earlier files. Replace the old installed application with the new version;
no production API or database update is required for this icon-only correction.

## Remembered sign-in and print credit — 2026-11-04 (1.0.2)

Desktop login sends `rememberDevice:true`: the server issues a revocable 30-day opaque
session. Ordinary/browser logins retain the existing 12-hour expiry. Closing/reopening
the application restores a still-valid token automatically; expiry, administrator
revocation, account deactivation or signing out still requires authentication again.
Transient network/bootstrap failures retain the saved login. All business permission
and company checks continue on the server. Install the updated backend before this
client to receive the longer duration; an older server ignores the extra flag.
A one-time fresh sign-in is needed to create the first encrypted saved session.

Generated PDFs show Developed by Infinity AI (Pvt) Ltd, Sri Lanka at document end.
Payslips put it in the print page margin on every page. This rendering is supplied by
the server, so updating the desktop alone does not update PDF output.

Verification for 1.0.2: 39 frontend tests; 4 desktop core/encrypted-store tests; actual
backend desktop test covering OS encryption, full process restart, invalidated expiry,
logout and second restart; real multi-page PDF checks (five-page payslip, one credit
per page, invoice credit once at end). The full backend suite passes 333, fails zero,
skips two optional external-fixture tests. API date fixtures now use the same local
business date as the API/seed, preventing UTC/local-midnight fixture mismatches.

## Task-list status controls — 2026-11-04 (1.0.3)

Status dropdowns on the Tasks list open a short save/approval dialog. Blocking or
returning work requires a reason; approval permissions and Approved locks remain.
The same existing task API persists both list and detail actions. Rebuild/reinstall
the desktop client to receive this bundled UI update; browser users need the new
frontend build. No database migration is required.

## Pinned global navigation — 2026-11-04 (1.0.4)

The desktop navbar and tablet/phone header remain visible during page scrolling.
Root horizontal containment uses overflow-x:clip, preserving the viewport as the
sticky scroll container. Finance/People/QS layouts no longer override the desktop
navbar to relative positioning. Their section menus retain independent scrolling
below the pinned navbar, with desktop/tablet clearance. Mobile drawer behavior is
retained. Browser receives the same CSS update; desktop requires the rebuilt client.
