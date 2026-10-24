# One-time salary deductions

People > Payroll Inputs > Add salary deduction records an employee, deduction
date, positive amount, supporting source and reason. The existing hr.payroll
permission and Draft > Confirmed > Approved review process apply, including
independent approval when configured. Allowance eligibility is not required.

An additive enum migration adds Salary deduction to hr_payroll_claims.kind.
There is one deduction record per employee/date, following the existing unique
claim constraint; combine same-day deductions and explain the items in the reason.
All creation and review actions are audited.

Only approved, unconsumed claims dated within a payroll period are included as
Deduction payslip components. They reduce net pay and appear in Other deductions;
they are not allowances, recurring components or project costs. The existing
unique payslip claim link prevents duplicate consumption. Rebuilding a draft
releases and reuses its inputs exactly once. Later periods do not repeat them.
Draft/confirmed/rejected deductions do not affect pay. Payroll generation is
blocked if including a one-time deduction makes deductions exceed available pay;
no amount is silently discarded by the existing zero-net-pay floor.

Deploy backend schema initialization and frontend together. Existing production
records are preserved; development did not change production data.
