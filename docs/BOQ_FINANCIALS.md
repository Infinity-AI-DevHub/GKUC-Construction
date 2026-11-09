# BOQ taxes and deductions

Create BOQ includes **Taxes, additions and deductions**. Add any label, choose Add or
Deduct, then Percent or Amount. No tax rate is assumed. Fixed amounts are in LKR;
all percentage rates apply independently to the work-item subtotal, not to a running
subtotal after other taxes. Each adjustment is rounded to cents, then added/deducted
once. The final total must be nonnegative and fit the existing BOQ currency capacity.

Example: work subtotal 1,000 + VAT 18% (180) - retention 5% (50) - fixed discount 30
= 1,100. This is pricing only: it does not create a VAT entry, supplier/client payment,
QS retention record or other financial posting. Normal BOQ approval still uses the
saved final BOQ total when calculating the project budget. Quotations/invoices retain
their own tax rules; BOQ adjustment rows are not automatically posted a second time.

## Saved values and changes

A guarded nullable `boqs.financial_adjustments` JSON column preserves labels, direction,
mode, entered value and optional source reference. Legacy/null records behave exactly
like an empty adjustment list. `boq-financials.js` is the server calculation authority.
BOQ detail and generated document show the work subtotal and calculated breakdown;
amount in words uses the adjusted total. Adding work items and approved item-change
requests recalculate existing adjustments instead of replacing the total with line sums.
Approved BOQs retain their existing direct-edit lock; this change never backfills tax
rates or recalculates existing approved records automatically.

## Upload and review

Normal BOQ `.xlsx` uploads scan all readable sheets for common financial labels and
structured Label / Direction / Mode / Value rows and explicit financial column headers
such as VAT_PERCENT or Deduction amount. The downloadable template includes
an optional Adjustments sheet for those structured rows. Common English labels include
VAT, SVAT, SSCL, NBT, WHT/withholding tax, tax/income tax, deduction, discount, retention,
advance recovery, cess, levy and stamp duty. Readable PDF text and the existing OCR
fallback also produce proposals from labelled financial lines. Source sheet/text-line
references and extracted values are displayed beside each proposal.

Imported taxes/deductions are **proposals, not approved calculations**. Check the label,
sign, mode, numeric value, percentage base and source amount. Remove repeated summaries
or rates repeated on several sheets. Excel percentage formatting is not inferred from
cell style: a stored fraction such as 0.18 must be corrected to 18 when that is what the
source intends. Compound taxes, different tax bases and per-item tax schedules need
review/consolidation into the supported subtotal rates or fixed amounts; they are not
guessed. Unknown labels can be entered manually. Maximum 50 saved adjustments per BOQ; files
with more candidates must have repeated/per-item summaries consolidated first.

Detected financial-summary lines matching priced descriptions are initially excluded
from priced work to prevent double counting. Original rows/file and checksum remain
available; if a proposal is actually a work item, remove the proposal and explicitly
include/correct the work row. Save the confirmation using **Save tax / deduction review**
before Approve and create. The server blocks unreviewed proposals and repeated commit.
Unconfirmed proposals do not alter saved staging totals. Included-row corrections
recalculate reviewed totals; a negative result resets financial review before commit.

The flexible single-document BOQ path in Import Centre uses the same proposals/editor
and saves the same BOQ JSON after review. Linked historical multi-BOQ templates keep
their separate declared-total/source-key validation contract; automatic allocation of
an unlinked tax/summary sheet among several BOQs is not implemented. Linked uploads
with recognised financial rows/columns are rejected with a direction to individual
BOQ review instead of silently ignoring those amounts. Use an individual
BOQ upload/review where the adjustment's bill identity would otherwise be ambiguous.

No production import, rate assignment or deployment is implied by this implementation.
