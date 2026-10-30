# Fleet maintenance reminders and office tasks

## Vehicles without drivers

Fleet → Add asset allows **Unassigned** as the driver and **Yard** as the site. No dummy
employee or driver-history row is created. A real driver can be assigned later using
Change driver. Existing driver names and history are preserved. Startup also makes the
legacy fleet.driver column nullable if an older database still requires a value.

## Maintenance

Fleet → Maintenance lists separate reminders for each vehicle and work item. New assets
can optionally apply either of GKUC's editable presets:

| Preset | Engine oil | Brake oil |
| --- | --- | --- |
| Japanese | Every 5,000 km | Every 20,000 km |
| European | Every 15,000 km | Every 20,000 km |

These are user-supplied business defaults, not inferred from the model or manufacturer.
Enter each actual last-change odometer when applying a preset. No schedules are
retrospectively inferred for existing vehicles. Use **Add reminder** for an existing
vehicle or a custom work item, and **Edit reminder** to adjust or pause one.

Each reminder has its own interval, last-completed odometer, optional last-completed
date and advance warning distance (default 500 km). Next due = last-completed reading +
interval. Reminder distance must be less than the interval; last-completed readings
cannot exceed the vehicle's current odometer. Inactive vehicles and paused reminders
do not trigger new alerts. Reminder notifications use the existing Transport management
notification audience and configured channels, during the normal alert scan.

Maintain current odometer readings using fuel records, Odometer, or a work log. The system
has no live mileage feed. At the exact due reading the reminder says Due now; past that
reading it is overdue. The vehicle record and Maintenance tab show the current status.

Use **Log work** or the vehicle's **Service or repair** action and tick the maintenance
items actually completed. Only those reminders restart, from that work's odometer and
date. The completion selections are stored with the work record; the normal maintenance
history, company cost allocation, odometer history and audit trail remain in effect.
An unrelated repair does not reset an oil reminder. Existing general service schedules
remain supported independently; leave their distance at zero when individual reminders
are sufficient and a general service reminder is unnecessary.

The new vehicle_maintenance_schedules table stores the independent reminders, and
vehicle_maintenance.completed_schedules stores completion snapshots. Completion,
maintenance costs, mileage and reminder resets are saved in one transaction.

## Office tasks

Tasks → Create task now offers **Office / general — no project**. Select the responsible
employees as usual; the task belongs to the operating company selected in the workspace.
Office tasks support the same deadlines, comments, files, targeted reminders, status
changes and management approval as project work. The Tasks filter includes Office /
general, and the workspace keeps office tasks under the selected company.

The tasks.project_id column is nullable and tasks.company_id stores an office task's
company. For project tasks, the project's company remains authoritative. List/detail,
bootstrap, notifications, employee work history, offboarding checks and task analytics
include office tasks. Archived project tasks remain excluded from operational task
lists and reminders. No placeholder project is created and existing task links are kept.

## Deployment and verification

Deploy backend and frontend changes together, rebuild the frontend, and restart the
backend. Startup applies the schema additions idempotently without deleting history.
Tests cover driverless registration, independent reminders and completions, due and
warning boundaries, paused/inactive reminders, existing generic service resets,
project-task reminders, and office-task creation, company filtering, comments, reminders
and approval. Form render checks verify that driver and project are no longer required.

### Maintenance entry from Finance

Finance → Vehicle expenses now offers **Record maintenance** to users with transport management permission. Choose a shared vehicle, then record its service, repair or inspection using the existing Fleet form. The selected operating company owns the cost; a project is optional and must belong to that company. Vehicle readings and selected maintenance reminders use the same validated save operation as Fleet. The monthly report refreshes after saving and when records change; work outside the reporting month appears in its own month. Read-only Finance access does not grant permission to create maintenance records.

### Machine specifications can be completed later

Fleet asset creation and its detail view support optional make, model, model year, engine code and manufacturer/manual notes. Fleet → Vehicles → select asset → Edit machine details can populate, correct or clear these fields later. Unknown specifications remain blank and saving them never creates service intervals or changes odometer history. New manually created reminders start paused; users enable them after verifying the interval. Existing reminders retain their state. These specification fields do not add hour-meter scheduling or inspection/defect approvals; those remain separate work.
