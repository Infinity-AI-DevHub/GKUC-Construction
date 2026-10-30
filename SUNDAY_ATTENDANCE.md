# Manual Sunday attendance

The local attendance API has no Sunday-only rejection rule. The daily view previously opened its page-level entry form at today's date even when viewing another date. The selected date now feeds both the page-level Record attendance form and a new Record attendance for [date] action within the daily view. Sundays and holidays remain selectable; attendance refreshes after changes and the table title identifies the viewed date.

Existing employee/date records still require the audited correction action rather than duplicate entry. No payroll premium or Sunday multiplier is invented: recorded Sunday work follows the configured daily rate, normal hours and OT policy. Sunday remains excluded from the ordinary scheduled-workday attendance-percentage denominator; that reporting convention does not exclude recorded Sunday work from salary calculation.

Regression verification covers Sunday single and bulk entry, duplicate protection and salary generation for the recorded Sunday, plus a browser check that selecting Sunday opens the form on that same date. No server migration is required for the date-selection change.
