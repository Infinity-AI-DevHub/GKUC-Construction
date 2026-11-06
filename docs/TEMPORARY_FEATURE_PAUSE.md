# Temporary feature pause — 2026-11-06

The user requested a temporary, role-independent pause on Petty cash, Bonds,
Expenses, QS BOQs and client Invoices. This includes Managing Director/Owner,
administrators, both companies, direct record URLs, API reads/writes, imports and
generated PDF entry points. No role is an exception. Business records are retained.

The single shared list is `backend/src/lib/temporary-features.mjs` (`PAUSED_FEATURES`).
The frontend imports this pure module at build time. `temporary-feature-middleware.js`
runs before the business routers and document-ticket issuer and returns non-cacheable
HTTP 423 with `FEATURE_TEMPORARILY_DISABLED`. Existing download tickets do not bypass
the guard. This is independent of the payment-overdue service suspension.

Finance, QS and Projects navigation keep the affected pages visible and clickable.
The page shell/navigation opens, but its content and action forms are replaced with:

- Error in local machine
- Error in windows operating system
- Solution: Please ask the administrator to install the separate drivers required on
  this computer to continue working.

These are user-requested, manually configured messages, not results of OS detection,
driver checks or a diagnosed machine failure. They appear on every device, including
non-Windows devices. The actual restriction is the server-side feature pause; installing
drivers does not remove it. No driver installation or OS change is performed by the app.
API errors include the same message/detail/solution with the existing 423 pause code.
Bootstrap/project/client responses continue omitting detailed BOQ/invoice/expense rows;
historical BOQ imports remain refused. No operating forms mount inside affected pages.

The pause does not suspend all Finance, all QS, accounting reports, payroll, quotations,
cheques, supplier invoices, progress claims, Fleet, or project operations. Aggregate
reporting remains available. Related operational workflows can continue their normal
accounting postings; this is a feature-access pause, not a database financial freeze.
Cost-control endpoints remain available except the legacy direct-expense entry routes.
Progress-claim invoice PDF rendering is blocked; other progress-claim documents remain
available. Existing separately stored/downloaded files are not recalled.

## Restore access

Remove the required feature keys from `PAUSED_FEATURES` (or make it an empty array to
restore all five). Rebuild the frontend and deploy the matching backend/frontend through
the normal deployment process. The server process must reload the changed module.
No data migration, restoration or role-permission edits are needed. Do not re-enable
only the frontend: the backend remains authoritative. Desktop installers containing a
bundled frontend require a new bundle to reflect these page messages; an old client is
still blocked by the updated server's APIs.

This change is local until deployed. No production database writes or PM2 actions
are required or performed by the source change. Full legacy feature suites expect these
features enabled and are not a verification target while the deliberate pause is active;
use the dedicated pause tests and restore the list for ordinary feature regression runs.
