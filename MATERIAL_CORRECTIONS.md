# Editing materials and stock movements

Materials → Stock now has **Edit material** for users with store.manage. Name, unit label,
store, minimum level, category, purchasing route and future issue cost are editable after
stock has been added. Changing the current store quantity records the difference as an
additional Receipt (increase) or Adjustment (decrease), with a correction reason and audit
entry. The editor checks the stock value loaded by the form, so a new movement cannot be
silently overwritten by an old open form. Consumable/Returnable type changes are blocked
once stock movements, loans or site consumption exist. Unit changes relabel quantities;
they do not convert bags to tonnes or recalculate stored quantities.

Materials → Movements has **Edit movement** for manually recorded entries. Quantity,
type, project, destination, reference and notes can be corrected; material identity,
original author and creation timestamp are retained. A reason is required. Corrections
lock the material and movement in a transaction, replay store balances in movement order,
check unused site balances, and update the linked automatic issue expense once. New issue
movements store their original unit cost. Legacy issue rates are recovered from their
linked expense where possible. Later material-price edits do not reprice previous issues.

A correction cannot create negative stock at an earlier point in history, even if a later
receipt would make the current balance positive. It also cannot reverse material already
consumed or returned from a site. A later verified site count protects the earlier issue's
quantity/site; use a subsequent adjustment rather than rewrite the history behind that
verified count. Reference and note corrections remain possible.

Purchase-order receipts, tool handovers/returns and approved daily-cost movements retain
their source quantities. Their **Edit notes** action corrects movement notes with a reason;
it cannot independently change quantity, type, project or reference. This editor does not
implement corrections to purchase receipt allocations, loan balances or approved cost
sheets. Those quantities require a coordinated source correction rather than a stock-only
rewrite. Direct transfers likewise retain their linked quantities. These restrictions are
shown in the editor and enforced by the server, not just hidden in the interface.

Startup adds stock_movements.origin_type and unit_cost_snapshot. Existing rows are
classified conservatively using loan notes, daily-cost references, purchase-order receipt
references and transfer type; new entries are tagged explicitly by their originating
workflow. Material and movement corrections preserve their original IDs and record before,
after, reason and editor in the audit log. Existing site counts and purchase/loan records
are not rewritten by this migration.

Deploy backend and frontend together, rebuild the frontend and restart the backend before
using these controls so the new movement columns exist. Tests exercise material edits,
stock count corrections, movement replay, automatic issue costs, stale edits, consumed
stock and protected linked movements, alongside normal purchasing and stock issue flows.
