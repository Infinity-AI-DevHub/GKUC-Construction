export const legacyOtEmployeesSql = `SELECT id,code,name,payroll_company_id,payroll_category,
  overtime_rate,custom_office_ot_rate,custom_site_ot_rate,custom_travel_ot_rate
  FROM employees WHERE overtime_rate<>0 OR custom_office_ot_rate IS NOT NULL
  OR custom_site_ot_rate IS NOT NULL OR custom_travel_ot_rate IS NOT NULL`;

// Keep the original values independently of employee lifecycle and payroll snapshots.
export async function migrateEmployeeOtRates({query, transaction}) {
  await query(`CREATE TABLE IF NOT EXISTS employee_ot_rate_archive (
    employee_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    original_values JSON NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  return transaction(async connection => {
    const [employees] = await connection.query(`${legacyOtEmployeesSql} ORDER BY id FOR UPDATE`);
    for (const employee of employees) {
      await connection.execute(`INSERT INTO employee_ot_rate_archive(employee_id,original_values)
        VALUES (?,?) ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id)`, [employee.id, JSON.stringify(employee)]);
      await connection.execute(`UPDATE employees SET overtime_rate=0,custom_office_ot_rate=NULL,
        custom_site_ot_rate=NULL,custom_travel_ot_rate=NULL WHERE id=?`, [employee.id]);
      await connection.execute(`INSERT INTO audit_logs(action,entity,entity_id,before_json,after_json)
        VALUES ('MIGRATE','employee_ot_rates',?,?,?)`, [String(employee.id), JSON.stringify(employee),
        JSON.stringify({source:'Payroll settings',archive:'employee_ot_rate_archive'})]);
    }
    return {archivedEmployees:employees.length};
  });
}
