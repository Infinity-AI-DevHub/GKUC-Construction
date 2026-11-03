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
only exposes connection read/save; saving is accepted from the dedicated settings page.
Settings persist in the OS user-data folder and changing them restarts the app.
Sessions retain the web app's sessionStorage behavior; restart requires sign-in.

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
- Latest full Node 20 backend suite: **330 passed, 0 failed, 2 skipped** (332 including
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
