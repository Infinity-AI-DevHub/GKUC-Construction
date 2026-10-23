/** Read models hide deactivated employees while retaining the original financial and HR rows. */
export const EMPLOYEE_READ_TABLES = [
  'employees', 'attendance', 'employee_letters', 'employee_asset_handovers',
  'employee_conduct_records', 'employee_bank_accounts', 'employee_pay_components',
  'leave_requests', 'overtime_records', 'employee_documents', 'performance_reviews',
  'employee_biometric_ids', 'employee_work_locations', 'employee_offboarding_cases',
  'site_attendance_submissions', 'hr_payroll_claims', 'hr_insurance',
  'project_team', 'project_manager_assignments', 'task_assignees',
  'equipment_assignments', 'vehicle_driver_assignments'
];

export async function createEmployeeReadViews(query) {
  await query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW visible_employees AS
    SELECT * FROM employees WHERE deactivated_at IS NULL`);
  for (const table of EMPLOYEE_READ_TABLES.filter(name => name !== 'employees')) {
    const nameColumn = { attendance: 'employee_name', equipment_assignments: 'assigned_to', vehicle_driver_assignments: 'driver_name' }[table];
    const legacyName = nameColumn ? ` OR (r.employee_id IS NULL AND e.name=r.${nameColumn})` : '';
    await query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW visible_${table} AS
      SELECT r.* FROM ${table} r WHERE NOT EXISTS (
        SELECT 1 FROM employees e WHERE e.deactivated_at IS NOT NULL
          AND (e.id=r.employee_id${legacyName})
      )`);
  }
  await query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW visible_attachments AS
    SELECT a.* FROM attachments a
    WHERE (a.owner_type<>'employee' OR EXISTS (SELECT 1 FROM visible_employees e WHERE e.id=a.owner_id))
      AND (a.owner_type<>'attendance' OR EXISTS (SELECT 1 FROM visible_attendance r WHERE r.id=a.owner_id))
      AND (a.owner_type<>'claim' OR EXISTS (SELECT 1 FROM visible_hr_payroll_claims r WHERE r.id=a.owner_id))
      AND (a.owner_type<>'handover' OR EXISTS (SELECT 1 FROM visible_employee_asset_handovers r WHERE r.id=a.owner_id))`);
}
