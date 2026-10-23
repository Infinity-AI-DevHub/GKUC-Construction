/** Replace the legacy name-based key without deleting or reassigning attendance. */
export async function migrateAttendanceIdentity(query) {
  const indexes = await query(`SELECT INDEX_NAME indexName,COLUMN_NAME columnName,
    SEQ_IN_INDEX position,NON_UNIQUE nonUnique FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='attendance' ORDER BY INDEX_NAME,SEQ_IN_INDEX`);
  const grouped = new Map();
  for (const row of indexes) {
    if (!grouped.has(row.indexName)) grouped.set(row.indexName, { columns: [], unique: !Number(row.nonUnique) });
    grouped.get(row.indexName).columns.push(row.columnName);
  }
  const matches = (index, columns) => index.columns.join(',') === columns.join(',');
  const hasIdentity = [...grouped.values()].some(index => index.unique && matches(index, ['employee_id', 'work_date']));
  const legacyKeys = [...grouped].filter(([, index]) => index.unique && matches(index, ['employee_name', 'work_date']));
  if (hasIdentity && !legacyKeys.length) return;
  const changes = [];
  if (!hasIdentity) {
    const duplicates = await query(`SELECT employee_id,work_date,COUNT(*) count FROM attendance
      WHERE employee_id IS NOT NULL GROUP BY employee_id,work_date HAVING COUNT(*)>1 LIMIT 5`);
    if (duplicates.length) {
      throw new Error(`Attendance identity migration needs review: duplicate employee/date records exist (${duplicates
        .map(row => `employee ${row.employee_id} on ${row.work_date}`).join('; ')}). No attendance has been deleted.`);
    }
    changes.push('ADD UNIQUE KEY uq_attendance_employee_day (employee_id,work_date)');
  }
  if (![...grouped.values()].some(index => !index.unique && matches(index, ['employee_name', 'work_date']))) {
    changes.push('ADD INDEX idx_attendance_name_day (employee_name,work_date)');
  }
  for (const [name] of legacyKeys) changes.push(`DROP INDEX \`${name.replaceAll('`', '``')}\``);
  // One ALTER leaves the original constraint intact if installing the new key fails.
  await query(`ALTER TABLE attendance ${changes.join(', ')}`);
}
