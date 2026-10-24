# Navigation Access and Priority

Updated 2026-10-24.

The server's effective permission list controls module visibility. Dashboard is the
shared starting point. A role or department name never grants access. The top bar,
More menu and mobile sidebar all receive the same filtered and ordered list.

The linked employee's department selects the primary permitted workspace, followed
by the role name when no permitted department match exists. Finance puts Finance
second; HR puts People second; QS puts Quantity Surveying second; Transport puts
Fleet second; Stores puts Materials second. Site and coordination roles have their
corresponding priority. Custom roles fall back to effective module capabilities;
write/workflow grants rank above view-only grants, with stable ordering for ties.

Reports is shown only when an analytics report is permitted and its internal report
tabs follow those same permissions. Administration no longer appears solely because
someone has QS or project-management permissions. Personal notification/account deep
links remain available independently of the Administration navigation item.

Permission changes rebuild the menu and unauthorized module deep links fall back to
Dashboard. API authorization remains authoritative and is not broadened by this UI.
Department metadata comes from the user's linked, visible employee record; it is
not inferred from their editable display name. No schema migration is required.
