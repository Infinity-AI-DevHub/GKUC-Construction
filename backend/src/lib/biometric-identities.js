const codeKey = value => String(value ?? '').trim().toLowerCase();
const nameKey = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const eligible = mapping => !mapping.deactivatedAt && mapping.status !== 'Left';

/** Only HR-approved scanner identities match; never guess from the profile display name. */
export function resolveScannerRows(rows, mappings) {
  const byCode = new Map(mappings.map(mapping => [codeKey(mapping.code), mapping]));
  const byName = new Map();
  const fileCodes = new Map();
  for (const mapping of mappings) {
    const key = nameKey(mapping.scannerName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, new Map());
    // Include hidden/left owners in ambiguity checks without returning their identity.
    byName.get(key).set(Number(mapping.id), mapping);
  }
  for (const row of rows) {
    const key = nameKey(row.name);
    if (!fileCodes.has(key)) fileCodes.set(key, new Set());
    fileCodes.get(key).add(codeKey(row.code));
  }
  return rows.filter(row => !byCode.get(codeKey(row.code))?.deactivatedAt).map(row => {
    const codeMatch = byCode.get(codeKey(row.code));
    const owners = byName.get(nameKey(row.name));
    let match = null;
    if (codeMatch) {
      // A saved name belonging only to someone else conflicts with the saved number.
      if (eligible(codeMatch) && (!owners || owners.has(Number(codeMatch.id)))) match = codeMatch;
    } else if (owners?.size === 1 && fileCodes.get(nameKey(row.name))?.size === 1) {
      const candidate = owners.values().next().value;
      if (eligible(candidate)) match = candidate;
    }
    return { ...row, employeeId: match?.id || null, employee: match?.name || null };
  });
}
