# Manual UI verification — 2026-11-03

## Verdict and scope

Broad local UI verification completed using the actual Electron app, actual Express
backend and a newly created disposable MySQL database on loopback port 43974. A browser
session used the same local API/database. No production accounts, production records,
remote storage migration or deployment were involved. Test names/figures were synthetic.

**This is not certification that every button, every record and every input combination
works.** Navigation/render checks, dialog inspection, successful mutations and automated
tests are distinguished below. External services, OS/hardware-dependent behavior and
unexercised branches remain explicit exclusions. The subsequent Node 20 backend
reconciliation run passed 330 tests, with zero failures and two optional skips;
this does not turn untested UI/hardware flows into verified flows.

## Navigation coverage

All 16 main modules opened: Dashboard, Coordination, Projects, Tasks, Quantity Surveying,
People, Materials, Stock locations, Fleet, Finance, Daily reports, Site Today, Chat,
Drive, Reports and Administration.

| Section | Views/tabs opened and inspected |
| --- | ---: |
| Finance | 22 |
| People | 16 |
| Fleet | 5 |
| Project register | 6 |
| Project detail | 10 |
| Coordination | 6 |
| Materials | 5 |
| QS | 7 |
| Reports | 11 |
| Administration | 12 |
| Total | 100 |

These are UI navigation/render checks, not 100 separate completed business transactions.

## Business flows exercised through the UI

| Flow | Actions and observed result |
| --- | --- |
| Authentication | Empty form validation, password show/hide, wrong-password rejection, successful login, introduction skip and sign-out. Managing Director, Store and HR showed their respective navigation/actions. |
| Fleet renewals | Created QA-MANUAL-001 with Insurance and Revenue licence. Reopened the record and confirmed both compliance rows and renewal history survived. |
| Optional fuel | Saved LKR 5,000 fuel with no float, no litres and no project; odometer 10. Detail and monthly fuel ledger showed the saved record and unknown litres as a dash. |
| Maintenance | Added an enabled 5,000 km reminder. Logged zero-cost equipment service while leaving status unchanged; service history appeared and Available status remained. |
| Equipment QR | Issued a label and reopened it. Corrected URL now uses the configured online origin, not `siteops://app`. Phone scanning was not tested. |
| Invoice/client | Created a client inline with an address. The invoice title/manual line remained. Changing client through the ordinary selector clears lines by current design; re-entered them. Saved an anonymous invoice with 2.5 Barrels × 1,000 = 2,500, VAT 450, total 2,950. Record remained after app restart. |
| Invoice PDF | Actual PDF rendered dotted purchaser/TIN fields, unit/quantity/rate, total and payment mode. Zoom, fit and rotation worked. Saved PDF into the isolated QA folder. Native print dialog opened; no printer was selected, so printing was cancelled. Existing user downloads were not overwritten. |
| Company address | Saved a synthetic company address through Administration. A later quotation PDF printed that saved address. |
| Quotation | Created 12.5 Litres × 100 = 1,250; 10% markup and 18% VAT yielded 1,622.50. Actual PDF showed the saved address and line. Finalized to Sent, then Accepted. |
| Special HR input | Saved Work role effective 2026-01-01 for a seeded test employee, then a Bass daily record with mandatory reason. Rows persisted. This did not configure a live employee. |
| Scanner identity | Uploaded synthetic CSV, manually linked QA-SCANNER-001 / QA Fingerprint Alias, imported one day. Next file changed the scanner number to QA-SCANNER-002 with the same alias: automatically matched, zero unmatched, then imported one day. |
| Office task | Created without a project, assigned employee, posted a comment, progressed Not started → In progress → Completed → Approved. History retained each transition. |
| Project | Created with saved client, manager, site and in-app reminder. Inspected all detail sections. Reversibly deleted, opened Deleted projects, recovered, verified return to active list. |
| Supplier/credit purchase | Added a synthetic supplier. Saved QA-MANUAL-CREDIT-001 for 1,000 with reminder recipient. Outstanding balance and local reminder appeared. No external supplier payment was made. |
| Expense | Saved an unpaid LKR 125 expense with Uncategorised selected. Ledger showed it once and identified payment details as not recorded. |
| Stock | Store role created material with opening stock 10; receipt 5 without project saved and stock became 15. |
| Drive | Created folder, cancelled another folder request without creating it, uploaded a synthetic PDF privately, opened native download dialog. Created a public link only for this synthetic local file, checked its online origin, then revoked it. No external message was sent. |
| Standard payroll | HR created QA-EMP-001, daily rate 3,000, Daily frequency, no EPF/ETF; recorded 07:30–16:30 office attendance on Nov 3. Nov 1–3 Daily Draft contained exactly one employee, gross/net 3,000, no OT/deductions. |
| Saved payroll/export | Downloaded salary XLSX; archive valid and contained QA-EMP-001 and 3000. Two-page payslip PDF showed saved attendance/basic/net. Regenerated Draft: total stayed 3,000. Approved then marked Paid in disposable data; recalculation/delete controls disappeared. Rebuilding the same Paid period was rejected as locked; original Paid run remained. No bank transfer occurred. |
| Browser parity | Browser login saw the employee and Paid LKR 3,000 run created through Electron. Responsive menu navigation worked. Saved a named financial report view using the new in-app prompt. |

## Entry dialogs inspected and cancelled

In addition to the submitted flows above, opened and inspected: Income, operating bill,
supplier invoice, petty cash account, credit card, VAT clearance, bank bond, expense
category; previously shortlisted candidate, applicant/CV batch, insurance policy,
performance review, department, leave, overtime, travel/allowance claim and one-time
salary deduction. Their fields/cancel controls were available. **Successful persistence
and every conditional branch of these dialogs were not established by merely opening
them.** API tests provide separate coverage; do not combine these into a manual pass.

## Issues corrected during this pass

1. Wrong login credentials incorrectly displayed session-expiry wording. Login now
   retains the server's incorrect-credentials message; authenticated 401s retain expiry wording.
2. Fuel's empty Not project-specific selection was incorrectly required and blocked
   the no-float/no-litres flow. Corrected and manually saved/reopened.
3. Desktop PDF previews were blank; the earlier custom-protocol PDF flow also produced
   an Electron SIGTRAP. PDF support is enabled, and document windows now navigate to a
   ticket URL on the configured network origin. No session token is put in the URL.
   Actual invoice, quotation and payslip PDFs rendered after this correction.
4. Uncategorised expenses were incorrectly blocked by required-select validation.
5. Equipment maintenance's Leave unchanged selection was incorrectly required.
6. QR labels/Drive links used the desktop asset origin. They now resolve the configured
   online origin; no QR is rendered until that origin is available.
7. Electron's unsupported `window.prompt` left New folder inactive. Replaced all eight
   prompt calls across Drive, Gallery, finance/reporting, purchasing and QS with one
   async in-app text dialog. Name/reason text remains subject to existing validation.
   Cancel now also stops a subcontractor quotation decision rather than submitting it.

## Open findings and exclusions

- Earlier Node 20/22 runs had 322 passes, seven counted failures and two skips.
  After reconciling stale expectations against the agreed rules and isolating the
  transport rollback fixture, the full Node 20 run passes **330, fails 0, skips 2**
  (332 including nested tests). This includes an added manual-amount regression.
  No payroll calculation/runtime code changed. Node 22 was not rerun in this follow-up.
- A project-less accepted quotation displays a misleading notification saying its
  project budget changed. The quotation had no linked project. Wording remains open.
- The standard payroll UI scenario used local seeded policy; it is not proof that the
  agreed dated 2026 policy has been configured in production. See PAYROLL.md.
- No exhaustive per-role/per-row authorization audit, every form mutation, every
  invalid-input combination, operator monthly/25-day/manual OT scenario or all document
  variants was performed through the UI. Existing focused automated tests are separate.
- Password/credential changes, granting real access, external WhatsApp/SMS/email sends,
  provider credentials, live object storage, physical printers, microphone/camera,
  actual fingerprint hardware, Windows runtime, low-spec hardware and prolonged/proxy
  outages were not manually verified. No OS warning was bypassed.
- Native Chromium PDF accessibility reported unavailable text-extraction model files
  while the actual text/page content rendered. Assistive-technology behavior needs
  separate device testing.

## Reproduce safely

Use a local-only MySQL configuration and Node 22.12+:

```sh
npm run desktop:prepare
node desktop/scripts/manual-qa.cjs
```

The helper rejects non-loopback MySQL hosts, creates a new uniquely named database,
uses local uploads, disables notification credentials, runs backend port 43974 and
launches an unpackaged Electron client with an isolated profile. Stop it with Ctrl+C
to remove only its newly created database/temp folder. Close any separately launched
QA client first. Never use production data/credentials for destructive manual tests.
Do not run a second instance on that fixed port.

## Final verification and cleanup

Final frontend tests: **38 passed**. Desktop checks: 3 core tests plus transport,
actual-backend/reconnect and packaged-Mac smoke tests passed. Both installers were
rebuilt after fixes. Their bundled runtime/UI matched source and contained no backend,
.env or QA fixtures. SHA256SUMS accompanies the installer files.

Prompt response focus and Escape cancellation were checked in the browser. The manual
browser session and desktop client were closed; both databases created by the manual
QA runs were removed. Synthetic downloaded evidence remains locally in ignored
`desktop/test-results/manual-invoice.pdf` and `manual-payroll.xlsx`. The reproducible
launcher additionally rejects an occupied wildcard/IPv6 port before creating data and
waits for its own child server's ready message, rather than trusting another server's
health reply.
