# Employee Account Links

Updated 2026-10-25.

Administration > Users > Employee link and People > Employee profile > User account link manage existing accounts and HR profiles. Both require `admin.users` permission. Account roles remain managed through Access control.

Select a profile/account and give a reason. Selecting no link removes the connection only. Relinking preserves accounts, employee records, attendance, payroll, salary settings and history. A profile occupied by another account must be explicitly unlinked first. Hidden or inactive profiles cannot receive a new link.

The server serializes account-link changes, checks the expected previous profiles, rejects stale edits, and protects accounts with greater administrative authority. All changes record previous and new employee identities and the reason in the audit trail. Existing duplicate links can be reduced to one through this control without deleting profiles.

Deployment requires updated backend and frontend. No database migration or production data cleanup is required.
