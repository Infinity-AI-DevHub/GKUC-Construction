# Multi-employee payroll allowance claims

People > Payroll Inputs > Add travel / allowance claim offers One employee or
Multiple employees. Multiple mode requires at least two distinct people (maximum
200). Shared date, type, destination, evidence and inputs apply to every selection.
An entered amount is per employee, not a total to split. Calculated allowances
use each person's eligibility, category and dated company policy separately.

POST /payroll/inputs/batch previews and saves with the same validation/calculation
helper as single claims. Employees must belong to the same payroll company.
Every claim must be valid and free of an existing same-person/date/type record.
One transaction saves all claims or none. Employee locks are taken in ID order;
the existing unique claim key also protects concurrent duplicate submissions.

Each employee receives an individual Draft claim and individual CREATE audit.
Existing confirmation, final approval and one-time payroll consumption remain
unchanged. Batch entry does not approve claims or split an allowance across people.
Salary deductions remain individual. No schema change is needed.
