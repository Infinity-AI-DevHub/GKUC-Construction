# Financial statements

Open Finance → Financial reports → Statement of Financial Position or Income Statement.
Select the operating company and reporting month. Reference-style green financial-position
and teal income-statement headers, indented accounts, right-aligned LKR amounts,
parenthesized negatives and ruled subtotal/grand-total rows follow the supplied examples.
Export statement downloads a CSV including the reporting basis and limitations.

These views read saved records; they do not create postings or change payroll, policy,
payments or closed management snapshots. They currently provide **partial internal
management statements**, not complete statutory accounts.

Income is issued non-advance invoiced work before VAT plus the selected month's saved
management revenue adjustments. Client receipts are not counted again. Direct costs
are project expenses with Material, Labour, Fuel, Equipment or Subcontractor source;
other project expenses and net operating bills form operating expenses, with saved cost
adjustments. Expenses linked to operating bills are omitted to avoid double counting.
Supplier invoices/POs are not added as a second cost. Operating result reconciles to
the existing monthly management pack. Classification is operational, not an accountant's
approved chart of accounts. Unbilled WIP is excluded from recognised revenue/assets.

Position uses recorded client receivables, supplier payables and unpaid operating bills
through month end, excluding later payments. Selected-month receivable/payable management
adjustments are included under the existing pack convention, not accumulated over history.

The current source model does not provide complete cash/bank opening balances, inventory
valuation, fixed-asset/depreciation registers, capital/retained earnings, loans, all
accruals or separately classified interest/tax/non-operating entries. Those rows display
Not recorded, never assumed zero. Totals depending on unknown rows and final net profit
are withheld. Known trade/bill payables are labelled separately from total liabilities;
equity is never plugged to force balance. Complete statements require a separately agreed
accounting data-entry/mapping and opening-balance workflow. Existing cash-comparison
verification is not assumed to be a complete consolidated bank balance.

The new views are live calculations and do not represent a saved closed month. Use
Management accounts for audited adjustments and versioned closes. No production data
is automatically populated. Tests cover signed results, bill deduplication, unknown
balances, month-end dates, authenticated API validation, company isolation and consistency
with the existing management pack. Browser fixture checks cover both layouts on desktop
and mobile plus CSV download; these are separate from real API integration checks.
