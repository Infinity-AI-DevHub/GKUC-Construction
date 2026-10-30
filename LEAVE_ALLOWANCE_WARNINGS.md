# Leave allowances are advisory

Annual/other and casual entitlements and the monthly policy threshold now generate warnings instead of rejecting leave creation. Requests can exceed 14 annual days or any configured threshold. Saving and approval are allowed; payment type remains the explicit Paid/Unpaid choice and is not automatically changed for excess days.

Warnings show the affected year/month, annual excess and negative remaining balance where applicable. They are returned at save time, displayed as a warning notice and persisted on the leave register as a snapshot at creation. Pending and approved requests reserve allowance; rejected requests do not. Cross-month and cross-year requests are accepted and split by actual calendar days for the advisory calculation. Existing type grouping is preserved: Casual has its own annual allowance and all other types share the annual/other allowance; both paid and unpaid requests count.

Duplicate overlapping dates, invalid date order, missing employee/policy/start date and the paid-leave waiting period remain independent validation rules. This change does not bypass those checks or recalculate saved payroll. The idempotent startup migration adds `leave_requests.limit_warnings`; existing requests remain valid without historical warning snapshots.
