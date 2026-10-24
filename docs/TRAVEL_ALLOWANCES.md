# Travel allowance entry methods

People > Payroll Inputs > Add travel / allowance claim > Travel now offers:

- Calculate from payroll rules: existing destination, times, travel OT and distance calculation.
- Enter amount manually: positive fixed allowance, optional destination, required reason/source.

Manual amounts are approved exceptions, not distance-derived benefits; they do
not require long-distance eligibility or change payroll policy rates. They create
zero travel OT and no travel interval. HR must confirm and approve either method
under existing permissions and independent-approval rules before payroll uses it.
Existing calculated claims remain unchanged. The one-Travel-claim-per-person/date
constraint prevents recording both methods for the same day as two allowances.
Manual and calculated allowances use the existing claim-consumption protection,
so draft recalculation does not duplicate them and future periods do not repeat them.

The saved claim detail includes the method, amount, source and reason. Payroll
identifies the component as Manual travel allowance and retains calculation metadata.
No schema migration is needed for this change. No production data was modified.
