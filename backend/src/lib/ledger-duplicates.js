// Manual entries from Finance and QS share one ledger. Lock the project so two
// simultaneous submissions cannot both pass the duplicate check.
export async function assertUniqueManualEntry(connection, table, entry) {
  if (!['expenses', 'incomes'].includes(table)) throw new Error('Unsupported ledger');
  const [[project]] = await connection.execute('SELECT id FROM projects WHERE id=? FOR UPDATE', [entry.projectId]);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  const dateColumn = table === 'expenses' ? 'expense_date' : 'received_date';
  const reference = entry.reference?.trim();
  const [rows] = reference
    ? await connection.execute(`SELECT id FROM ${table} WHERE project_id=? AND reference=? AND amount=? LIMIT 1`,
      [entry.projectId, reference, entry.amount])
    : await connection.execute(`SELECT id FROM ${table} WHERE project_id=? AND ${dateColumn}=? AND description=? AND amount=? LIMIT 1`,
      [entry.projectId, entry.date, entry.description, entry.amount]);
  if (rows.length) throw Object.assign(new Error(`Possible duplicate ${table === 'expenses' ? 'cost' : 'income'}: use the existing entry or a distinct reference`), { status: 409 });
}
